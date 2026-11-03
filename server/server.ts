import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runAgent } from '../src/shell/commands/agent'
import { sessionId, loadSession } from '../src/shell/commands/agent-sessions'
import { buildRunContext, isValidThreadId, noteThreadId, resolveCwd, resolveSessionForThread, resolveThreadForResume, threadVfsPath, type RunContext } from './bindings'
import { ensureAgentConfig } from './bootstrap'
import { createDiskVfs } from './disk-vfs'
import { loadTokens } from './auth'
import { createRateLimiter } from './ratelimit'
import { withGateway, type GatewayContext } from './gateway'
import { cancelJob, listJobs, scheduleJob } from './jobs'
import { createTelegramApi, deliverDueReminders, loadTelegramConfig, startTelegramPoller } from './telegram'
import { lastAssistantText } from '../src/shell/commands/agent-sessions'
import { startJobTicker } from './ticker'
import { createThreadRouter } from './threads'
import { findInterruptedThreads, resumePromptFor } from './resume'
import { LocalDirStore, S3StoreFromEnv, defaultSnapshotsDir, pushSnapshot, type SnapshotStore } from './snapshots'

const MAX_BODY_BYTES = 4 * 1024 * 1024

const port = Number(process.env.CELL_PORT || '8787') || 8787
const root = process.env.CELL_WORKSPACE || './cell-workspace'
const timeoutMs = Number(process.env.CELL_TIMEOUT_MS || '600000') || 600000
const jobsIntervalMs = Number(process.env.CELL_JOBS_INTERVAL_MS || '30000') || 30000

try {
  ensureAgentConfig(createDiskVfs(root))
} catch (err) {
  process.stderr.write(`cell server: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}

/** One server per workspace: a second process booting on the same root
 * would double-run jobs and resume the same threads (the router and the
 * queue are in-memory + read-modify-write). Fencing-token lock below. */
const lockPath = join(root, '.cell', 'server.lock')
// Pids are meaningless across containers (every server is pid 1 in its own
// pid namespace), so the lock is a fencing token + heartbeat: the holder
// rewrites its token every beat. A boot takes over a lock whose heartbeat
// is frozen (holder dead: kill -9, crash) but WAITS while beats advance —
// a live holder means a second instance, which is refused after 60s. A
// deposed holder that is actually alive notices the token mismatch on its
// next beat and exits instead of running split-brain.
const LOCK_BEAT_MS = 10_000
const LOCK_STALE_MS = 20_000
const LOCK_WAIT_MS = 60_000
const lockToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
let lockOurs = false
function writeLock(): void {
  writeFileSync(lockPath, JSON.stringify({ token: lockToken, heartbeat: Date.now() }))
}
function lockHeartbeat(): number {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { heartbeat?: unknown }
    return typeof holder.heartbeat === 'number' ? holder.heartbeat : 0
  } catch {
    return 0
  }
}
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
try {
  mkdirSync(join(root, '.cell'), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify({ token: lockToken, heartbeat: Date.now() }), { flag: 'wx' })
      lockOurs = true
      break
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
    }
    // lock exists: frozen heartbeat = dead holder, take over; advancing
    // heartbeat = live holder, wait for it to go stale, then refuse
    if (Date.now() - lockHeartbeat() >= LOCK_STALE_MS) {
      process.stderr.write('cell server: taking over a frozen workspace lock (previous holder dead)\n')
      writeLock()
      lockOurs = true
      break
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`cell server: workspace lock is held by a live server — refusing second instance on ${root} (waited 60s)\n`)
      process.exit(2)
    }
    sleepSync(2000)
  }
} catch (err) {
  process.stderr.write(`cell server: cannot take workspace lock: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}
const lockBeat = setInterval(() => {
  if (!lockOurs) return
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown }
    if (holder.token !== lockToken) {
      // deposed by a successor: stop everything rather than split-brain
      process.stderr.write('cell server: workspace lock taken by a successor — standing down\n')
      releaseLock()
      process.exit(0)
    }
    writeLock()
  } catch {
    // next beat retries; a missed beat only risks a (self-healing) takeover race
  }
}, LOCK_BEAT_MS)
if (typeof (lockBeat as unknown as { unref?: () => void }).unref === 'function') {
  ;(lockBeat as unknown as { unref: () => void }).unref()
}
function releaseLock(): void {
  if (!lockOurs) return
  lockOurs = false
  clearInterval(lockBeat)
  try {
    // only remove our own lock — never a successor's
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown }
    if (holder.token === lockToken) rmSync(lockPath, { force: true })
  } catch {
    // best-effort: a stale lock is reaped by the next boot
  }
}
process.on('SIGTERM', () => {
  releaseLock()
  process.exit(0)
})
process.on('SIGINT', () => {
  releaseLock()
  process.exit(0)
})

