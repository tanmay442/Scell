import { runAgent } from '../src/shell/commands/agent'
import { sessionId } from '../src/shell/commands/agent-sessions'
import { buildRunContext, noteThreadId, resolveCwd, resolveThreadForResume } from './bindings'
import { LocalDirStore, S3StoreFromEnv, defaultSnapshotsDir, pullSnapshot, pushSnapshot, type SnapshotStore } from './snapshots'

interface RunOnceOptions {
  words: string[]
  resumeId: string | null
  steps: number
  cwd: string | null
  workspace: string
  timeoutMs: number
  pull: string | null
  push: string | null
}

function snapshotStore(workspace: string): SnapshotStore {
  if (process.env.CELL_S3_BUCKET) return S3StoreFromEnv()
  return LocalDirStore(process.env.CELL_SNAPSHOTS_DIR || defaultSnapshotsDir(workspace))
}

function parseArgv(argv: string[]): RunOnceOptions {
  const words: string[] = []
  let resumeId: string | null = null
  let steps = Number.POSITIVE_INFINITY
  let cwd: string | null = null
  let workspace = process.env.CELL_WORKSPACE || './cell-workspace'
  let timeoutMs = Number(process.env.CELL_TIMEOUT_MS || '600000')
  if (Number.isNaN(timeoutMs)) timeoutMs = 600000
  let pull: string | null = null
  let push: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--resume') {
      const id = argv[++i]
      if (id === undefined || id.startsWith('--')) throw new Error('--resume needs a session id')
      resumeId = id
    } else if (arg === '--steps') {
      const raw = argv[++i]
      steps = Number(raw)
      if (!Number.isFinite(steps) || steps <= 0) throw new Error(`invalid --steps '${raw ?? ''}'`)
    } else if (arg === '--cwd') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--cwd needs a VFS path')
      cwd = value
    } else if (arg === '--workspace') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--workspace needs a directory')
      workspace = value
    } else if (arg === '--pull') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--pull needs a snapshot name')
      pull = value
    } else if (arg === '--push') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--push needs a snapshot name')
      push = value
    } else if (arg === '--timeout-ms') {
      const raw = argv[++i]
      timeoutMs = Number(raw)
      if (Number.isNaN(timeoutMs) || timeoutMs < 0) throw new Error(`invalid --timeout-ms '${raw ?? ''}'`)
    } else {
      words.push(arg)
    }
  }
  return { words, resumeId, steps, cwd, workspace, timeoutMs, pull, push }
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2))
  // the thread id is the resume target for --resume, else a fresh session
  // id; the run is then confined to that thread dir (see bindings.ts)
  const threadId = opts.resumeId !== null ? resolveThreadForResume(opts.workspace, opts.resumeId) : sessionId()
  const ctx = buildRunContext(opts.workspace, threadId)
  const cwd = resolveCwd(ctx.cwd, opts.cwd)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  if (opts.pull !== null) {
    const pulled = await pullSnapshot(opts.workspace, snapshotStore(opts.workspace), opts.pull)
    process.stderr.write(`cell run-once: snapshot '${opts.pull}': ${pulled.status}` + '\n')
  }
  let exitCode = 2
  try {
    const args = [...opts.words]
    if (opts.resumeId !== null) args.push('--resume', opts.resumeId)
    const result = await runAgent(
      ctx.vfs,
      args,
      {
        cwd,
        shell: ctx.shell,
        jobShell: ctx.jobShell,
        signal: controller.signal,
        maxSteps: opts.steps,
        onProgress: (line) => process.stderr.write(`${line}\n`),
        onSession: (id) => noteThreadId(ctx.vfs, id, threadId),
      },
    )
    if (result.stdout !== '') process.stdout.write(result.stdout)
    if (result.stderr !== '') process.stderr.write(result.stderr)
    exitCode = result.exitCode
  } finally {
    if (opts.push !== null) {
      try {
        const pushed = await pushSnapshot(opts.workspace, snapshotStore(opts.workspace), opts.push, { slim: true })
        process.stderr.write(`cell run-once: snapshot '${opts.push}': ${pushed.skipped ? 'unchanged, skipped' : 'pushed'}` + '\n')
      } catch (err) {
        // the push is best-effort: it must not mask the run's exit code
        process.stderr.write(`cell run-once: push failed: ${err instanceof Error ? err.message : String(err)}` + '\n')
      }
    }
    clearTimeout(timer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  process.exit(exitCode)
}

main().catch((err) => {
  process.stderr.write(`cell run-once: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
})
