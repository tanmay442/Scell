import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'fflate'
import { createVfs } from '../../vfs'
import { cellCommand } from './cell-cmd'

const CONFIG = {
  endpoint: 'https://storage.example.com',
  region: 'auto',
  bucket: 'cell-bucket',
  accessKeyId: 'KEY',
  secretAccessKey: 'SECRET',
}

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  body?: Uint8Array
}

function stubFetch(handler: (request: Captured) => { status: number; body: () => Promise<string | Uint8Array> }) {
  const calls: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Captured = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer()),
    }
    calls.push(request)
    const reply = handler(request)
    return new Response((await reply.body()) as BodyInit, { status: reply.status })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

describe('cell command against stubbed S3', () => {
  it('save → list → load round-trips a workspace with binary files', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/storage.json', JSON.stringify(CONFIG))
    vfs.write('/home/user/project/src/main.ts', 'console.log("hi")\n')
    vfs.writeBytes('/home/user/project/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]))
    vfs.write('/home/user/notes/todo.txt', 'agent tasks\n')

    let savedBody: Uint8Array | null = null
    const stub = stubFetch((request) => {
      if (request.method === 'PUT') {
        savedBody = request.body ?? new Uint8Array(0)
        return { status: 200, body: async () => '' }
      }
      if (request.url.includes('list-type=2')) {
        const name = request.url.match(/prefix=([^&]*)/)?.[1] ?? 'cell%2F'
        const prefix = decodeURIComponent(name)
        return {
          status: 200,
          body: async () => `<?xml version="1.0"?><ListBucketResult><Contents><Key>${prefix}workspace-1.tar.gz</Key></Contents></ListBucketResult>`,
        }
      }
      if (request.method === 'GET' && savedBody) {
        return { status: 200, body: async () => savedBody! }
      }
      return { status: 404, body: async () => 'missing' }
    })

    try {
      const save = await cellCommand(vfs, ['save'], { cwd: '/home/user' })
      expect(save.exitCode).toBe(0)
      expect(save.stdout).toContain('saved workspace-')
      expect(stub.calls.some((call) => call.method === 'PUT' && call.url.includes('/cell-bucket/cell/workspace-'))).toBe(true)
      const put = stub.calls.find((call) => call.method === 'PUT')!
      expect(put.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=KEY\//)
      expect(put.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)

      const list = await cellCommand(vfs, ['list'], { cwd: '/home/user' })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain('workspace-1.tar.gz')

      // wipe the workspace, then restore from the snapshot
      const fresh = createVfs()
      fresh.write('/home/user/.cell/storage.json', JSON.stringify(CONFIG))
      const load = await cellCommand(fresh, ['load'], { cwd: '/home/user' })
      expect(load.exitCode).toBe(0)
      expect(fresh.read('/home/user/project/src/main.ts')).toBe('console.log("hi")\n')
      expect([...(fresh.readBytes('/home/user/project/logo.png') ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01])
      expect(fresh.read('/home/user/notes/todo.txt')).toBe('agent tasks\n')
      // the snapshot tarball itself decompresses to a real tar
      expect(gunzipSync(savedBody!).byteLength).toBeGreaterThan(512)
    } finally {
      stub.restore()
    }
  })

  it('reports a clear error without configuration', async () => {
    const vfs = createVfs()
    const result = await cellCommand(vfs, ['save'], { cwd: '/home/user' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('/home/user/.cell/storage.json')
  })

  it('status summarizes the workspace', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/a.ts', 'x')
    const result = await cellCommand(vfs, ['status'], { cwd: '/home/user' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('not configured')
    expect(result.stdout).toContain('1 files')
  })
})

describe('cell save excludes heavies (P1-6)', () => {
  it('workspaceTar skips node_modules and .git', async () => {
    const { createVfs } = await import('../../vfs')
    const vfs = createVfs()
    vfs.write('/home/user/project/index.js', 'console.log(1)')
    vfs.write('/home/user/project/node_modules/dep/index.js', 'x'.repeat(100))
    vfs.write('/home/user/project/.git/objects/big', 'y'.repeat(100))
    const { cellCommand } = await import('./cell-cmd')
    // without storage config the command fails before tarring — configure a fake
    vfs.write('/home/user/.cell/storage.json', JSON.stringify({ endpoint: 'https://x', region: 'auto', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }))
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
    try {
      const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
      const result = await cellCommand(vfs, ['save'], { cwd: '/home/user', shell })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('excluded 2 node_modules/.git files')
    } finally {
      globalThis.fetch = original
    }
  })
})
