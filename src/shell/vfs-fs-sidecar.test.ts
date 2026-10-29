import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { VfsBackedFs } from './vfs-fs'

describe('shared symlink/mode sidecar (P1-5)', () => {
  it('two fs instances on one Vfs share links and modes, persisted to fs-meta.json', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/real.txt', 'data')
    const fsA = new VfsBackedFs(vfs)
    await fsA.symlink('/home/user/real.txt', '/home/user/link.txt')
    await fsA.chmod('/home/user/real.txt', 0o755)

    const fsB = new VfsBackedFs(vfs)
    expect(await fsB.readlink('/home/user/link.txt')).toBe('/home/user/real.txt')
    expect((await fsB.stat('/home/user/real.txt')).mode).toBe(0o755)
    const meta = JSON.parse(vfs.read('/home/user/.cell/fs-meta.json') ?? '{}') as { symlinks?: Record<string, string> }
    expect(meta.symlinks?.['/home/user/link.txt']).toBe('/home/user/real.txt')
  })

  it('a fresh Vfs restored from a snapshot (incl. fs-meta.json) sees the link', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/real.txt', 'data')
    const fsA = new VfsBackedFs(vfs)
    await fsA.symlink('/home/user/real.txt', '/home/user/link.txt')
    const restored = createVfs(vfs.snapshot())
    const fsB = new VfsBackedFs(restored)
    expect(await fsB.readlink('/home/user/link.txt')).toBe('/home/user/real.txt')
  })

  it('rm and mv move/prune sidecar entries (no stale links)', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/real.txt', 'data')
    const fs = new VfsBackedFs(vfs)
    await fs.symlink('/home/user/real.txt', '/home/user/link.txt')
    await fs.mv('/home/user/link.txt', '/home/user/moved.txt')
    expect(await fs.readlink('/home/user/moved.txt')).toBe('/home/user/real.txt')
    await expect(fs.readlink('/home/user/link.txt')).rejects.toThrow()
    await fs.rm('/home/user/moved.txt')
    await expect(fs.readlink('/home/user/moved.txt')).rejects.toThrow()
    // deleting a file via the VFS prunes its sidecar mode via watch;
    // links to it stay in the map and dangle, like real Unix
    await fs.chmod('/home/user/real.txt', 0o755)
    expect((await fs.stat('/home/user/real.txt')).mode).toBe(0o755)
    vfs.delete('/home/user/real.txt')
    vfs.write('/home/user/real.txt', 'data')
    expect((await fs.stat('/home/user/real.txt')).mode).not.toBe(0o755)
  })
})

describe('sidecar reload + shape', () => {
  it('an external fs-meta rewrite reloads the store on the same Vfs', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/a.txt', 'a')
    const fs = new VfsBackedFs(vfs)
    await fs.symlink('/home/user/a.txt', '/home/user/linkA')
    // external reset (cell load shape): meta names linkB only
    vfs.write('/home/user/.cell/fs-meta.json', JSON.stringify({ symlinks: { '/home/user/linkB': '/home/user/a.txt' }, modes: {} }))
    expect(await fs.readlink('/home/user/linkB')).toBe('/home/user/a.txt')
    await expect(fs.readlink('/home/user/linkA')).rejects.toThrow()
  })

  it('corrupt-shape meta loads no bogus links', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/fs-meta.json', '{"symlinks": "oops", "modes": {}}')
    const fs = new VfsBackedFs(vfs)
    await expect(fs.readlink('/home/user/0')).rejects.toThrow()
  })

  it('cross-zone mv moves a symlink as a symlink', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/real.txt', 'data')
    const fs = new VfsBackedFs(vfs)
    await fs.symlink('/home/user/real.txt', '/tmp/lnk')
    await fs.mv('/tmp/lnk', '/home/user/moved-lnk')
    expect(await fs.readlink('/home/user/moved-lnk')).toBe('/home/user/real.txt')
    await expect(fs.readlink('/tmp/lnk')).rejects.toThrow()
  })
})
