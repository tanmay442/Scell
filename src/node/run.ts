import type { Vfs } from '../vfs/types'

export interface NodeRunOptions {
  entry: string
  argv?: string[]
  cwd?: string
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
 * Run one "node process": a fresh V8 worker over a snapshot of the VFS.
 * Worker writes are applied back to the VFS when the process exits, so
 * scaffolders (create-* templates) that write files land in the tree.
 */
export function runNodeProcess(vfs: Vfs, options: NodeRunOptions): Promise<NodeRunResult> {
  const { entry, argv = [], cwd = '/', timeoutMs = 60_000 } = options

  return new Promise<NodeRunResult>((resolve) => {
    const files: Record<string, string> = {}
    const hidden = new Set(options.hidePaths ?? [])
    const decoder = new TextDecoder('utf-8', { fatal: false })
    for (const path of vfs.listAllFiles()) {
      if (hidden.has(path)) continue
      // the sandbox speaks strings: text nodes as-is, binary nodes decoded
      // lossily (scripts must run; a stray .png just becomes mojibake)
      const text = vfs.read(path)
      if (text !== null) {
        files[path] = text
      } else {
        const bytes = vfs.readBytes(path)
        if (bytes !== null) files[path] = decoder.decode(bytes)
      }
    }
    Object.assign(files, options.filesOverride)

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

    const finish = (result: Omit<NodeRunResult, 'stdout' | 'stderr'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
          if (msg.stream === 'stdout') stdout += msg.text
          else stderr += msg.text
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

    worker.postMessage({ type: 'exec', id: 1, files, entry, argv, cwd })
  })
}

export function nodeBinaryReport(): string {
  return 'v24.20.0 (cell — V8 isolate runtime)'
}
