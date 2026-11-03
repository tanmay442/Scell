import { existsSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scopeVfs } from '../src/vfs/scope'
import { canonicalRealPath, createDiskVfs, workspaceBaseReal } from './disk-vfs'

const SCOPE = '/home/user/threads/abc'
const MOUNTS = { '/home/user/.cell': '/home/user/.cell' }

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

void realpathSync

describe('scopeVfs disk edge cases', () => {
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

  it('lists mounted paths in listAllFiles so git/python discovery keeps working', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-mounts-'))
    try {
      const { vfs, scoped } = hooked(root)
      vfs.mkdir('/home/user/threads/abc')
      vfs.write('/home/user/threads/abc/notes.txt', 'hi')
      vfs.write('/home/user/.cell/agent.json', '{}')
      vfs.write('/home/user/.cell/skills/a/SKILL.md', 'x')
      vfs.write('/home/user/project/src/app.ts', 'x')
      const listed = scoped.listAllFiles()
      expect(listed).toContain('/home/user/threads/abc/notes.txt')
      // mounts are visible under their scoped names
      expect(listed).toContain('/home/user/.cell/agent.json')
      // unmounted projects stay invisible
      expect(listed.some((p) => p.startsWith('/home/user/project/'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
