import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { canonicalRealPath, vfsToReal } from './disk-vfs'
import type { ShellLike } from '../src/shell/commands/shell-types'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** a single forwarded line never exceeds this; longer lines are cut + receipted */
const MAX_LINE_BYTES = 32 * 1024
/** total bytes forwarded to onProgress per exec; then one receipt, then mute */
const MAX_PROGRESS_BYTES = 4 * 1024 * 1024

/**
 * Agent shells inherit almost nothing: the server's secrets (CELL_*,
 * cloud credentials, host keys) must not be reachable via `echo $…`.
 * Everything else bash needs is set explicitly below.
 */
const PASS_ENV = new Set(['PATH', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ'])

function agentEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USER: 'user', LOGNAME: 'user', SHELL: '/bin/bash' }
  for (const key of PASS_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** SIGKILL a pid plus every descendant, catching escapees that called
 * setsid() out of the timeout's process-group kill. The descendant set is
 * snapshotted BEFORE any killing: orphans reparent to init the moment
 * their parent dies, so a walk-after-kill would miss them. Two passes
 * catch stragglers spawned mid-sweep. Linux-only (/proc); best-effort
 * everywhere else (group kill only). */
function killTree(rootPid: number): void {
  const snapshot = (): Set<number> => {
    const children = new Map<number, number[]>()
    for (const name of readdirSync('/proc')) {
      const pid = Number(name)
      if (!Number.isInteger(pid)) continue
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
        if (!children.has(ppid)) children.set(ppid, [])
        children.get(ppid)!.push(pid)
      } catch {
        // raced exit — ignore
      }
    }
    const seen = new Set<number>([rootPid])
    const stack = [rootPid]
    while (stack.length > 0) {
      const pid = stack.pop()!
      for (const child of children.get(pid) ?? []) {
        if (!seen.has(child)) {
          seen.add(child)
          stack.push(child)
        }
      }
    }
    return seen
  }
  const slay = (pids: Set<number>) => {
    try {
      // negative pid = whole process group (fast path for the common case)
      process.kill(-rootPid, 'SIGKILL')
    } catch {
      // already gone
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  try {
    slay(snapshot())
    slay(snapshot())
  } catch {
    // no /proc (non-Linux): the group kill above is all we have
  }
}

export function createNodeShell(root: string): ShellLike {
  return {
    exec(cmd, cwd, onProgress, opts) {
      // canonicalize BEFORE mkdir: a `mkdir -p` through a symlink planted
      // at the cwd would create directories outside the workspace first
      let realCwd: string
      try {
        realCwd = canonicalRealPath(root, cwd ?? '/home/user')
      } catch (err) {
        return Promise.resolve({
          stdout: '',
          stderr: `refused: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        })
      }
      let home = vfsToReal(root, '/home/user')
      try {
        home = canonicalRealPath(root, '/home/user')
      } catch {
        // home need not exist yet — spawn with the lexical path instead
      }
      mkdirSync(realCwd, { recursive: true })
      const timeoutMs = opts?.timeoutMs ?? 120000
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let outTail = ''
        let errTail = ''
        let timedOut = false
        let settled = false
        let forwardedBytes = 0
        let muted = false
        const receipt = (n: number) => `… [truncated ${n} chars]\n`

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
          for (let i = 0; i < parts.length - 1; i++) {
            let line = parts[i]
            if (line.length > MAX_LINE_BYTES) {
              line = `${line.slice(0, MAX_LINE_BYTES)}${receipt(line.length - MAX_LINE_BYTES)}`.slice(0, -1)
            }
            const bytes = line.length + 1
            if (!muted) {
              if (forwardedBytes + bytes > MAX_PROGRESS_BYTES) {
                muted = true
                onProgress?.(`… [progress muted after ${MAX_PROGRESS_BYTES} bytes — full output in result]\n`)
              } else {
                forwardedBytes += bytes
                onProgress?.(`${line}\n`)
              }
            }
          }
          const last = parts[parts.length - 1]
          if (store === 'out') outTail = last.length > MAX_LINE_BYTES ? last.slice(-MAX_LINE_BYTES) : last
          else errTail = last.length > MAX_LINE_BYTES ? last.slice(-MAX_LINE_BYTES) : last
        }

        const finish = (exitCode: number) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (outTail !== '') onProgress?.(`${outTail}\n`)
          if (errTail !== '') onProgress?.(`${errTail}\n`)
          resolve(timedOut ? { stdout, stderr, exitCode, timedOut: true } : { stdout, stderr, exitCode })
        }

        // detached process group so a timeout SIGKILLs grandchildren too,
        // not just the direct bash child (F6)
        const child = spawn('bash', ['-c', cmd], { cwd: realCwd, env: agentEnv(home), detached: true })
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
          if (child.pid !== undefined) killTree(child.pid)
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
  }
}
