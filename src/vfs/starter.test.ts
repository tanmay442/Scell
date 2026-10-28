import { describe, expect, it } from 'vitest'
import { createVfs } from './vfs'
import { seedStarterProject, ensureStarterProject, migrateStarter, SEED_MARKER } from './starter'

/** the seed tombstone: deliberate wipes must not resurrect the starter */
describe('starter tombstone (P0-9)', () => {
  it('seeding writes the marker', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    expect(vfs.exists(SEED_MARKER)).toBe(true)
  })

  it('a deliberate project wipe stays wiped', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    vfs.delete('/home/user/project')
    ensureStarterProject(vfs)
    expect(vfs.exists('/home/user/project/README.md')).toBe(false)
  })

  it('seeding twice never duplicates or clobbers', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    const files = vfs.listAllFiles().sort()
    seedStarterProject(vfs)
    expect(vfs.listAllFiles().sort()).toEqual(files)
  })

  it('legacy workspaces are adopted, not reseeded', () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/README.md', 'mine')
    vfs.write('/home/user/.gitconfig', 'mine')
    const before = vfs.read('/home/user/project/README.md')
    migrateStarter(vfs)
    ensureStarterProject(vfs)
    expect(vfs.read('/home/user/project/README.md')).toBe(before)
    expect(vfs.exists(SEED_MARKER)).toBe(true)
  })
})
