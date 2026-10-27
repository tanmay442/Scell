import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { seedStarterProject } from '../vfs/starter'
import { createShell } from './shell'

/**
 * End-to-end: the REAL just-bash interpreter executing against our VFS
 * adapter — writes through the shell must land in the VFS and vice versa.
 */
describe('shell over VFS', () => {
  it('echo redirect writes into the VFS', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const result = await shell.exec('echo hi > note.txt')
    expect(result.exitCode).toBe(0)
    expect(vfs.read('/note.txt')).toBe('hi\n')
    expect(await shell.exec('cat note.txt')).toMatchObject({ stdout: 'hi\n', exitCode: 0 })
  })

  it('sees VFS files and lists them', async () => {
    const vfs = createVfs({ '/src/index.ts': 'console.log(1)', '/README.md': '# hi' })
    const shell = createShell(vfs)
    const ls = await shell.exec('ls /workspace')
    expect(ls.stdout).toContain('src')
    expect(ls.stdout).toContain('README.md')
    const cat = await shell.exec('cat /workspace/src/index.ts')
    expect(cat.stdout).toContain('console.log(1)')
  })

  it('pipes and grep work', async () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    const shell = createShell(vfs)
    const out = await shell.exec('cat /workspace/src/index.ts | grep formatGreeting')
    expect(out.stdout.toLowerCase()).toContain('formatgreeting')
    const count = await shell.exec('ls /workspace | wc -l')
    expect(count.exitCode).toBe(0)
  })

  it('relative paths resolve against the passed cwd', async () => {
    const vfs = createVfs({ '/src/index.ts': 'const x = 1' })
    const shell = createShell(vfs)
    const out = await shell.exec('cat index.ts', '/workspace/src')
    expect(out.stdout).toContain('const x = 1')
  })

  it('rm removes VFS files, mkdir creates VFS dirs', async () => {
    const vfs = createVfs({ '/doomed.ts': 'x' })
    const shell = createShell(vfs)
    await shell.exec('rm doomed.ts')
    expect(vfs.exists('/doomed.ts')).toBe(false)
    await shell.exec('mkdir -p assets/img')
    expect(vfs.isDir('/assets/img')).toBe(true)
  })

  it('starter project is complete', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    expect(vfs.listAllFiles().sort()).toEqual(
      ['/README.md', '/package.json', '/src/broken.ts', '/src/index.ts', '/src/utils.ts', '/tsconfig.json'].sort(),
    )
    // seeding again must not duplicate or clobber
    seedStarterProject(vfs)
    expect(vfs.listAllFiles().length).toBe(6)
  })
})
