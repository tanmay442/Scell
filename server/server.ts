import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runAgent } from '../src/shell/commands/agent'
import { createDiskVfs } from './disk-vfs'
import { createNodeShell } from './node-shell'
import { ensureAgentConfig } from './bootstrap'

const MAX_BODY_BYTES = 4 * 1024 * 1024

const port = Number(process.env.CELL_PORT || '8787') || 8787
const root = process.env.CELL_WORKSPACE || './cell-workspace'
const vfs = createDiskVfs(root)

try {
  ensureAgentConfig(vfs)
} catch (err) {
  process.stderr.write(`cell server: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}

function log(method: string, path: string, code: number): void {
  process.stderr.write(`${method} ${path} -> ${code}\n`)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(`${JSON.stringify(body)}\n`)
}

async function readBody(req: IncomingMessage): Promise<string> {
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

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch {
    sendJson(res, 400, { error: 'body too large' })
    log('POST', '/run', 400)
    return
  }
  let body: { prompt?: unknown; resumeId?: unknown; maxSteps?: unknown; cwd?: unknown }
  try {
    body = JSON.parse(raw === '' ? 'null' : raw) as typeof body
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' })
    log('POST', '/run', 400)
    return
  }
  if (body === null || typeof body !== 'object' || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    sendJson(res, 400, { error: 'missing prompt: send JSON {"prompt": "..."}' })
    log('POST', '/run', 400)
    return
  }
  if (body.resumeId !== undefined && typeof body.resumeId !== 'string') {
    sendJson(res, 400, { error: 'resumeId must be a string' })
    log('POST', '/run', 400)
    return
  }
  if (body.maxSteps !== undefined && (typeof body.maxSteps !== 'number' || !(body.maxSteps > 0))) {
    sendJson(res, 400, { error: 'maxSteps must be a positive number' })
    log('POST', '/run', 400)
    return
  }
  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    sendJson(res, 400, { error: 'cwd must be a string' })
    log('POST', '/run', 400)
    return
  }

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
    vfs,
    args,
    {
      cwd: body.cwd || '/home/user',
      shell: createNodeShell(root),
      jobShell: createNodeShell(root),
      signal: controller.signal,
      maxSteps: body.maxSteps ?? Number.POSITIVE_INFINITY,
      onProgress: (line) => send({ type: 'progress', line }),
    },
  )
  done = true
  send({ type: 'done', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
  res.end()
  log('POST', '/run', result.exitCode)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true })
    log('GET', '/health', 200)
    return
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    await handleRun(req, res)
    return
  }
  sendJson(res, 404, { error: 'not found' })
  log(req.method ?? '?', url.pathname, 404)
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
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
