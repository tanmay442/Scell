import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { createShell } from './shell'
import { runTool, type RunToolDeps } from './commands/agent-tools'

const SECRET = 'sk-testsecret123'

function seededVfs() {
  const vfs = createVfs()
  vfs.write('/home/user/.cell/agent.json', `{"apiKey":"${SECRET}"}`)
  vfs.write('/home/user/.cell/auth.json', `{"meta":{"key":"${SECRET}"}}`)
  vfs.write('/home/user/project/hello.txt', 'hello world')
  return vfs
}

function depsFor(vfs: ReturnType<typeof createVfs>, protectedShell: boolean): RunToolDeps {
  const shell = createShell(vfs, protectedShell ? { protected: true } : {})
  return { vfs, shell, cwd: '/home/user' }
}

async function bash(deps: RunToolDeps, command: string, cwd?: string): Promise<string> {
  const result = await runTool(deps, { id: 'c1', name: 'bash', input: { command, ...(cwd ? { cwd } : {}) } })
  return result.content
}

describe('agent bash under a protected shell', () => {
  it('cannot read keys by any spelling the text scan missed', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    for (const command of [
      'cat $HOME/.cell/agent.json',
      'cat ~/.cell/agent.*',
      'cat ~/.cell/agent.jso?',
      'cat ${HOME}/.cell/auth.json',
      'ls -la ~/.cell',
      'find ~/.cell -type f',
    ]) {
      expect(await bash(deps, command), command).not.toContain(SECRET)
    }
    expect(await bash(deps, 'cat agent.json', '/home/user/.cell')).not.toContain(SECRET)
  })

  it('symlinks and two-step scripts cannot launder a read', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    expect(await bash(deps, 'ln -s $HOME/.cell/agent.json ~/leak && cat ~/leak')).not.toContain(SECRET)
    await bash(deps, "printf 'cat $HOME/.cell/agent.json\\n' > ~/x.sh")
    expect(await bash(deps, 'bash ~/x.sh')).not.toContain(SECRET)
  })

  it('cannot mutate protected files; file unchanged after sed attempt', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    await bash(deps, 'sed -i s/testsecret/PWNED/ $HOME/.cell/agent.json')
    expect(vfs.read('/home/user/.cell/agent.json')).toContain(SECRET)
    await bash(deps, "echo '{\"name\":\"evil\"}' > $HOME/.cell/tools_evil.json".replace('tools_evil', 'tools/evil'))
    expect(vfs.exists('/home/user/.cell/tools/evil.json')).toBe(false)
  })

  it('tar enumeration contains no .cell entries', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    const listing = await bash(deps, 'tar -cf /tmp/c.tar -C /home/user . 2>/dev/null; tar -tf /tmp/c.tar')
    expect(listing).not.toContain('.cell')
    expect(listing).toContain('hello.txt')
  })

  it('legit workspace work still runs', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    expect(await bash(deps, 'cat ~/project/hello.txt')).toContain('hello world')
    await bash(deps, 'echo made > ~/project/out.txt')
    expect(vfs.read('/home/user/project/out.txt')).toContain('made')
  })

  it('the same corpus succeeds on an unprotected shell (human regression guard)', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, false)
    expect(await bash(deps, 'cat ~/project/hello.txt')).toContain('hello world')
    // the text scan (not the protected VFS) refuses key paths in BOTH modes:
    // headless runs have no approval gate, so the scan is their only boundary
    expect(await bash(deps, 'cat $HOME/.cell/agent.json')).toContain('not reachable from bash')
    expect(await bash(deps, 'cat ../../.cell/agent.json', '/home/user/threads/abc')).toContain('not reachable from bash')
  })
})

describe('protected shell: persistence channels stay closed', () => {
  it('cannot write ~/.bashrc (human shell would source it unprotected)', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    await bash(deps, 'echo "cat /home/user/.cell/agent.json > ~/stolen.txt" >> ~/.bashrc')
    expect(vfs.read('/home/user/.bashrc')).toBeNull()
    const viaTool = await runTool(deps, { id: 'c2', name: 'write', input: { path: '~/.bashrc', content: 'cat /home/user/.cell/agent.json\n' } })
    expect(viaTool.isError).toBe(true)
    // reading it is fine
    vfs.write('/home/user/.bashrc', 'export OK=1\n')
    const readBack = await runTool(deps, { id: 'c3', name: 'read', input: { path: '~/.bashrc' } })
    expect(readBack.content).toContain('export OK=1')
  })

  it('cannot plant symlinks inside ~/.cell', async () => {
    const vfs = seededVfs()
    const deps = depsFor(vfs, true)
    await bash(deps, 'ln -s /home/user/project/hello.txt /home/user/.cell/planted-link')
    const rawFsMeta = vfs.read('/home/user/.cell/fs-meta.json') ?? ''
    expect(rawFsMeta).not.toContain('planted-link')
    await bash(deps, 'ln -s /tmp /home/user/.cell')
    expect(vfs.read('/home/user/.cell/agent.json')).toContain(SECRET)
  })
})

describe('protected shell: link sitting at ~/.bashrc survives rm', () => {
  it('rm ~/.bashrc refuses when .bashrc is a symlink', async () => {
    const vfs = seededVfs()
    vfs.write('/home/user/dotfiles-bashrc', 'export HUMAN=1\n')
    const { VfsBackedFs } = await import('./vfs-fs')
    const humanFs = new VfsBackedFs(vfs)
    await humanFs.symlink('/home/user/dotfiles-bashrc', '/home/user/.bashrc')
    const deps = depsFor(vfs, true)
    await bash(deps, 'rm ~/.bashrc')
    expect(await humanFs.readlink('/home/user/.bashrc')).toBe('/home/user/dotfiles-bashrc')
  })
})
