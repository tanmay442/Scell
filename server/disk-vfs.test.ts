import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDiskVfs } from './disk-vfs'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'disk-vfs-test-'))
}

describe('disk-vfs', () => {
  it('roundtrips text through write/read', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/hello.txt', 'hello')
      expect(vfs.read('/hello.txt')).toBe('hello')
      expect(vfs.isText('/hello.txt')).toBe(true)
      vfs.write('/nested/deep/file.txt', 'deep')
      expect(vfs.read('/nested/deep/file.txt')).toBe('deep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stores binary separately: read returns null and isText is false', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      const bytes = new Uint8Array([104, 105, 0, 255, 1, 2])
      vfs.writeBytes('/bin.dat', bytes)
      expect(vfs.read('/bin.dat')).toBeNull()
      expect(vfs.isText('/bin.dat')).toBe(false)
      expect(vfs.readBytes('/bin.dat')).toEqual(bytes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports mkdir and readDir', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      vfs.mkdir('/sub')
      expect(vfs.isDir('/sub')).toBe(true)
      vfs.write('/sub/a.txt', 'a')
      vfs.write('/sub/b.txt', 'b')
      expect(vfs.readDir('/sub')).toEqual(['a.txt', 'b.txt'])
      expect(vfs.readDir('/')).toContain('sub')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes a file and a whole tree', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/gone.txt', 'x')
      vfs.delete('/gone.txt')
      expect(vfs.exists('/gone.txt')).toBe(false)
      vfs.write('/tree/a.txt', 'a')
      vfs.write('/tree/nested/b.txt', 'b')
      vfs.delete('/tree')
      expect(vfs.exists('/tree')).toBe(false)
      expect(vfs.exists('/tree/nested/b.txt')).toBe(false)
      expect(() => vfs.delete('/')).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renames files and reports stat sizes', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/old.txt', 'hello')
      vfs.rename('/old.txt', '/moved/new.txt')
      expect(vfs.exists('/old.txt')).toBe(false)
      expect(vfs.read('/moved/new.txt')).toBe('hello')
      expect(vfs.stat('/moved/new.txt')).toMatchObject({ type: 'file', size: 5 })
      expect(vfs.stat('/moved')).toMatchObject({ type: 'dir' })
      expect(vfs.stat('/missing.txt')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('roundtrips snapshot/restore', () => {
    const root = tempRoot()
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/keep.txt', 'keep')
      vfs.writeBytes('/blob.bin', new Uint8Array([1, 0, 2]))
      const snap = vfs.snapshot()
      vfs.write('/keep.txt', 'changed')
      vfs.write('/extra.txt', 'extra')
      vfs.restore(snap)
      expect(vfs.read('/keep.txt')).toBe('keep')
      expect(vfs.exists('/extra.txt')).toBe(false)
      expect(vfs.read('/blob.bin')).toBeNull()
      expect(vfs.readBytes('/blob.bin')).toEqual(new Uint8Array([1, 0, 2]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a path that escapes the root', () => {
    const root = tempRoot()
    const outside = tempRoot()
    try {
      symlinkSync(outside, join(root, 'link'))
      const vfs = createDiskVfs(root)
      expect(() => vfs.write('/link/evil.txt', 'x')).toThrow(/escapes/)
      expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
