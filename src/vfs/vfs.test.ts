import { describe, expect, it } from 'vitest'
import { createVfs } from './vfs'
import { vfsPath } from './types'

describe('vfsPath', () => {
  it('normalizes dot segments', () => {
    expect(vfsPath.normalize('src/../lib/./x.ts')).toBe('/lib/x.ts')
    expect(vfsPath.normalize('/')).toBe('/')
  })
  it('splits names', () => {
    expect(vfsPath.dirname('/a/b/c.ts')).toBe('/a/b')
    expect(vfsPath.basename('/a/b/c.ts')).toBe('c.ts')
    expect(vfsPath.ext('/a/b/c.TS')).toBe('ts')
  })
})

describe('createVfs', () => {
  it('writes and reads files, creating parents', () => {
    const vfs = createVfs()
    vfs.write('/src/deep/nested/file.ts', 'hello')
    expect(vfs.read('/src/deep/nested/file.ts')).toBe('hello')
    expect(vfs.isDir('/src/deep')).toBe(true)
  })

  it('reads null for missing files and throws for dirs', () => {
    const vfs = createVfs({ '/a.txt': 'x' })
    expect(vfs.read('/missing.txt')).toBeNull()
    expect(() => vfs.read('/')).toThrow()
  })

  it('readDir lists sorted child names', () => {
    const vfs = createVfs({ '/b.txt': '1', '/a.txt': '2', '/dir/c.txt': '3' })
    expect(vfs.readDir('/')).toEqual(['a.txt', 'b.txt', 'dir'])
    expect(vfs.readDir('/dir')).toEqual(['c.txt'])
  })

  it('snapshot and restore roundtrip', () => {
    const a = createVfs({ '/x.ts': '1', '/d/y.ts': '2' })
    const snap = a.snapshot()
    const b = createVfs()
    b.restore(snap)
    expect(b.snapshot()).toEqual(snap)
  })

  it('deletes recursively', () => {
    const vfs = createVfs({ '/d/a.ts': '1', '/d/sub/b.ts': '2', '/keep.ts': '3' })
    vfs.delete('/d')
    expect(vfs.listAllFiles()).toEqual(['/keep.ts'])
  })

  it('renames files and directories', () => {
    const vfs = createVfs({ '/a.ts': '1', '/d/x.ts': '2' })
    vfs.rename('/a.ts', '/b.ts')
    expect(vfs.read('/b.ts')).toBe('1')
    vfs.rename('/d', '/e')
    expect(vfs.read('/e/x.ts')).toBe('2')
    expect(vfs.exists('/d')).toBe(false)
  })

  it('refuses renaming onto existing paths or into itself', () => {
    const vfs = createVfs({ '/a.ts': '1', '/b.ts': '2', '/d/x.ts': '3' })
    expect(() => vfs.rename('/a.ts', '/b.ts')).toThrow(/EEXIST/)
    expect(() => vfs.rename('/d', '/d/sub')).toThrow(/EINVAL/)
  })

  it('emits watch events, silent on identical writes', () => {
    const vfs = createVfs({ '/a.ts': 'same' })
    const events: string[] = []
    vfs.watch((e) => events.push(`${e.kind}:${e.path}`))
    vfs.write('/a.ts', 'same')
    vfs.write('/a.ts', 'different')
    vfs.mkdir('/new-dir')
    vfs.rename('/a.ts', '/moved.ts')
    vfs.delete('/moved.ts')
    expect(events).toEqual([
      'write:/a.ts',
      'mkdir:/new-dir',
      'rename:/a.ts',
      'delete:/moved.ts',
    ])
  })
})

describe('binary identical-check (P1-3)', () => {
  it('same bytes do not emit a watch event', async () => {
    const { createVfs } = await import('./vfs')
    const vfs = createVfs()
    let events = 0
    vfs.watch(() => events++)
    vfs.writeBytes('/img.bin', new Uint8Array([1, 2, 3]))
    expect(events).toBe(1)
    vfs.writeBytes('/img.bin', new Uint8Array([1, 2, 3]))
    expect(events).toBe(1)
    vfs.writeBytes('/img.bin', new Uint8Array([1, 2, 4]))
    expect(events).toBe(2)
  })
})
