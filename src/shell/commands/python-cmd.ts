import type { Vfs } from '../../vfs/types'
import { buildRunPayload } from '../../node/run'
import { looksLikeText } from './git'
import type { CommandResult } from './npm'

/**
 * `python3` / `python` — CPython 3.12 compiled to WebAssembly (Pyodide),
 * running in its own worker with the same contract as the node runtime:
 * workspace snapshot in (node_modules/.git excluded), stdout/stderr
 * streaming, filesystem write-back — so scripts can read project CSVs and
 * drop PNGs into ~/artifacts that show up in the tree.
 *
 * Data-science packages (numpy, pandas, scipy, matplotlib, seaborn, …) load
 * on demand from Pyodide's package index, resolved from the script's imports.
 */

const HOME = '/home/user'
const TIMEOUT_MS = 300_000

function hideInternal(paths: string[]): string[] {
  return paths.filter((p) => p.includes('/node_modules/') || p.includes('/.git/'))
}

export async function pythonCommand(vfs: Vfs, args: string[], opts: { cwd: string; env?: Map<string, string>; stdin?: string; progress?: (line: string) => void }): Promise<CommandResult> {
  if (args[0] === '--version' || args[0] === '-V') {
    return { stdout: 'Python 3.12.7\n', stderr: '', exitCode: 0 }
  }

  let code: string
  let entry: string
  const argv: string[] = []
  // bytes for the PROGRAM's stdin (P0-7). When the program itself comes
  // from stdin (`python -` / bare `python`), stdin is consumed as source
  // and the program gets EOF; otherwise piped bytes flow to input()/read().
  const stdinBytesOf = (text: string): Uint8Array =>
    Uint8Array.from({ length: text.length }, (_, i) => text.charCodeAt(i) & 0xff)
  let programStdin = stdinBytesOf(opts.stdin ?? '')

  if (args[0] === '-c') {
    code = args[1] ?? ''
    if (code === '') return { stdout: '', stderr: 'python: -c: argument required\n', exitCode: 1 }
    entry = '-c'
    argv.push(...args.slice(2))
  } else if (args[0] === '-' || args[0] === undefined) {
    // read the program from stdin (piped scripts)
    // just-bash stdin is a ByteString: one char per byte (latin1)
    const stdinText = opts.stdin ?? ''
    if (stdinText.trim() === '') {
      return {
        stdout: 'Python 3.12.7 (main, Oct  1 2024, 00:00:00) [Wasm SIMD] on linux\nType "help", "copyright", "credits" or "license" for more information.\n',
        stderr: '',
        exitCode: 0,
      }
    }
    code = stdinText
    entry = '-'
    programStdin = new Uint8Array(0)
  } else {
    const scriptArg = args[0]
    entry = scriptArg.startsWith('/') ? scriptArg : `${opts.cwd}/${scriptArg}`.replace(/\/{2,}/g, '/')
    const bytes = vfs.readBytes(entry)
    if (bytes === null) {
      return { stdout: '', stderr: `python: can't open file '${scriptArg}': [Errno 2] No such file or directory\n`, exitCode: 2 }
    }
    code = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    argv.push(...args.slice(1))
  }

  // workspace snapshot minus the heavy machinery
  const hide = hideInternal(vfs.listAllFiles())

  const env: Record<string, string> = {}
  for (const [key, value] of opts.env ?? new Map<string, string>()) {
    if (key !== 'MPLBACKEND') env[key] = value
  }
  if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = '1'

  // ISOLATE-GATE: worker-loader — spawning a nested Worker is how the
  // browser/node gets pyodide off the main thread. On Cloudflare Workers
  // (no nested workers) load python-worker.ts in-isolate instead: the DO
  // already provides tenant isolation, so the extra worker buys nothing.
  // See docs/ISOLATE_SEAM.md.
  let worker: Worker
  try {
    worker = new Worker(new URL('../../python/python-worker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    return { stdout: '', stderr: `python: cannot start the runtime: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }
  }

  const payload = buildRunPayload(vfs, hide)

  return new Promise<CommandResult>((resolve) => {
    let settled = false
    let oomSuspected = false
    const OOM_RE = /out of memory|allocation failed|heap out of memory|\bOOM\b|memory limit/i
    // 4MB cap per stream, head+tail with an explicit receipt (P0-6)
    const HEAD = 3 * 1024 * 1024
    const TAIL = 1 * 1024 * 1024
    const cappedStdout = { head: '', tail: '', total: 0 }
    const cappedStderr = { head: '', tail: '', total: 0 }
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      const box = stream === 'stdout' ? cappedStdout : cappedStderr
      if (OOM_RE.test(text)) oomSuspected = true
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
    const finish = (result: { exitCode: number; timedOut?: boolean }, trailer?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      let stderr = assembled(cappedStderr)
      if (trailer !== undefined) stderr += trailer
      resolve({
        stdout: assembled(cappedStdout),
        stderr,
        exitCode: result.exitCode,
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        ...(oomSuspected ? { oomSuspected: true } : {}),
      })
    }

    // pyodide has no interruption API without SharedArrayBuffer — a wedged
    // script is bounded by terminating the worker (in-flight FS changes lost)
    const timer = setTimeout(() => {
      finish(
        { exitCode: 124, timedOut: true },
        `python: run exceeded ${TIMEOUT_MS / 1000}s — terminated (exit 124)\n`,
      )
    }, TIMEOUT_MS)

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'out'; stream: 'stdout' | 'stderr'; text: string }
        | { type: 'status'; text: string }
        | { type: 'vfs-write'; path: string; bytes: Uint8Array }
        | { type: 'vfs-delete'; path: string }
        | { type: 'exit'; code: number }
      switch (msg.type) {
        case 'out':
          append(msg.stream, msg.text)
          break
        case 'status':
          // loader chatter rides the live progress line, never stderr —
          // 2> captures and agent transcripts must see program output only
          opts.progress?.(msg.text)
          break
        case 'vfs-write': {
          if (!msg.path.startsWith('/')) break
          const copy = new Uint8Array(msg.bytes)
          if (looksLikeText(copy)) vfs.write(msg.path, new TextDecoder().decode(copy))
          else vfs.writeBytes(msg.path, copy)
          break
        }
        case 'vfs-delete': {
          if (msg.path.startsWith('/') && vfs.exists(msg.path)) vfs.delete(msg.path)
          break
        }
        case 'exit':
          finish({ exitCode: msg.code })
          break
      }
    }

    worker.onerror = (event) => {
      const text = `${(event as ErrorEvent).message}\n`
      if (OOM_RE.test(text)) oomSuspected = true
      append('stderr', text)
      finish({ exitCode: 1 })
    }

    // the program's stdin rides alongside the run request (P0-7); just-bash
    // stdin is a latin1 ByteString (one char per byte) — map it back to bytes
    worker.postMessage(
      { type: 'run', id: 1, payload, code, entry, argv, cwd: opts.cwd, env, stdin: programStdin },
      [payload.buffer.buffer as ArrayBuffer],
    )
  })
}
