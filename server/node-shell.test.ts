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
      const base = resolve(root)
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
