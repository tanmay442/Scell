# Jobs wiring guide

`server/jobs.ts` (durable queue at VFS path `/home/user/.cell/job-queue.json`)
and `server/ticker.ts` (poll loop) are ready. They are not wired into the
server yet. Paste the snippets below into `server/server.ts`.

## (a) HTTP routes: `POST /jobs`, `GET /jobs`, `DELETE /jobs/:id`

Add the imports, then extend `handle()` next to the existing `/run` branch.

```ts
import { cancelJob, listJobs, scheduleJob } from './jobs'

// inside handle(), after the POST /run branch:
if (req.method === 'GET' && url.pathname === '/jobs') {
  sendJson(res, 200, { jobs: listJobs(vfs) })
  log('GET', '/jobs', 200)
  return
}
if (req.method === 'POST' && url.pathname === '/jobs') {
  let body: { threadId?: unknown; prompt?: unknown; runAt?: unknown; kind?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.threadId !== 'string' || body.threadId === '') {
    sendJson(res, 400, { error: 'threadId must be a non-empty string' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.prompt !== 'string' || body.prompt === '') {
    sendJson(res, 400, { error: 'prompt must be a non-empty string' })
    log('POST', '/jobs', 400)
    return
  }
  if (typeof body.runAt !== 'number' || !(body.runAt > 0)) {
    sendJson(res, 400, { error: 'runAt must be epoch ms' })
    log('POST', '/jobs', 400)
    return
  }
  const kind = body.kind === 'snapshot' ? 'snapshot' : 'continue'
  const job = scheduleJob(vfs, { threadId: body.threadId, prompt: body.prompt, runAt: body.runAt, kind })
  sendJson(res, 201, { job })
  log('POST', '/jobs', 201)
  return
}
if (req.method === 'DELETE' && url.pathname.startsWith('/jobs/')) {
  const id = decodeURIComponent(url.pathname.slice('/jobs/'.length))
  if (!cancelJob(vfs, id)) {
    sendJson(res, 404, { error: 'job not found' })
    log('DELETE', url.pathname, 404)
    return
  }
  sendJson(res, 200, { ok: true })
  log('DELETE', url.pathname, 200)
  return
}
```

## (b) Ticker `onDue`: continue the thread via `runAgent`

This mirrors the real `runAgent` call in `server.ts` (`handleRun`) and
`server/run-once.ts` (`main`): prompt first, `--resume <id>` appended last,
same `cwd` / `shell` / `jobShell` / `maxSteps` options.

```ts
import { runAgent } from '../src/shell/commands/agent'
import { startJobTicker } from './ticker'

const stopJobs = startJobTicker({
  vfs,
  intervalMs: Number(process.env.CELL_JOBS_INTERVAL_MS || '30000'),
  onDue: async (job) => {
    // 'continue' resumes the thread; 'snapshot' runs its prompt standalone.
    const args = job.kind === 'continue' ? [job.prompt, '--resume', job.threadId] : [job.prompt]
    const result = await runAgent(vfs, args, {
      cwd: '/home/user',
      shell: createNodeShell(root),
      jobShell: createNodeShell(root),
      signal: AbortSignal.timeout(Number(process.env.CELL_TIMEOUT_MS || '600000')),
      maxSteps: Number.POSITIVE_INFINITY,
      onProgress: (line) => process.stderr.write(`[job ${job.id}] ${line}\n`),
    })
    // Throwing leaves the job pending (attempts + 1) so it retries next tick.
    // The ticker marks the job done only when onDue resolves.
    if (result.exitCode !== 0) throw new Error(`job ${job.id} exit ${result.exitCode}: ${result.stderr}`)
  },
  onError: (err, job) => {
    process.stderr.write(`job ${job.id} attempt failed: ${err instanceof Error ? err.message : String(err)}\n`)
  },
})
```

Do NOT call `markDone` yourself — the ticker calls it after `onDue`
resolves. Call `stopJobs()` on shutdown next to `server.close()`.

## (c) Poll interval env

```sh
CELL_JOBS_INTERVAL_MS=30000 node dist-server/server/server.js
```

`CELL_JOBS_INTERVAL_MS` is the ticker poll period in ms, default `30000`.
Shorter (e.g. `5000`) wakes jobs closer to `runAt`; longer lowers VFS churn.
Due jobs run at the first tick with `runAt <= Date.now()`. Failed jobs retry
until `attempts >= 5`, then stop being due.
