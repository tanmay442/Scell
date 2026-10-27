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

export async function pythonCommand(vfs: Vfs, args: string[], opts: { cwd: string; env?: Map<string, string>; stdin?: string }): Promise<CommandResult> {
  if (args[0] === '--version' || args[0] === '-V') {
    return { stdout: 'Python 3.12.7\n', stderr: '', exitCode: 0 }
  }

  let code: string
  let entry: string
  const argv: string[] = []

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

  let worker: Worker
  try {
    worker = new Worker(new URL('../../python/python-worker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    return { stdout: '', stderr: `python: cannot start the runtime: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }
  }

  const payload = buildRunPayload(vfs, hide)

  return new Promise<CommandResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let status = ''
    let settled = false
    const MAX_OUTPUT = 4 * 1024 * 1024
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (stream === 'stdout') {
        if (stdout.length < MAX_OUTPUT) stdout = (stdout + text).slice(0, MAX_OUTPUT)
      } else if (stderr.length < MAX_OUTPUT) {
        stderr = (stderr + text).slice(0, MAX_OUTPUT)
      }
    }

    const finish = (result: { exitCode: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      const note = status !== '' ? `\n${status}` : ''
      resolve({ stdout, stderr: stderr + note, exitCode: result.exitCode })
    }

    // pyodide has no interruption API without SharedArrayBuffer — a wedged
    // script is bounded by terminating the worker (in-flight FS changes lost)
    const timer = setTimeout(() => {
      append('stderr', `python: run exceeded ${TIMEOUT_MS / 1000}s — terminated\n`)
      finish({ exitCode: 124 })
    }, TIMEOUT_MS)

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'out'; stream: 'stdout' | 'stderr'; text: string }
        | { type: 'status'; text: string }
        | { type: 'vfs-write'; path: string; bytes: Uint8Array }
        | { type: 'exit'; code: number }
      switch (msg.type) {
        case 'out':
          append(msg.stream, msg.text)
          break
        case 'status':
          status = `${status}${status === '' ? '' : '\n'}${msg.text}`
          break
        case 'vfs-write': {
          if (!msg.path.startsWith('/')) break
          const copy = new Uint8Array(msg.bytes)
          if (looksLikeText(copy)) vfs.write(msg.path, new TextDecoder().decode(copy))
          else vfs.writeBytes(msg.path, copy)
          break
        }
        case 'exit':
          finish({ exitCode: msg.code })
          break
      }
    }

    worker.onerror = (event) => {
      append('stderr', `${(event as ErrorEvent).message}\n`)
      finish({ exitCode: 1 })
    }

    worker.postMessage(
      { type: 'run', id: 1, payload, code, entry, argv, cwd: opts.cwd, env },
      [payload.buffer.buffer as ArrayBuffer],
    )
  })
}
