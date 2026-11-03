import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAuth, loadTokens } from './auth'
import { createRateLimiter } from './ratelimit'
import { readUsage } from './usage'
import { withGateway, type GatewayContext, type GatewayOptions } from './gateway'

const TOKENS = [
  { id: 'alice', token: 'secret-alice' },
  { id: 'bob', token: 'secret-bob' },
]

function usageModel(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const model = (body as { model?: unknown }).model
    if (typeof model === 'string' && model !== '') return model
  }
  return 'test-model'
}

interface Seen {
  tokenId: string
  rawBody: string
}

function makeInner(seen: Seen[], report?: { steps: number; exitCode: number }) {
  return async (req: IncomingMessage, res: ServerResponse, ctx: GatewayContext) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    seen.push({ tokenId: ctx.tokenId, rawBody: Buffer.concat(chunks).toString('utf8') })
    if (report) ctx.report(report)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }
}

async function startServer(
  inner: (req: IncomingMessage, res: ServerResponse, ctx: GatewayContext) => Promise<void>,
  opts: Partial<GatewayOptions> & { usageDir: string },
): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = withGateway(inner, {
    tokens: TOKENS,
    limiter: createRateLimiter({ windowMs: 60_000, max: 1_000 }),
    usageModel,
    ...opts,
  })
  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      } else res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gateway-test-'))
}

async function waitForUsage(dir: string, count: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 2000
  for (;;) {
    const rows = await readUsage(dir)
    if (rows.length >= count || Date.now() > deadline) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('gateway', () => {
  it('passes GET /health through without a token and logs no usage', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen), { usageDir })
    try {
      const res = await fetch(`${base}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(seen).toHaveLength(1)
      expect(existsSync(join(usageDir, 'usage.jsonl'))).toBe(false)
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })

  it('returns 401 without a token and with a wrong token', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen), { usageDir })
    try {
      const noToken = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      expect(noToken.status).toBe(401)
      expect(await noToken.json()).toEqual({ error: 'unauthorized' })

      const wrong = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      expect(wrong.status).toBe(401)
      expect(await wrong.json()).toEqual({ error: 'unauthorized' })

      expect(seen).toHaveLength(0)
      expect(existsSync(join(usageDir, 'usage.jsonl'))).toBe(false)
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })

  it('rate-limits after N hits in the window, then recovers after the window', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    let now = 1_000_000
    const baseLimiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const { base, close } = await startServer(makeInner(seen), {
      usageDir,
      limiter: (id: string) => baseLimiter(id, now),
    })
    const post = () =>
      fetch(`${base}/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-alice', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
    try {
      expect((await post()).status).toBe(200)
      expect((await post()).status).toBe(200)
      const limited = await post()
      expect(limited.status).toBe(429)
      const limitedBody = (await limited.json()) as { error: string; retryAfterMs: number }
      expect(limitedBody.error).toBe('rate limited')
      expect(limitedBody.retryAfterMs).toBeGreaterThan(0)

      now += 60_001
      expect((await post()).status).toBe(200)
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })

  it('writes a usage line with the right fields and replays the body to inner', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen, { steps: 3, exitCode: 0 }), {
      usageDir,
    })
    try {
      const sent = JSON.stringify({ prompt: 'hello', model: 'm1' })
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-alice', 'content-type': 'application/json' },
        body: sent,
      })
      expect(res.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0].tokenId).toBe('alice')
      expect(seen[0].rawBody).toBe(sent)

      await waitForUsage(usageDir, 1)
      const lines = readFileSync(join(usageDir, 'usage.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0]) as Record<string, unknown>
      expect(record.tokenId).toBe('alice')
      expect(record.model).toBe('m1')
      expect(record.promptChars).toBe(5)
      expect(record.steps).toBe(3)
      expect(record.exitCode).toBe(0)
      expect(typeof record.at).toBe('string')
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })

  it('defaults usage stats when inner never calls report()', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen), { usageDir })
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-bob', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hey' }),
      })
      expect(res.status).toBe(200)
      const rows = await waitForUsage(usageDir, 1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tokenId: 'bob', steps: -1, exitCode: -1, promptChars: 3 })
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })

  it('allows requests without a token when no tokens are configured', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen, { steps: 1, exitCode: 0 }), {
      usageDir,
      tokens: [],
    })
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'open' }),
      })
      expect(res.status).toBe(200)
      const rows = await waitForUsage(usageDir, 1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tokenId: 'local' })
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })
})

describe('auth', () => {
  it('returns no tokens for empty env (auth disabled)', () => {
    expect(loadTokens('')).toEqual([])
    expect(loadTokens('   ')).toEqual([])
  })

  it('parses id:token pairs', () => {
    expect(loadTokens('a:1,b:2')).toEqual([
      { id: 'a', token: '1' },
      { id: 'b', token: '2' },
    ])
  })

  it('throws a clear error on malformed entries', () => {
    expect(() => loadTokens('no-colon')).toThrow(/expected "id:token"/)
    expect(() => loadTokens('a:1,:2')).toThrow(/expected "id:token"/)
    expect(() => loadTokens('a:')).toThrow(/expected "id:token"/)
  })

  it('matches Bearer tokens and rejects anything else', () => {
    expect(checkAuth(TOKENS, 'Bearer secret-alice')).toEqual({ ok: true, id: 'alice' })
    expect(checkAuth(TOKENS, 'Bearer secret-bob')).toEqual({ ok: true, id: 'bob' })
    expect(checkAuth(TOKENS, null)).toEqual({ ok: false })
    expect(checkAuth(TOKENS, 'Bearer nope')).toEqual({ ok: false })
    expect(checkAuth(TOKENS, 'Basic secret-alice')).toEqual({ ok: false })
    expect(checkAuth(TOKENS, 'Bearer secret-alice-extra')).toEqual({ ok: false })
  })
})

describe('ratelimit', () => {
  it('is fixed-window per id with an injectable clock', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 })
    expect(limiter('a', 0)).toEqual({ ok: true })
    expect(limiter('a', 500)).toEqual({ ok: true })
    const limited = limiter('a', 999)
    expect(limited.ok).toBe(false)
    if (!limited.ok) expect(limited.retryAfterMs).toBe(1)
    expect(limiter('b', 999)).toEqual({ ok: true })
    expect(limiter('a', 1000)).toEqual({ ok: true })
  })
})

describe('gateway hardening (F5: unbounded buffered bodies)', () => {
  it('rejects bodies past maxBodyBytes with 413', async () => {
    const usageDir = tempDir()
    const seen: Seen[] = []
    const { base, close } = await startServer(makeInner(seen), {
      usageDir,
      maxBodyBytes: 1024,
    })
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-alice' },
        body: JSON.stringify({ prompt: 'x'.repeat(4096) }),
      })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'body too large' })
      expect(seen).toHaveLength(0)
    } finally {
      await close()
      rmSync(usageDir, { recursive: true, force: true })
    }
  })
})
