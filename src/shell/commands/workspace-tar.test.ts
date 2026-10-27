import { describe, expect, it } from 'vitest'
import { tarFiles, untar } from './untar'
import { createVfs, ensureStarterProject, seedStarterProject } from '../../vfs'

describe('tarFiles + untar round-trip', () => {
  it('round-trips text, binary, empty and long paths', () => {
    const longDir = '/home/user/project/node_modules/very/deeply/nested/package/with/a/really/long/name/that/exceeds/hundred'
    const files = [
      { path: '/home/user/project/a.ts', data: new TextEncoder().encode('export const x = 1\n') },
      { path: '/home/user/project/img.png', data: new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x01, 0x02]) },
      { path: '/home/user/empty.txt', data: new Uint8Array(0) },
      { path: `${longDir}/index.js`, data: new TextEncoder().encode('// deep\n') },
    ]
    const tar = tarFiles(files)
    const entries = untar(tar).filter((entry) => entry.type === 'file')
    const byPath = new Map(entries.map((entry) => [entry.path, entry.data]))
    expect(byPath.size).toBe(4)
    expect(new TextDecoder().decode(byPath.get('/home/user/project/a.ts')!)).toBe('export const x = 1\n')
    expect([...byPath.get('/home/user/project/img.png')!]).toEqual([0x89, 0x50, 0x00, 0xff, 0x01, 0x02])
    expect(byPath.get('/home/user/empty.txt')!.byteLength).toBe(0)
    expect(new TextDecoder().decode(byPath.get(`${longDir}/index.js`)!)).toBe('// deep\n')
  })
})

describe('ensureStarterProject healing', () => {
  it('seeds a broken dotfiles-only workspace', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.gitconfig', '[user]\n')
    vfs.write('/home/user/.profile', 'x')
    ensureStarterProject(vfs)
    expect(vfs.read('/home/user/project/README.md')).not.toBeNull()
    expect(vfs.read('/home/user/project/src/index.ts')).not.toBeNull()
  })

  it('never reseeds when real user content exists', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.gitconfig', '[user]\n')
    vfs.write('/home/user/repos/clone-a/README.md', 'user work')
    ensureStarterProject(vfs)
    expect(vfs.exists('/home/user/project')).toBe(false)
  })

  it('does nothing when the project is already there', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    vfs.write('/home/user/project/README.md', '# my custom readme')
    ensureStarterProject(vfs)
    expect(vfs.read('/home/user/project/README.md')).toBe('# my custom readme')
  })
})
