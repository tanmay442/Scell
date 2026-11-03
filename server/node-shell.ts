import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { canonicalRealPath, vfsToReal } from './disk-vfs'
import type { ShellLike } from '../src/shell/commands/shell-types'

// 8MB is a memory bound, not a user-facing limit: the stored text is cut
// silently here, but every consumer (agent tools, job logs) applies its own
// head+tail truncation with an explicit receipt before showing anything
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
  // session environment: exports persist across execs on one shell instance
  // (browser-shell semantics), seeded from the allowlisted process env.
  // Captured in-band after every command (see below); a command that kills
  // the shell early simply leaves the previous environment in place.
  let sessionEnv: Record<string, string> | null = null
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
      if (sessionEnv === null) sessionEnv = agentEnv(home)
      else sessionEnv.HOME = home
      // local copy: TS cannot narrow the mutable outer binding inside closures
      const env: Record<string, string> = sessionEnv
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
        // env-dump suppression: everything from the marker on is shell
        // bookkeeping, not command output — hold it back from progress
        let envMuted = false
        const receipt = (n: number) => `… [truncated ${n} chars]\n`

        // unique per exec so command output containing an older marker
        // cannot cut the stream early
        const marker = `__CELL_ENV_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}__`
        const wrapped = `{ ${cmd}; } ; printf '\\n%s\\n' '${marker}'; env -0`

        const push = (chunk: string, store: 'out' | 'err') => {
          // store everything (the env dump is recovered at finish); only
          // user output is forwarded to progress
          const room = MAX_OUTPUT_BYTES - (stdout.length + stderr.length)
          if (room > 0) {
            const keptRoom = chunk.slice(0, room)
            if (store === 'out') stdout += keptRoom
            else stderr += keptRoom
          }
          if (envMuted) return
          const prevTail = store === 'out' ? outTail : errTail
          const merged = prevTail + chunk
          const at = merged.indexOf(`\n${marker}\n`)
          let forward = merged
          if (at !== -1) {
            envMuted = true
            forward = merged.slice(0, at)
          }
          const parts = forward.split('\n')
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

        /** strip the in-band env dump, returning clean output + the dump */
        const stripEnvDump = (text: string): { clean: string; dump: string | null } => {
          const at = text.lastIndexOf(`\n${marker}\n`)
          if (at === -1) return { clean: text, dump: null }
          return { clean: text.slice(0, at), dump: text.slice(at + marker.length + 2) }
        }

        const finish = (exitCode: number) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const strippedOut = stripEnvDump(stdout)
          const strippedErr = stripEnvDump(stderr)
          stdout = strippedOut.clean
          stderr = strippedErr.clean
          const dump = strippedOut.dump ?? strippedErr.dump
          if (dump !== null) {
            const next: Record<string, string> = {}
            for (const entry of dump.split('\0')) {
              const eq = entry.indexOf('=')
              if (eq > 0) next[entry.slice(0, eq)] = entry.slice(eq + 1)
            }
            // never adopt a poisoned HOME; the workspace home always wins
            delete next.HOME
            sessionEnv = { ...(sessionEnv ?? {}), ...next }
          }
          // tails were tracked on raw output — recompute from clean output
          // so the env block never leaks into progress or results
          const cleanTail = (text: string): string => {
            const lines = text.split('\n')
            const last = lines[lines.length - 1]
            return last.length > MAX_LINE_BYTES ? last.slice(-MAX_LINE_BYTES) : last
          }
          outTail = cleanTail(stdout)
          errTail = cleanTail(stderr)
          if (outTail !== '') onProgress?.(`${outTail}\n`)
          if (errTail !== '') onProgress?.(`${errTail}\n`)
          resolve(timedOut ? { stdout, stderr, exitCode, timedOut: true } : { stdout, stderr, exitCode })
        }

        // detached process group so a timeout SIGKILLs grandchildren too,
        // not just the direct bash child
        const child = spawn('bash', ['-c', wrapped], { cwd: realCwd, env, detached: true })
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