let tokens = loadTokensSafe()
const limiter = createRateLimiter({
  max: Number(process.env.CELL_RATE_MAX || '60') || 60,
  windowMs: Number(process.env.CELL_RATE_WINDOW_MS || '60000') || 60000,
})
const usageDir = process.env.CELL_USAGE_DIR || join(root, '.cell', 'usage')
const router = createThreadRouter()

function loadTokensSafe() {
  try {
    return loadTokens()
  } catch (err) {
    process.stderr.write(`cell server: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}

function snapshotStore(): SnapshotStore {
  if (process.env.CELL_S3_BUCKET) return S3StoreFromEnv()
  return LocalDirStore(process.env.CELL_SNAPSHOTS_DIR || defaultSnapshotsDir(root))
}

/** Best-effort step count for the usage log (session file, -1 when unknown). */
function readSteps(vfs: ReturnType<typeof createDiskVfs>, sessionIdValue: string): number {
  try {
    const loaded = loadSession(vfs, sessionIdValue)
    if (!('error' in loaded) && typeof loaded.session.steps === 'number') return loaded.session.steps
  } catch {
    // usage stat only
  }
  return -1
}

function log(method: string, path: string, code: number): void {
  process.stderr.write(`${method} ${path} -> ${code}\n`)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(`${JSON.stringify(body)}\n`)
}

async function readBody(req: IncomingMessage, ctx?: GatewayContext): Promise<string> {
  // the gateway already buffered + validated the body: reuse its bytes
  // instead of concatenating the replayed stream a second time
  if (ctx?.rawBody !== undefined) return ctx.rawBody
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleRun(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  // usage rows for rejected requests carry the HTTP code (steps: 0);
  // -1/-1 means the run started but never reported back
  const reportHttp = (code: number) => ctx.report({ steps: 0, exitCode: code })
  let raw: string
  try {
    raw = await readBody(req, ctx)
  } catch {
    reportHttp(400)
    sendJson(res, 400, { error: 'body too large' })
    log('POST', '/run', 400)
    return
  }
  let body: { prompt?: unknown; resumeId?: unknown; maxSteps?: unknown; cwd?: unknown }
  try {
    body = JSON.parse(raw === '' ? 'null' : raw) as typeof body
  } catch {
    reportHttp(400)
    sendJson(res, 400, { error: 'invalid JSON' })
    log('POST', '/run', 400)
    return
  }
  if (body === null || typeof body !== 'object' || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    reportHttp(400)
    sendJson(res, 400, { error: 'missing prompt: send JSON {"prompt": "..."}' })
    log('POST', '/run', 400)
    return
  }
  if (body.resumeId !== undefined && typeof body.resumeId !== 'string') {
    reportHttp(400)
    sendJson(res, 400, { error: 'resumeId must be a string' })
    log('POST', '/run', 400)
    return
  }
  if (body.maxSteps !== undefined && (typeof body.maxSteps !== 'number' || !(body.maxSteps > 0))) {
    reportHttp(400)
    sendJson(res, 400, { error: 'maxSteps must be a positive number' })
    log('POST', '/run', 400)
    return
  }
  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    reportHttp(400)
    sendJson(res, 400, { error: 'cwd must be a string' })
    log('POST', '/run', 400)
    return
  }

  // each run gets its own capabilities: the resume target's thread dir,
  // or a fresh thread dir for a new session (see server/bindings.ts).
  // Built before the SSE headers so a bad id/cwd still returns a real 400.
  // Hoisted to consts: narrowing on `body` fields does not survive into
  // the router callback closure.
  const prompt: string = body.prompt
  const resumeId: string | undefined = body.resumeId
  const maxSteps: number | undefined = body.maxSteps
  const requestedCwd: string | undefined = body.cwd
  let runCtx: RunContext
  let cwd: string
  let threadId: string
  try {
    threadId = resumeId ? resolveThreadForResume(root, resumeId) : sessionId()
    runCtx = buildRunContext(root, threadId)
    cwd = resolveCwd(runCtx.cwd, requestedCwd ?? null)
  } catch (err) {
    reportHttp(400)
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    log('POST', '/run', 400)
    return
  }
  if (resumeId) {
    // resuming a thread whose dir was deleted would silently restart in
    // an empty dir with all thread files gone — refuse loudly instead
    try {
      if (!createDiskVfs(root).isDir(threadVfsPath(threadId))) {
        reportHttp(410)
        sendJson(res, 410, { error: 'thread workspace is gone (deleted after the session ran)' })
        log('POST', '/run', 410)
        return
      }
    } catch (err) {
      reportHttp(400)
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      log('POST', '/run', 400)
      return
    }
  }

  // one run per thread at a time: a second caller gets 409 before any
  // SSE header is written, so the status code stays meaningful
  const outcome = await router.runExclusive(threadId, async () => {
    const controller = new AbortController()
    let done = false
    // 'close' on the request fires once the body is consumed, not on
    // disconnect — the client-gone signal lives on the response
    res.on('close', () => {
      if (!done) controller.abort()
    })

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (event: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    let runSessionId = ''
    const args = [prompt]
    if (resumeId) args.push('--resume', resumeId)
    // transport-level throws (DNS, refused connection) must still
    // terminate the SSE stream with a done event, not a silent hang
    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      result = await runAgent(
        runCtx.vfs,
        args,
        {
          cwd,
          shell: runCtx.shell,
          jobShell: runCtx.jobShell,
          signal: controller.signal,
          maxSteps: maxSteps ?? Number.POSITIVE_INFINITY,
          onProgress: (line) => send({ type: 'progress', line }),
          onSession: (id) => {
            runSessionId = id
            noteThreadId(runCtx.vfs, id, threadId)
          },
        },
      )
    } catch (err) {
      result = { stdout: '', stderr: `agent failed before producing output: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }
    }
    done = true
    ctx.report({ steps: runSessionId !== '' ? readSteps(runCtx.vfs, runSessionId) : -1, exitCode: result.exitCode })
    // sessionId/threadId let the client resume this exact thread later
    // (schedule a continue-job, or POST /run with resumeId)
    send({ type: 'done', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, sessionId: runSessionId || undefined, threadId })
    res.end()
    log('POST', '/run', result.exitCode)
  }, { timeoutMs })
  if (outcome.status === 'busy') {
    reportHttp(409)
    sendJson(res, 409, { error: 'thread busy' })
    log('POST', '/run', 409)
    return
  }
  if (outcome.status === 'timeout') {
    reportHttp(504)
    sendJson(res, 504, { error: 'thread timed out' })
    log('POST', '/run', 504)
  }
}

