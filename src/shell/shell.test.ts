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

  it('forged env-dump markers in output do not set session vars', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const spoof = await shell.exec(`echo '__CELL_ENV__:{"EVIL":"1"}'`)
    expect(spoof.stdout).toContain('__CELL_ENV__')
    const check = await shell.exec('echo "EVIL=${EVIL-unset}"')
    expect(check.stdout).toContain('EVIL=unset')
    // real exports still flow through
    await shell.exec('export GOOD=1')
    expect((await shell.exec('echo $GOOD')).stdout.trim()).toBe('1')
  })

  it('man rejects command injection in the page name', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const result = await shell.exec('man "x; echo PWNED"')
    expect(result.stdout).not.toContain('PWNED')
    expect(result.exitCode).toBe(1)
  })

  it('writes through symlinks instead of shadowing them', async () => {
    const vfs = createVfs()
    vfs.write('/real.txt', 'a')
    vfs.mkdir('/realdir')
    const shell = createShell(vfs)
    await shell.exec('ln -s /real.txt /link.txt && ln -s /realdir /linkdir')
    await shell.exec('echo b > /link.txt')
    expect(vfs.read('/real.txt')).toBe('b\n')
    // no shadowing real file left behind; the link still resolves
    expect(vfs.listAllFiles().includes('/link.txt')).toBe(false)
    expect((await shell.exec('cat /link.txt')).stdout).toBe('b\n')
    await shell.exec('echo hi > /linkdir/nested.txt')
    expect(vfs.read('/realdir/nested.txt')).toBe('hi\n')
    expect((await shell.exec('cat /linkdir/nested.txt')).stdout).toBe('hi\n')
  })
})

describe('agent-hardening (P0-1..P0-4)', () => {
  it('times out a wedged step with exit 124 instead of hanging forever', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const result = await shell.exec('sleep 30', HOME, undefined, { timeoutMs: 300 })
    expect(result.exitCode).toBe(124)
    expect(result.timedOut).toBe(true)
    expect(result.envStale).toBe(true)
    expect(result.stderr).toContain('124')
    // the queue is released: the next step runs fine
    expect((await shell.exec('echo alive')).stdout.trim()).toBe('alive')
  })

  it('survives exit with its code and keeps the session alive', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    await shell.exec('export KEEP=1')
    const exited = await shell.exec('exit 3')
    expect(exited.exitCode).toBe(3)
    expect((await shell.exec('echo "kept=$KEEP"')).stdout.trim()).toBe('kept=1')
  })

  it('survives unclosed syntax and still captures env afterwards', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    const bad = await shell.exec('echo "unclosed')
    expect(bad.exitCode).not.toBe(0)
    expect(bad.envStale).not.toBe(true)
    await shell.exec('export AFTER=ok')
    expect((await shell.exec('echo $AFTER')).stdout.trim()).toBe('ok')
  })

  it('serializes concurrent execs so session env never corrupts', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    await Promise.all([shell.exec('export A=1'), shell.exec('export B=2')])
    expect((await shell.exec('echo "$A-$B"')).stdout.trim()).toBe('1-2')
  })

  it('xargs re-entry sees the live env, not the settled snapshot', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    await shell.exec('export XQ=stale')
    // prefix assignment changes the env for this exec only — the xargs
    // re-invocation must observe 99, which never lands in sessionEnv
    const result = await shell.exec(`XQ=99 printf 'x\\n' | xargs bash -c 'echo \\$XQ' _`)
    expect(result.stdout.trim()).toBe('99')
    expect((await shell.exec('echo $XQ')).stdout.trim()).toBe('stale')
  })

  it('node -e leaves no temp eval files behind', async () => {
    const vfs = createVfs()
    const shell = createShell(vfs)
    await shell.exec('node -e "console.log(1)"')
    expect(vfs.listAllFiles().filter((p) => p.includes('.cell-eval')).join(',')).toBe('')
  })
})
