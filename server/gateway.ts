import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkAuth, type ApiToken } from './auth'
import type { RateLimiter } from './ratelimit'
import { logUsage } from './usage'

export interface GatewayReport {
  steps: number
  exitCode: number
}

export interface GatewayContext {
  tokenId: string
  report: (stats: GatewayReport) => void
  /** exact request bytes the gateway already buffered (avoids a second
   * read+concat downstream for large bodies) */
  rawBody: string
}

export type GatewayInner = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
) => Promise<void>

export interface GatewayOptions {
  tokens: ApiToken[]
  limiter: RateLimiter
  usageDir: string
  usageModel: (body: unknown) => string
  /** reject buffered request bodies past this size (default 4MB) */
  maxBodyBytes?: number
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(`${JSON.stringify(body)}\n`)
}

function isHealth(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname === '/health'
  } catch {
    return false
  }
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(buf)
  }
  return chunks
}

export function withGateway(
  inner: GatewayInner,
  opts: GatewayOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (isHealth(req)) {
      await inner(req, res, { tokenId: 'health', report: () => {}, rawBody: '' })
      return
    }
    const auth = checkAuth(opts.tokens, req.headers.authorization ?? null)
    if (!auth.ok) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const limit = opts.limiter(auth.id)
    if (!limit.ok) {
      sendJson(res, 429, { error: 'rate limited', retryAfterMs: limit.retryAfterMs })
      return
    }
    let chunks: Buffer[]
  try {
    chunks = await readRawBody(req, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
  } catch {
    sendJson(res, 413, { error: 'body too large' })
    return
  }
    const replayBody = async function* (): AsyncGenerator<Buffer, void, void> {
      for (const chunk of chunks) yield chunk
    }
    ;(req as unknown as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = replayBody
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown
    try {
      parsed = raw.trim() === '' ? undefined : (JSON.parse(raw) as unknown)
    } catch {
      parsed = undefined
    }
    let model = 'unknown'
    try {
      model = opts.usageModel(parsed) || 'unknown'
    } catch {
      model = 'unknown'
    }
    let promptChars = 0
    if (parsed !== null && typeof parsed === 'object') {
      const prompt = (parsed as { prompt?: unknown }).prompt
      if (typeof prompt === 'string') promptChars = prompt.length
    }
    let stats: GatewayReport = { steps: -1, exitCode: -1 }
    await inner(req, res, {
      tokenId: auth.id,
      report: (next) => {
        stats = next
      },
      rawBody: raw,
    })
    await logUsage(opts.usageDir, {
      at: new Date().toISOString(),
      tokenId: auth.id,
      model,
      promptChars,
      steps: stats.steps,
      exitCode: stats.exitCode,
    })
  }
}
