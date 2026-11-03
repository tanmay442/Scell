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
  /** worker died under memory pressure, or the crash text says so — the
   *  exit code alone (usually 1) cannot tell OOM from a test failure */
  oomSuspected?: boolean
}

/**
 * The workspace snapshot for a node run: one buffer holding every file's
 * bytes plus an offset index. The buffer TRANSFERS to the worker (zero-copy)
 * — structured-cloning a giant string map froze the tab whenever a real CLI
 * (13MB+ of JavaScript) was installed.
 */
/** index entry: files carry their byte span; dirs (empty dirs invisible to
 * listAllFiles) carry kind 'dir' with a dummy span so runtimes materialize
 * them. Readers that ignore the 4th element keep working unchanged. */
export type RunPayloadEntry = [path: string, offset: number, length: number, kind?: 'file' | 'dir']

export interface RunPayload {
  buffer: Uint8Array
  index: RunPayloadEntry[]
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
  // empty dirs are invisible to listAllFiles, so mkdir-only trees would
  // never reach the worker (open('newdir/f') fails even though the dir
  // exists in the VFS). Emit them explicitly; hidden subtrees stay out.
  const hiddenDir = (dir: string): boolean => {
    for (const h of hidden) {
      if (h === dir || h.startsWith(`${dir}/`)) return true
    }
    return false
  }
  const ancestorWithFile = new Set<string>()
  for (const [path] of index) {
    let dir = path.slice(0, path.lastIndexOf('/')) || '/'
    while (true) {
      ancestorWithFile.add(dir)
      if (dir === '/') break
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    }
  }
  const walkDirs = (dir: string): void => {
    let names: string[]
    try {
      names = vfs.readDir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const child = dir === '/' ? `/${name}` : `${dir}/${name}`
      let isDir = false
      try {
        isDir = vfs.isDir(child)
      } catch {
        continue
      }
      if (isDir && !hiddenDir(child)) {
        if (!ancestorWithFile.has(child)) index.push([child, 0, 0, 'dir'])
        walkDirs(child)
      }
    }
  }
  walkDirs('/')
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

    let settled = false
    const pendingOut: (boolean | string)[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    // 4MB cap per stream, head+tail with an explicit receipt (P0-6): the
    // first 3MB (the failure context that matters) plus the last 1MB
    // (the crash line), never silent middle-dropping.
    const HEAD = 3 * 1024 * 1024
    const TAIL = 1 * 1024 * 1024
    const cappedStdout = { head: '', tail: '', total: 0 }
    const cappedStderr = { head: '', tail: '', total: 0 }
    const appendCapped = (box: { head: string; tail: string; total: number }, text: string) => {
      box.total += text.length
      if (box.head.length < HEAD) {
        const space = HEAD - box.head.length
        box.head += text.slice(0, space)
        text = text.slice(space)
        if (text === '') return
      }
      box.tail += text
      if (box.tail.length > TAIL) box.tail = box.tail.slice(-TAIL)
    }
    const assembled = (box: { head: string; tail: string; total: number }): string => {
      const kept = box.head + box.tail
      const dropped = box.total - kept.length
      if (dropped <= 0) return kept
      return `${box.head}\n… [truncated ${dropped} chars]\n${box.tail}`
    }
    /** OOM looks like exit 1 from the outside — flag the suspicion (P0-5). */
    let oomSuspected = false
    const OOM_RE = /out of memory|allocation failed|heap out of memory|\bOOM\b|memory limit/i
    const scheduleFlush = () => {
      if (flushTimer !== null || settled) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        for (let i = 0; i + 1 < pendingOut.length; i += 2) {
          const text = pendingOut[i + 1] ?? ''
          if (OOM_RE.test(String(text))) oomSuspected = true
          appendCapped(pendingOut[i] === true ? cappedStderr : cappedStdout, String(text))
        }
        pendingOut.length = 0
      }, 40)
    }

    const finish = (result: Omit<NodeRunResult, 'stdout' | 'stderr'>, trailer?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      for (let i = 0; i + 1 < pendingOut.length; i += 2) {
        const text = pendingOut[i + 1] ?? ''
        if (OOM_RE.test(String(text))) oomSuspected = true
        appendCapped(pendingOut[i] === true ? cappedStderr : cappedStdout, String(text))
      }
      pendingOut.length = 0
      // the trailer (timeout/OOM note) appends AFTER truncation so it can
      // never be cut off (P0-5 untruncatable trailer)
      let stdout = assembled(cappedStdout)
      let stderr = assembled(cappedStderr)
      if (trailer !== undefined) stderr += trailer
      worker.terminate()
      resolve({ stdout, stderr, oomSuspected: oomSuspected || undefined, ...result })
    }

    const timer = setTimeout(() => {
      finish(
        { exitCode: 124, timedOut: true },
        `node: run exceeded ${Math.round(timeoutMs / 1000)}s — terminated (exit 124)\n`,
      )
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
      const text = `${(event as ErrorEvent).message}\n`
      if (OOM_RE.test(text)) oomSuspected = true
      appendCapped(cappedStderr, text)
      // drain anything still queued so the crash context is not lost
      for (let i = 0; i + 1 < pendingOut.length; i += 2) {
        appendCapped(pendingOut[i] === true ? cappedStderr : cappedStdout, String(pendingOut[i + 1] ?? ''))
      }
      pendingOut.length = 0
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve({
        stdout: assembled(cappedStdout),
        stderr: assembled(cappedStderr),
        exitCode: 1,
        timedOut: false,
        oomSuspected: oomSuspected || undefined,
      })
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
  return 'v22.14.0'
}