function handleJobsList(res: ServerResponse): void {
  try {
    sendJson(res, 200, { jobs: listJobs(createDiskVfs(root)), busy: router.busyIds() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
  log('GET', '/jobs', 200)
}

async function handleJobsCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { threadId?: unknown; prompt?: unknown; runAt?: unknown; kind?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.threadId !== 'string' || !isValidThreadId(body.threadId)) {
    sendJson(res, 400, { error: 'threadId must be a bare session/thread stem' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.prompt !== 'string' || body.prompt === '') {
    sendJson(res, 400, { error: 'prompt must be a non-empty string' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.runAt !== 'number' || !Number.isFinite(body.runAt) || !(body.runAt > 0)) {
    sendJson(res, 400, { error: 'runAt must be finite epoch ms' })
    log('POST', '/jobs', 400)
    return
  }
  if (body.kind !== undefined && body.kind !== 'continue' && body.kind !== 'snapshot') {
    sendJson(res, 400, { error: "kind must be 'continue' or 'snapshot'" })
    log('POST', '/jobs', 400)
    return
  }
  try {
    const job = scheduleJob(createDiskVfs(root), {
      threadId: body.threadId,
      prompt: body.prompt,
      runAt: body.runAt,
      kind: body.kind === 'snapshot' ? 'snapshot' : 'continue',
    })
    sendJson(res, 201, { job })
    log('POST', '/jobs', 201)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    log('POST', '/jobs', 400)
  }
}

function handleJobsDelete(pathname: string, res: ServerResponse): void {
  const id = decodeURIComponent(pathname.slice('/jobs/'.length))
  try {
    if (!cancelJob(createDiskVfs(root), id)) {
      sendJson(res, 404, { error: 'job not found' })
      log('DELETE', pathname, 404)
      return
    }
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    log('DELETE', pathname, 400)
    return
  }
  sendJson(res, 200, { ok: true })
  log('DELETE', pathname, 200)
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') {
    // unauthenticated by design (load-balancer checks); carries no
    // per-thread state — busy threads are visible on authed GET /jobs
    sendJson(res, 200, { ok: true })
    log('GET', '/health', 200)
    return
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    await handleRun(req, res, ctx)
    return
  }
  if (req.method === 'GET' && url.pathname === '/jobs') {
    handleJobsList(res)
    return
  }
  if (req.method === 'POST' && url.pathname === '/jobs') {
    await handleJobsCreate(req, res)
    return
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/jobs/')) {
    handleJobsDelete(url.pathname, res)
    return
  }
  sendJson(res, 404, { error: 'not found' })
  log(req.method ?? '?', url.pathname, 404)
}

/** A fired job runs through the same per-thread capabilities as HTTP runs,
 * serialized by the router: a busy thread skips this tick (throw to retry). */
async function fireJob(job: { id: string; threadId: string; prompt: string; kind: string }): Promise<void> {
  if (job.kind === 'snapshot') {
    // per-thread scope: the snapshot covers this thread's dir plus its
    // session records — never sibling threads or unrelated global state
    const session = resolveSessionForThread(root, job.threadId)
    const scope = [threadVfsPath(job.threadId)]
    if (session !== null) {
      scope.push(`/home/user/.cell/sessions/${session}.json`, `/home/user/.cell/sessions/${session}.thread`)
    }
    const pushed = await pushSnapshot(root, snapshotStore(), job.threadId, { slim: true, scope })
    process.stderr.write(`[job ${job.id}] snapshot ${job.threadId}: ${pushed.skipped ? 'unchanged, skipped' : 'pushed'}\n`)
    return
  }
  // continue jobs resume the thread's session; a thread with no session
  // yet (scheduled before anything ran there) fails loudly, not silently
  const session = resolveSessionForThread(root, job.threadId)
  if (session === null) throw new Error(`job ${job.id}: thread ${job.threadId} has no session to continue`)
  const outcome = await router.runExclusive(job.threadId, async () => {
    const runCtx = buildRunContext(root, job.threadId)
    const result = await runAgent(
      runCtx.vfs,
      [job.prompt, '--resume', session],
      {
        cwd: runCtx.cwd,
        shell: runCtx.shell,
        jobShell: runCtx.jobShell,
        signal: AbortSignal.timeout(timeoutMs),
        maxSteps: Number.POSITIVE_INFINITY,
        onProgress: (line) => process.stderr.write(`[job ${job.id}] ${line}\n`),
        onSession: (id) => noteThreadId(runCtx.vfs, id, job.threadId),
      },
    )
    if (result.exitCode !== 0) throw new Error(`job ${job.id} exit ${result.exitCode}: ${result.stderr.slice(0, 500)}`)
  }, { timeoutMs })
  if (outcome.status === 'busy') throw new Error(`job ${job.id}: thread ${job.threadId} busy — retrying next tick`)
  if (outcome.status === 'timeout') throw new Error(`job ${job.id}: thread ${job.threadId} timed out — retrying next tick`)
}

const stopJobs = startJobTicker({
  vfs: createDiskVfs(root),
  intervalMs: jobsIntervalMs,
  jobTimeoutMs: timeoutMs,
  onDue: fireJob,
  onError: (err, job) => {
    process.stderr.write(`job ${job.id} attempt failed: ${err instanceof Error ? err.message : String(err)}\n`)
  },
})
void stopJobs

// interrupted runs from a dead server become continue-jobs; the ticker
// picks them up — the server resumes work without a human message
if (process.env.CELL_RESUME_ON_BOOT !== 'false') {
  try {
    const bootVfs = createDiskVfs(root)
    for (const sessionId of findInterruptedThreads(bootVfs)) {
      // the job needs the THREAD dir (where the files are), not the
      // session stem: a killed resume-run's session id differs from the
      // thread id it was working in — the sidecar maps between them
      const threadId = resolveThreadForResume(root, sessionId)
      scheduleJob(bootVfs, {
        threadId,
        prompt: resumePromptFor(sessionId),
        runAt: Date.now(),
        kind: 'continue',
      })
      process.stderr.write(`cell server: requeued interrupted thread ${threadId}\n`)
    }
  } catch (err) {
    process.stderr.write(`cell server: resume scan failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

// ---- Telegram: the same bot on a second surface (opt-in) ----
// CELL_TELEGRAM=1 starts a long-poll loop: one stable thread per chat,
// /new rotates it, reminders deliver back to the chat. Token from
// CELL_TELEGRAM_TOKEN or CELL_TELEGRAM_TOKEN_FILE (outside the workspace —
// never a workspace file, the agent's shell can read those); an empty
// allowlist fails closed (loadTelegramConfig refuses to start).
if (process.env.CELL_TELEGRAM === '1') {
  try {
    const tgVfs = createDiskVfs(root)
    // token files must live outside the workspace: anything under the
    // workspace root is mounted into the agent's shell, where `F=…;
    // cat $F` spells around the deny scanner. Fail closed on violation.
    let tokenFromFile: string | undefined
    const tokenFile = (process.env.CELL_TELEGRAM_TOKEN_FILE ?? '').trim()
    if (tokenFile !== '') {
      const realFile = realpathSync(tokenFile)
      const realRoot = realpathSync(root)
      if (realFile === realRoot || realFile.startsWith(`${realRoot}/`)) {
        throw new Error(`CELL_TELEGRAM_TOKEN_FILE is inside the workspace (${realFile}) — move it outside`)
      }
      tokenFromFile = readFileSync(realFile, 'utf8')
    }
    const loaded = loadTelegramConfig(tgVfs, process.env as Record<string, string | undefined>, tokenFromFile)
    if (loaded === null) {
      process.stderr.write('cell server: CELL_TELEGRAM=1 but no token (CELL_TELEGRAM_TOKEN or CELL_TELEGRAM_TOKEN_FILE outside the workspace) — telegram off\n')
    } else if ('error' in loaded) {
      process.stderr.write(`cell server: telegram off: ${loaded.error}\n`)
    } else {
      const apiBase = `https://api.telegram.org/bot${loaded.config.token}`
      const api = createTelegramApi(apiBase)
      const chatLabel = (chatId: number): string => `chat ${chatId}`
      const runChat = async (chatId: number, text: string, threadId: string): Promise<string> => {
        const runCtx = buildRunContext(root, threadId)
        const outcome = await router.runExclusive(threadId, async () => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), timeoutMs)
          try {
            let runSessionId = ''
            const args = [text]
            const continued = resolveSessionForThread(root, threadId)
            if (continued !== null) args.push('--resume', continued)
            const result = await runAgent(
              runCtx.vfs,
              args,
              {
                cwd: runCtx.cwd,
                shell: runCtx.shell,
                jobShell: runCtx.jobShell,
                signal: controller.signal,
                maxSteps: 40,
                // explicit non-interactive policy: the allowlisted DM chat
                // IS the user, so ask-tools run — destructive bash shapes
                // stay refused by the deny scans either way
                approve: async () => true,
                chatId: String(chatId),
                threadId,
                onSession: (id) => {
                  runSessionId = id
                  noteThreadId(runCtx.vfs, id, threadId)
                },
              },
            )
            if (result.exitCode !== 0) {
              const err = result.stderr.trim().slice(-1500)
              return err !== '' ? `error: ${err}` : `error: agent exited ${result.exitCode}`
            }
            const reply = runSessionId !== '' ? lastAssistantText(runCtx.vfs, runSessionId) : null
            const final = (reply ?? result.stdout).trim()
            return final !== '' ? final : '(no output)'
          } finally {
            clearTimeout(timeout)
          }
        }, { timeoutMs })
        if (outcome.status === 'busy') return 'still working on the last one — one moment'
        if (outcome.status === 'timeout') return 'that took too long — try a smaller step'
        return outcome.value
      }
      const poller = startTelegramPoller(tgVfs, apiBase, loaded.config, {
        log: (message) => process.stderr.write(`cell server: ${message}\n`),
        onText: (chatId, text, threadId) => runChat(chatId, text, threadId),
        onCommand: async (chatId, command, threadId) => {
          if (command.command === 'new') return `fresh thread started (${threadId}) — what are we working on?`
          if (command.command === 'status') {
            const jobs = listJobs(tgVfs)
            const live = jobs.filter((j) => j.status === 'pending')
            return live.length === 0 ? `thread ${threadId} — idle, no jobs running` : `thread ${threadId} — ${live.map((j) => `${j.id} ${j.status}`).join(', ')}`
          }
          return `${chatLabel(chatId)} bound to thread ${threadId}. Send anything to work; /new starts fresh, /status shows jobs.`
        },
      })
      void poller
      api
        .getMe()
        .then(
        (me) => process.stderr.write(`cell server: telegram live as @${me.username ?? 'unknown'}\n`),
        (err) => process.stderr.write(`cell server: telegram getMe failed: ${err instanceof Error ? err.message : String(err)}\n`),
      )
      // promised follow-ups deliver back to the chat, every 30s
      setInterval(() => {
        deliverDueReminders(createDiskVfs(root), api).then(
          ({ delivered }) => {
            if (delivered > 0) process.stderr.write(`cell server: delivered ${delivered} telegram reminder(s)\n`)
          },
          () => {},
        )
      }, 30_000)
    }
  } catch (err) {
    process.stderr.write(`cell server: telegram failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

const handleWithGateway = withGateway(
  async (req, res, ctx) => {
    await handle(req, res, ctx)
  },
  {
    tokens,
    limiter,
    usageDir,
    maxBodyBytes: MAX_BODY_BYTES,
    usageModel: (body) => {
      if (body !== null && typeof body === 'object' && typeof (body as { model?: unknown }).model === 'string') {
        return (body as { model: string }).model
      }
      return process.env.CELL_MODEL || 'default'
    },
  },
)

const server = createServer((req, res) => {
  handleWithGateway(req, res).catch(() => {
    try {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    } catch {
      // socket already gone
    }
    log(req.method ?? '?', req.url ?? '?', 500)
  })
})

server.listen(port, () => {
  process.stderr.write(`cell server listening on ${port}\n`)
})
