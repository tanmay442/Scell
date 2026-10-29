import { platform } from '../platform'
import { isProtectedPath } from '../vfs/protected-paths'
import { diagnosticsStore } from '../diagnostics-store'
import { mapDiagnostics } from './map'
import type { TsRustDiagnostic } from './types'

const DEBOUNCE_MS = 350

export interface TscRunResult {
  exitCode: number
  diagnostics: TsRustDiagnostic[]
  /** every file after the run, emitted ones included */
  files: Map<string, string>
}

/**
 * The language service: one module worker running ts-rust (TypeScript 7 in
 * WASM). Two message kinds: 'check' (debounced diagnostics for the editor)
 * and 'tsc' (one-shot CLI-style run — the `tsc` command and TS→JS emit for
 * `node` both go through it).
 */
class LanguageService {
  private worker: Worker
  private requestId = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingTsc = new Map<number, { resolve: (r: TscRunResult) => void; reject: (e: Error) => void }>()

  constructor(private vfs = platform().vfs) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'diagnostics'; id: number; diagnostics: TsRustDiagnostic[] }
        | { type: 'error'; id: number; message: string }
        | { type: 'tsc-result'; id: number; exitCode: number; diagnostics: TsRustDiagnostic[]; files: [string, string][] }
        | { type: 'tsc-error'; id: number; message: string }
      if (msg.id !== this.requestId && msg.type !== 'tsc-result' && msg.type !== 'tsc-error') {
        // a stale check response while a newer one is in flight — still
        // publishable: it reflects a recent state. But drop it if newer ran.
        if (msg.type === 'diagnostics' && msg.id < this.requestId) return
      }
      if (msg.type === 'diagnostics') {
        const items = mapDiagnostics(msg.diagnostics)
        diagnosticsStore.set(items)
        platform().bus.emit('diagnostics:updated', { diagnostics: items, version: diagnosticsStore.get().version })
      } else if (msg.type === 'error') {
        platform().bus.emit('app:status', { message: `typechecker: ${msg.message}`.slice(0, 140), tone: 'error' })
      } else if (msg.type === 'tsc-result') {
        this.pendingTsc.get(msg.id)?.resolve({ exitCode: msg.exitCode, diagnostics: msg.diagnostics, files: new Map(msg.files) })
        this.pendingTsc.delete(msg.id)
      } else if (msg.type === 'tsc-error') {
        this.pendingTsc.get(msg.id)?.reject(new Error(msg.message))
        this.pendingTsc.delete(msg.id)
      }
    }

    this.vfs.watch(() => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.check(), DEBOUNCE_MS)
    })
    this.check()
  }

  private textFiles(): Record<string, string> {
    const files: Record<string, string> = {}
    // node_modules and .git are never typechecked — shipping a freshly
    // installed 100MB CLI to the checker on every keystroke kills the tab
    for (const path of this.vfs.listAllFiles()) {
      // ~/.cell never reaches the checker (keys, sessions, agent config)
      if (isProtectedPath(path)) continue
      if (path.includes('/node_modules/') || path.includes('/.git/')) continue
      const text = this.vfs.read(path)
      if (text !== null) files[`/project${path}`] = text
    }
    return files
  }

  private check() {
    const id = ++this.requestId
    this.worker.postMessage({ type: 'check', id, files: this.textFiles() })
  }

  tscRun(args: string[], extraFiles: Record<string, string> = {}, timeoutMs = 120_000): Promise<TscRunResult> {
    const id = ++this.requestId
    const files = { ...extraFiles, ...this.textFiles() }
    return new Promise<TscRunResult>((resolve, reject) => {
      // a wedged typechecker worker must fail loudly, not hang the shell
      // (and the terminal with it) forever
      const timer = setTimeout(() => {
        this.pendingTsc.delete(id)
        reject(new Error(`tsc: typechecker timed out after ${timeoutMs / 1000}s — reload the tab to restart it`))
      }, timeoutMs)
      this.pendingTsc.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.worker.postMessage({ type: 'tsc', id, args, files })
    })
  }
}

let service: LanguageService | null = null

export function startLanguageService(): LanguageService {
  if (!service) service = new LanguageService()
  return service
}

/** Access the running service (null before boot or in tests). */
export function langService(): LanguageService | null {
  return service
}
