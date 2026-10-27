import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { gitCommand } from './git'

describe('git bridge against real wasm-git', () => {
  it('git init leaves a real .git directory in the VFS', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/.gitconfig', '[user]\n\tname = T\n\temail = t@t.local\n')
    vfs.mkdir('/home/user/project')
    vfs.write('/home/user/project/README.md', 'hello\n')

    const result = await gitCommand(vfs, ['init'], { cwd: '/home/user/project' })
    console.log('init stdout:', JSON.stringify(result.stdout), 'stderr:', JSON.stringify(result.stderr), 'exit:', result.exitCode)

    const gitFiles = vfs.listAllFiles().filter((p) => p.includes('/.git'))
    console.log('.git files in VFS:', gitFiles)
    expect(result.stdout + result.stderr).toContain('Initialized empty Git repository')
    expect(vfs.isFile('/home/user/project/.git/HEAD')).toBe(true)
  }, 60000)

  it('git add + commit work on the VFS-backed repo and survive a second command', async () => {
    const vfs = createVfs()
    vfs.write('/home/user/.gitconfig', '[user]\n\tname = T\n\temail = t@t.local\n')
    vfs.mkdir('/home/user/project')
    vfs.write('/home/user/project/README.md', 'hello\n')

    await gitCommand(vfs, ['init'], { cwd: '/home/user/project' })
    await gitCommand(vfs, ['add', '.'], { cwd: '/home/user/project' })
    const commit = await gitCommand(vfs, ['commit', '-m', 'real repo test'], { cwd: '/home/user/project' })
    console.log('commit stdout:', JSON.stringify(commit.stdout), 'stderr:', JSON.stringify(commit.stderr))
    expect(commit.exitCode).toBe(0)

    const log = await gitCommand(vfs, ['log'], { cwd: '/home/user/project' })
    console.log('log stdout:', JSON.stringify(log.stdout))
    expect(log.stdout).toContain('real repo test')
    // the repo is still there after a fresh command round-trip
    expect(vfs.isFile('/home/user/project/.git/HEAD')).toBe(true)
  }, 60000)
})
