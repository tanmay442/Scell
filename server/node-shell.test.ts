import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodeShell } from './node-shell'

function hasBash(): boolean {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasBash())('node-shell', () => {
  it('runs echo with stdout and exit 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const result = await shell.exec('echo hello')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a failing exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const result = await shell.exec('exit 3')
      expect(result.exitCode).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps a VFS cwd to the real path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const { realpathSync } = await import('node:fs')
      const base = realpathSync(resolve(root))
      const atRoot = await shell.exec('pwd', '/')
      expect(atRoot.exitCode).toBe(0)
      expect(atRoot.stdout.trim()).toBe(base)
      const inSub = await shell.exec('pwd', '/sub')
      expect(inSub.exitCode).toBe(0)
      expect(inSub.stdout.trim()).toBe(join(base, 'sub'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a cwd through a symlink escaping the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    const outside = mkdtempSync(join(tmpdir(), 'node-shell-out-'))
    try {
      const { symlinkSync, writeFileSync } = await import('node:fs')
      writeFileSync(join(outside, 'secret.txt'), 'HOST-SECRET')
      symlinkSync(outside, join(root, 'link'))
      const shell = createNodeShell(root)
      const result = await shell.exec('cat secret.txt', '/link')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/refused|escapes/)
      expect(result.stdout).not.toContain('HOST-SECRET')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not leak server secrets into the agent environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      process.env.CELL_PROBE_ISOLATION = 'probe-secret-999'
      process.env.CELL_API_TOKENS = 'probe-tokens'
      const shell = createNodeShell(root)
      const leaked = await shell.exec('echo "[$CELL_PROBE_ISOLATION][$CELL_API_TOKENS][$CELL_AGENT_KEY]"')
      expect(leaked.stdout).toBe('[][][]\n')
      const home = await shell.exec('echo $HOME')
      expect(home.stdout.trim()).toBe(resolve(join(root, 'home', 'user')))
    } finally {
      delete process.env.CELL_PROBE_ISOLATION
      delete process.env.CELL_API_TOKENS
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('kills grandchildren on timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const before = await shell.exec('echo grandchild-marker-test')
      expect(before.exitCode).toBe(0)
      const result = await shell.exec(
        "node -e \"require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},30000)\"",
        '/',
        undefined,
        { timeoutMs: 500 },
      )
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(124)
      const { execFileSync } = await import('node:child_process')
      // settle: SIGKILLed orphans may need a tick to be reaped
      let strays = 'x'
      for (let i = 0; i < 20 && strays.trim() !== ''; i++) {
        await new Promise((r) => setTimeout(r, 100))
        try {
          strays = execFileSync('pgrep', ['-f', '[s]leep 30'], { encoding: 'utf8' })
        } catch {
          strays = ''
        }
      }
      expect(strays.trim()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('truncates a single endless line in streamed progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      let progressChars = 0
      // 200KB with no newlines: stored output stays bounded and the
      // streamed line is cut, not forwarded whole
      const result = await shell.exec(`python3 -c "print('x'*200000, end='')"`, '/', (line) => {
        progressChars += line.length
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(progressChars).toBeLessThan(200000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('times out a long sleep with exit 124', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const result = await shell.exec('sleep 5', '/', undefined, { timeoutMs: 200 })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(124)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('node-shell session env', () => {
  it('persists exports across execs on one shell (browser-shell semantics)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const first = await shell.exec('export FOO=persisted-value')
      expect(first.exitCode).toBe(0)
      const second = await shell.exec('echo "[$FOO]"')
      expect(second.stdout).toBe('[persisted-value]\n')
      // separate shells do not share env
      const other = createNodeShell(root)
      const third = await other.exec('echo "[$FOO]"')
      expect(third.stdout).toBe('[]\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not leak the env dump into results or progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-shell-test-'))
    try {
      const shell = createNodeShell(root)
      const seen: string[] = []
      const result = await shell.exec('echo hello', '/', (line) => seen.push(line))
      expect(result.stdout).toBe('hello\n')
      expect(seen.join('')).not.toContain('__CELL_ENV_')
      expect(result.stdout).not.toContain('__CELL_ENV_')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
