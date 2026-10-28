import type { Vfs } from '../vfs/types'

export interface NodeRunOptions {
  entry: string
  argv?: string[]
  cwd?: string
  /** the calling shell session's environment (exports included) */
  env?: Record<string, string>
  /** extra/overridden files (e.g. TS→JS emit output), VFS paths */
  filesOverride?: Record<string, string>
  /** files to hide from the sandbox (e.g. original .ts sources after emit) */
  hidePaths?: string[]
  timeoutMs?: number
}

export interface NodeRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/**
 * The workspace snapshot for a node run: one buffer holding every file's
 * bytes plus an offset index. The buffer TRANSFERS to the worker (zero-copy)
 * — structured-cloning a giant string map froze the tab whenever a real CLI
 * (13MB+ of JavaScript) was installed.
 */
export interface RunPayload {
  buffer: Uint8Array
  index: [path: string, offset: number, length: number][]
}

export function buildRunPayload(
  vfs: Vfs,
  hidePaths: string[] = [],
  filesOverride: Record<string, string> = {},
): RunPayload {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const index: RunPayload['index'] = []
  let offset = 0
  const add = (path: string, bytes: Uint8Array) => {
    parts.push(bytes)
    index.push([path, offset, bytes.byteLength])
    offset += bytes.byteLength
  }
  const hidden = new Set(hidePaths)
  for (const path of vfs.listAllFiles()) {
    if (hidden.has(path)) continue
    const text = vfs.read(path)
    if (text !== null) add(path, encoder.encode(text))
    else {
      const bytes = vfs.readBytes(path)
      if (bytes !== null) add(path, bytes)
    }
  }
  for (const [path, content] of Object.entries(filesOverride)) add(path, encoder.encode(content))
  const buffer = new Uint8Array(offset)
  let position = 0
  for (const part of parts) {
    buffer.set(part, position)
    position += part.byteLength
  }
  return { buffer, index }
}

/**
 * Run one "node process": a fresh V8 worker over a snapshot of the VFS.
 * Worker writes are applied back to the VFS when the process exits, so
 * scaffolders (create-* templates) that write files land in the tree.
 */
export function runNodeProcess(vfs: Vfs, options: NodeRunOptions): Promise<NodeRunResult> {
  const { entry, argv = [], cwd = '/', timeoutMs = 300_000 } = options

  return new Promise<NodeRunResult>((resolve) => {
    const payload = buildRunPayload(vfs, options.hidePaths ?? [], options.filesOverride ?? {})

    let worker: Worker
    try {
      worker = new Worker(new URL('./runtime-worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `node: cannot start the runtime isolate: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
        timedOut: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const pendingOut: (boolean | string)[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const MAX_OUTPUT = 4 * 1024 * 1024
    const scheduleFlush = () => {
      if (flushTimer !== null || settled) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        for (let i = 0; i + 1 < pendingOut.length; i += 2) {
          const text = pendingOut[i + 1] ?? ''
          if (pendingOut[i] === true) {
            if (stderr.length < MAX_OUTPUT) stderr = (stderr + text).slice(0, MAX_OUTPUT)
          } else if (stdout.length < MAX_OUTPUT) {
            stdout = (stdout + text).slice(0, MAX_OUTPUT)
          }
        }
        pendingOut.length = 0
      }, 40)
    }

    const finish = (result: Omit<NodeRunResult, 'stdout' | 'stderr'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      for (let i = 0; i + 1 < pendingOut.length; i += 2) {
        const text = pendingOut[i + 1] ?? ''
        if (pendingOut[i] === true) {
          if (stderr.length < MAX_OUTPUT) stderr = (stderr + text).slice(0, MAX_OUTPUT)
        } else if (stdout.length < MAX_OUTPUT) {
          stdout = (stdout + text).slice(0, MAX_OUTPUT)
        }
      }
      pendingOut.length = 0
      worker.terminate()
      resolve({ stdout, stderr, ...result })
    }

    const timer = setTimeout(() => {
      finish({ exitCode: 124, timedOut: true })
    }, timeoutMs)

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'out'; id: number; stream: 'stdout' | 'stderr'; text: string }
        | { type: 'vfs-write'; id: number; path: string; content: string }
        | { type: 'vfs-delete'; id: number; path: string }
        | { type: 'exit'; id: number; code: number }
      switch (msg.type) {
        case 'out':
          // CLIs emit spinner frames character-by-character; appending per
          // message plus React re-renders froze the tab. Coalesce to a
          // trickle and cap the buffers so a chatty process can't OOM us.
          pendingOut.push(msg.stream === 'stderr', msg.text)
          scheduleFlush()
          break
        case 'vfs-write':
          if (msg.path.startsWith('/')) vfs.write(msg.path, msg.content)
          break
        case 'vfs-delete':
          if (msg.path.startsWith('/')) vfs.delete(msg.path)
          break
        case 'exit':
          finish({ exitCode: msg.code, timedOut: false })
          break
      }
    }

    worker.onerror = (event) => {
      stderr += `${(event as ErrorEvent).message}\n`
      finish({ exitCode: 1, timedOut: false })
    }

    // process.env, most-specific last: defaults in the worker < ~/.cell/env.json
    // (API keys and friends) < the shell session's exports — like inheriting
    // a real interactive shell's environment
    let env: Record<string, string> | undefined
    const envRaw = vfs.read('/home/user/.cell/env.json')
    if (envRaw !== null) {
      try {
        const parsed = JSON.parse(envRaw) as Record<string, unknown>
        env = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') env[key] = value
        }
      } catch {
        // malformed env file — run with defaults
      }
    }
    if (options.env !== undefined) {
      env = { ...(env ?? {}), ...options.env }
    }
    worker.postMessage({ type: 'exec', id: 1, payload, entry, argv, cwd, env }, [payload.buffer.buffer as ArrayBuffer])
  })
}

export function nodeBinaryReport(): string {
  return 'v24.20.0 (cell — V8 isolate runtime)'
}
