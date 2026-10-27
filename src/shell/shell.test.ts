import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { seedStarterProject } from '../vfs/starter'
import { createShell } from './shell'

const HOME = '/home/user'

/**
 * End-to-end: the REAL just-bash interpreter executing against our VFS with
 * identity paths — bash '/' is VFS '/', HOME is /home/user.
 */
describe('shell over VFS', () => {
  it('echo redirect writes into the VFS at the shell cwd', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const result = await shell.exec('echo hi > note.txt')
    expect(result.exitCode).toBe(0)
    expect(vfs.read(`${HOME}/note.txt`)).toBe('hi\n')
    expect(await shell.exec('cat note.txt')).toMatchObject({ stdout: 'hi\n', exitCode: 0 })
  })

  it('sees VFS files at their real paths', async () => {
    const vfs = createVfs({ '/src/index.ts': 'console.log(1)', '/README.md': '# hi' })
    const shell = createShell(vfs)
    const ls = await shell.exec('ls /')
    expect(ls.stdout).toContain('src')
    expect(ls.stdout).toContain('README.md')
    const cat = await shell.exec('cat /src/index.ts')
    expect(cat.stdout).toContain('console.log(1)')
  })

  it('pipes and grep work', async () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    const shell = createShell(vfs)
    const out = await shell.exec(`cat ${HOME}/project/src/index.ts | grep formatGreeting`)
    expect(out.stdout.toLowerCase()).toContain('formatgreeting')
    const count = await shell.exec('ls /home/user/project | wc -l')
    expect(count.exitCode).toBe(0)
  })

  it('relative paths resolve against the passed cwd', async () => {
    const vfs = createVfs({ '/src/index.ts': 'const x = 1' })
    const shell = createShell(vfs)
    const out = await shell.exec('cat index.ts', '/src')
    expect(out.stdout).toContain('const x = 1')
  })

  it('rm removes VFS files, mkdir creates VFS dirs', async () => {
    const vfs = createVfs({ '/doomed.ts': 'x' })
    const shell = createShell(vfs)
    await shell.exec('rm /doomed.ts')
    expect(vfs.exists('/doomed.ts')).toBe(false)
    await shell.exec('mkdir -p /assets/img')
    expect(vfs.isDir('/assets/img')).toBe(true)
  })

  it('cd ~ resolves to the home directory', async () => {
    const vfs = createVfs({ [`${HOME}/.profile`]: 'export PATH' })
    const shell = createShell(vfs)
    const out = await shell.exec('cat ~/.profile', '/etc')
    expect(out.stdout).toContain('export PATH')
  })

  it('starter home seeds into ~/project with dotfiles', () => {
    const vfs = createVfs()
    seedStarterProject(vfs)
    const files = vfs.listAllFiles().sort()
    expect(files).toContain(`${HOME}/project/README.md`)
    expect(files).toContain(`${HOME}/project/src/broken.ts`)
    expect(files).toContain(`${HOME}/.gitconfig`)
    expect(files).toContain(`${HOME}/.profile`)
    // seeding again must not duplicate or clobber
    seedStarterProject(vfs)
    expect(vfs.listAllFiles().length).toBe(files.length)
  })
})
