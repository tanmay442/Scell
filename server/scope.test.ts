import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVfs } from '../src/vfs/vfs'
import { scopeVfs } from './scope'
import { canonicalRealPath, createDiskVfs, workspaceBaseReal } from './disk-vfs'

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

  it('lists and snapshots the scope only, with scope-relative snapshot keys', () => {
    const scoped = scopeVfs(seed(), SCOPE, MOUNTS)
    expect(scoped.listAllFiles()).toEqual([
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

  it('still blocks workspace escapes through symlinks (via the disk vfs)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-test-'))
    const outside = mkdtempSync(join(tmpdir(), 'scope-outside-'))
    try {
      const base = createDiskVfs(root)
      base.write('/home/user/threads/abc/notes.txt', 'hi')
      symlinkSync(outside, join(root, 'home', 'user', 'threads', 'abc', 'link'))
      const scoped = scopeVfs(base, SCOPE, MOUNTS)
      expect(() => scoped.write('/home/user/threads/abc/link/evil.txt', 'x')).toThrow(/escapes/)
      expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})


describe('scopeVfs symlink confinement (resolveReal hook)', () => {
  /** scoped view over a disk backing, canonicalized like bindings.ts does */
  function hooked(root: string) {
    const vfs = createDiskVfs(root)
    return {
      vfs,
      scoped: scopeVfs(vfs, SCOPE, MOUNTS, {
        resolveReal: (abs) => {
          try {
            const real = canonicalRealPath(root, abs)
            const baseReal = workspaceBaseReal(root)
            if (real === baseReal) return '/'
            if (!real.startsWith(`${baseReal}${sep}`)) return null
            return `/${relative(baseReal, real)}`
          } catch {
            return null
          }
        },
      }),
    }
  }

  it('refuses reads/writes through a symlink escaping the scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-link-test-'))
    try {
      const { vfs, scoped } = hooked(root)
      vfs.mkdir('/home/user/threads/abc')
      vfs.mkdir('/home/user/threads/other')
      vfs.write('/home/user/threads/other/x.txt', 'SIBLING-SECRET')
      vfs.write('/home/user/threads/abc/notes.txt', 'hi')
      symlinkSync(join(root, 'home', 'user', 'threads', 'other'), join(root, 'home', 'user', 'threads', 'abc', 'link'))
      expect(() => scoped.read('/home/user/threads/abc/link/x.txt')).toThrow(/outside capability scope/)
      expect(() => scoped.write('/home/user/threads/abc/link/pwned.txt', 'PWNED')).toThrow(/outside capability scope/)
      expect(scoped.exists('/home/user/threads/abc/link/x.txt')).toBe(false)
      expect(vfs.read('/home/user/threads/other/x.txt')).toBe('SIBLING-SECRET')
      expect(vfs.isFile('/home/user/threads/other/pwned.txt')).toBe(false)
      // the grant itself still works
      expect(scoped.read('/home/user/threads/abc/notes.txt')).toBe('hi')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
