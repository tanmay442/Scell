import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { vfsToReal } from './disk-vfs'
import type { ShellLike } from '../src/shell/commands/shell-types'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export function createNodeShell(root: string): ShellLike {
  return {
    exec(cmd, cwd, onProgress, opts) {
      const realCwd = vfsToReal(root, cwd ?? '/home/user')
      mkdirSync(realCwd, { recursive: true })
      const timeoutMs = opts?.timeoutMs ?? 120000
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let outTail = ''
        let errTail = ''
        let timedOut = false
        let settled = false

        const push = (chunk: string, store: 'out' | 'err') => {
          const room = MAX_OUTPUT_BYTES - (stdout.length + stderr.length)
          if (room > 0) {
            const kept = chunk.slice(0, room)
            if (store === 'out') stdout += kept
            else stderr += kept
          }
          const tail = store === 'out' ? outTail : errTail
          const merged = tail + chunk
          const parts = merged.split('\n')
          for (let i = 0; i < parts.length - 1; i++) onProgress?.(parts[i])
          if (store === 'out') outTail = parts[parts.length - 1]
          else errTail = parts[parts.length - 1]
        }

        const finish = (exitCode: number) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (outTail !== '') onProgress?.(outTail)
          if (errTail !== '') onProgress?.(errTail)
          resolve(timedOut ? { stdout, stderr, exitCode, timedOut: true } : { stdout, stderr, exitCode })
        }

        // HOME points inside the workspace so `~` expands to the VFS
        // home (/home/user), never the host user's real home
        const child = spawn('bash', ['-c', cmd], {
          cwd: realCwd,
          env: { ...process.env, HOME: vfsToReal(root, '/home/user') },
        })
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => push(chunk, 'out'))
        child.stderr.on('data', (chunk: string) => push(chunk, 'err'))
        child.on('error', (err) => {
          stderr += err instanceof Error ? err.message : String(err)
          finish(127)
        })
        child.on('close', (code) => finish(timedOut ? 124 : (code ?? 1)))

        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
  }
}
