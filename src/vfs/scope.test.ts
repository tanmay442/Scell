import { describe, expect, it } from 'vitest'
import { createVfs } from './vfs'
import { scopeVfs } from './scope'

const SCOPE = '/home/user/threads/abc'
const MOUNTS = { '/home/user/.cell': '/home/user/.cell' }

function seed() {
  return createVfs({
    '/home/user/threads/abc/notes.txt': 'hi',
    '/home/user/threads/abc/sub/a.txt': 'a',
    '/home/user/threads/other/x.txt': 'other',
    '/home/user/.cell/agent.json': '{"provider":"meta"}',
    '/etc/passwd': 'root:x',
  })
}

describe('scopeVfs', () => {
  it('reads and writes inside the scope', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    expect(scoped.read('/home/user/threads/abc/notes.txt')).toBe('hi')
    scoped.write('/home/user/threads/abc/new.txt', 'new')
    expect(base.read('/home/user/threads/abc/new.txt')).toBe('new')
    expect(scoped.readDir('/home/user/threads/abc')).toEqual(['new.txt', 'notes.txt', 'sub'])
    scoped.mkdir('/home/user/threads/abc/made/nested')
    expect(base.isDir('/home/user/threads/abc/made/nested')).toBe(true)
  })

  it('keeps stat sizes real and readBytes raw', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    expect(scoped.stat('/home/user/threads/abc/notes.txt')).toMatchObject({ type: 'file', size: 2 })
    expect(scoped.stat('/home/user/threads/abc/sub')).toMatchObject({ type: 'dir' })
    expect(scoped.stat('/home/user/threads/abc/missing.txt')).toBeNull()
    const bytes = new Uint8Array([104, 105, 0, 255, 1])
    scoped.writeBytes('/home/user/threads/abc/blob.bin', bytes)
    expect(scoped.readBytes('/home/user/threads/abc/blob.bin')).toEqual(bytes)
    expect(scoped.read('/home/user/threads/abc/blob.bin')).toBeNull()
  })

  it('throws EINVAL on absolute and dot-dot escapes', () => {
    const scoped = scopeVfs(seed(), SCOPE, MOUNTS)
    expect(() => scoped.read('/etc/passwd')).toThrow(/EINVAL: outside capability scope/)
    expect(() => scoped.read('/home/user/threads/abc/../../etc/passwd')).toThrow(/outside capability scope/)
    expect(() => scoped.write('/etc/passwd', 'x')).toThrow(/outside capability scope/)
    expect(() => scoped.write('/home/user/threads/abc/../../evil.txt', 'x')).toThrow(/outside capability scope/)
    expect(() => scoped.readDir('/')).toThrow(/outside capability scope/)
    expect(() => scoped.readDir('/home/user/threads')).toThrow(/outside capability scope/)
    expect(() => scoped.stat('/etc/passwd')).toThrow(/outside capability scope/)
    expect(() => scoped.mkdir('/tmp/x')).toThrow(/outside capability scope/)
    expect(() => scoped.delete('/home/user/threads/other/x.txt')).toThrow(/outside capability scope/)
    expect(() => scoped.rename('/home/user/threads/abc/notes.txt', '/home/user/threads/other/y.txt')).toThrow(/outside capability scope/)
    expect(() => scoped.rename('/home/user/threads/other/x.txt', '/home/user/threads/abc/y.txt')).toThrow(/outside capability scope/)
    // relative paths normalize to / and land outside the scope too
    expect(() => scoped.read('oops.txt')).toThrow(/outside capability scope/)
  })

  it('blocks the sibling thread dir', () => {
    const scoped = scopeVfs(seed(), SCOPE, MOUNTS)
    expect(() => scoped.read('/home/user/threads/other/x.txt')).toThrow(/outside capability scope/)
    expect(() => scoped.write('/home/user/threads/other/y.txt', 'y')).toThrow(/outside capability scope/)
  })

  it('answers presence probes outside the grant with false, not data', () => {
    const scoped = scopeVfs(seed(), SCOPE, MOUNTS)
    expect(scoped.exists('/etc/passwd')).toBe(false)
    expect(scoped.isFile('/etc/passwd')).toBe(false)
    expect(scoped.isDir('/home/user/threads')).toBe(false)
    // …while probes through the mount and inside the scope work
    expect(scoped.exists('/home/user/.cell/agent.json')).toBe(true)
    expect(scoped.isFile('/home/user/threads/abc/notes.txt')).toBe(true)
  })

  it('reads and writes through the mount', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    expect(scoped.read('/home/user/.cell/agent.json')).toBe('{"provider":"meta"}')
    scoped.write('/home/user/.cell/sessions/s1.json', '{}')
    expect(base.read('/home/user/.cell/sessions/s1.json')).toBe('{}')
    expect(() => scoped.read('/home/user/nope.txt')).toThrow(/outside capability scope/)
  })

  it('lists scope plus mounts, snapshots the scope only (scope-relative keys)', () => {
    const scoped = scopeVfs(seed(), SCOPE, MOUNTS)
    expect(scoped.listAllFiles()).toEqual([
      '/home/user/.cell/agent.json',
      '/home/user/threads/abc/notes.txt',
      '/home/user/threads/abc/sub/a.txt',
    ])
    expect(scoped.snapshot()).toEqual({
      'notes.txt': 'hi',
      'sub/a.txt': 'a',
    })
  })

  it('restores only the scope, rejecting escaping keys before touching anything', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    scoped.restore({ 'fresh.txt': 'new', 'sub/b.txt': 'b' })
    expect(base.read('/home/user/threads/abc/fresh.txt')).toBe('new')
    expect(base.read('/home/user/threads/abc/sub/b.txt')).toBe('b')
    expect(base.exists('/home/user/threads/abc/notes.txt')).toBe(false)
    // outside the scope is untouched
    expect(base.read('/home/user/threads/other/x.txt')).toBe('other')
    expect(base.read('/home/user/.cell/agent.json')).toBe('{"provider":"meta"}')
    expect(() => scoped.restore({ '../evil.txt': 'x' })).toThrow(/capability scope/)
    expect(() => scoped.restore({ '/abs.txt': 'x' })).toThrow(/scope-relative/)
    // the failed restore left the scope as it was
    expect(base.read('/home/user/threads/abc/fresh.txt')).toBe('new')
  })

  it('renames inside the scope and forbids destroying the scope root', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    scoped.rename('/home/user/threads/abc/notes.txt', '/home/user/threads/abc/renamed.txt')
    expect(base.exists('/home/user/threads/abc/notes.txt')).toBe(false)
    expect(base.read('/home/user/threads/abc/renamed.txt')).toBe('hi')
    expect(() => scoped.delete(SCOPE)).toThrow(/EPERM/)
    expect(() => scoped.rename(SCOPE, '/home/user/threads/abc2')).toThrow(/EPERM/)
  })

  it('forwards watch events inside the grant and drops the rest', () => {
    const base = seed()
    const scoped = scopeVfs(base, SCOPE, MOUNTS)
    const seen: Array<{ path: string; to?: string }> = []
    const unsub = scoped.watch((e) => seen.push({ path: e.path, ...(e.to !== undefined ? { to: e.to } : {}) }))
    base.write('/home/user/threads/abc/live.txt', 'live')
    base.write('/home/user/threads/other/sneaky.txt', 'sneaky')
    base.write('/home/user/.cell/agent.json', '{"provider":"openai"}')
    expect(seen).toEqual([
      { path: '/home/user/threads/abc/live.txt' },
      { path: '/home/user/.cell/agent.json' },
    ])
    unsub()
    base.write('/home/user/threads/abc/after.txt', 'after')
    expect(seen.length).toBe(2)
  })
})

describe('scopeVfs as the agent file-tool boundary', () => {
  it('refuses sibling-thread reads through runTool while the project stays readable', async () => {
    const { runTool } = await import('../shell/commands/agent-tools')
    const base = seed()
    base.write('/home/user/project/README.md', '# Starter project\n')
    const mounts = { ...MOUNTS, '/home/user/project': '/home/user/project' }
    const scoped = scopeVfs(base, SCOPE, mounts)
    const deps = { vfs: scoped, shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, cwd: SCOPE }
    const denied = await runTool(deps as never, { id: 'c1', name: 'read', input: { path: '/home/user/threads/other/x.txt' } })
    expect(denied.isError).toBe(true)
    expect(denied.content).toMatch(/outside your thread scope/)
    const allowed = await runTool(deps as never, { id: 'c2', name: 'read', input: { path: '/home/user/project/README.md' } })
    expect(allowed.isError).toBeFalsy()
    expect(allowed.content).toContain('Starter project')
    const own = await runTool(deps as never, { id: 'c3', name: 'write', input: { path: 'notes2.txt', content: 'hi' } })
    expect(own.isError).toBeFalsy()
    expect(base.read('/home/user/threads/abc/notes2.txt')).toBe('hi')
  })
})
