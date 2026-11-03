# Threads wiring guide

`server/threads.ts` (per-thread exclusive router) and `server/resume.ts`
(interrupted-thread scan + continuation prompt) are ready. They are not wired
into the server yet. Paste the snippets below into `server/server.ts`. No
existing file was changed to add them.

## (a) `handleRun`: serialize per thread, 409 when busy

Add the import alongside the existing `./bindings` import:

```ts
import { createThreadRouter } from './threads'
```

Create one router next to `port` / `root` (module scope — it must be shared
across requests):

```ts
const router = createThreadRouter()
```

In `handleRun`, the thread resolution stays exactly as it is:

```ts
threadId = body.resumeId ? resolveThreadForResume(root, body.resumeId) : sessionId()
ctx = buildRunContext(root, threadId)
cwd = resolveCwd(ctx.cwd, body.cwd ?? null)
```

Then replace everything from `const controller = new AbortController()` through
the end of the function (the SSE setup + `runAgent` call + `res.end()` +
`log`) with:

```ts
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

  const args = [body.prompt]
  if (body.resumeId) args.push('--resume', body.resumeId)
  const result = await runAgent(
    ctx.vfs,
    args,
    {
      cwd,
      shell: ctx.shell,
      jobShell: ctx.jobShell,
      signal: controller.signal,
      maxSteps: body.maxSteps ?? Number.POSITIVE_INFINITY,
      onProgress: (line) => send({ type: 'progress', line }),
      onSession: (id) => noteThreadId(ctx.vfs, id, threadId),
    },
  )
  done = true
  send({ type: 'done', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
  res.end()
  log('POST', '/run', result.exitCode)
})
if (outcome.status === 'busy') {
  sendJson(res, 409, { error: 'thread busy' })
  log('POST', '/run', 409)
  return
}
```

Notes:

- The 409 branch works because the SSE headers are now written inside the
  callback — a busy caller has written nothing yet, so the JSON error is a
  clean response.
- The callback intentionally ignores the router's `{ signal }` ctx: in v1 the
  router never aborts it (no cross-run abort), so client-disconnect abort
  stays on the local `controller` as before. Stop-during-run is out of scope.
- `router.runExclusive` re-validates `threadId` as a bare stem; ids from
  `resolveThreadForResume` / `sessionId()` already satisfy it.

## (b) Boot: reschedule interrupted threads as `continue` jobs

Add the imports:

```ts
import { createDiskVfs } from './disk-vfs'
import { scheduleJob } from './jobs'
import { findInterruptedThreads, resumePromptFor } from './resume'
```

After the `ensureAgentConfig` try/catch at module scope (before `server.listen`),
add:

```ts
if (process.env.CELL_RESUME_ON_BOOT !== 'false') {
  try {
    const bootVfs = createDiskVfs(root)
    for (const sessionId of findInterruptedThreads(bootVfs)) {
      // findInterruptedThreads returns session stems; the job needs the
      // thread dir (files live there) — the sidecar maps session -> thread
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
    process.stderr.write(
      `cell server: resume scan failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
```

Do NOT call `runAgent` at boot — the ticker picks the scheduled jobs up.

## (c) Env flag

`CELL_RESUME_ON_BOOT` controls the boot scan: anything except the exact string
`'false'` keeps it enabled (default `true`). Set `CELL_RESUME_ON_BOOT=false`
to disable rescheduling after an unclean shutdown.
