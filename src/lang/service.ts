import { platform } from '../platform'
import { diagnosticsStore } from '../diagnostics-store'
import { mapDiagnostics } from './map'
import type { TsRustDiagnostic } from './types'

const DEBOUNCE_MS = 350

/**
 * The language service: one module worker running ts-rust (TypeScript 7 in
 * WASM). Each check ships the whole workspace as a file map — cheap at MVP
 * scale — and returns structured diagnostics that land in the shared store.
 */
export function startLanguageService(): void {
  const { vfs, bus } = platform()
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

  let requestId = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function check() {
    const id = ++requestId
    const files: Record<string, string> = {}
    for (const path of vfs.listAllFiles()) {
      files[`/project${path}`] = vfs.read(path) ?? ''
    }
    worker.postMessage({ type: 'check', id, files })
  }

  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as
      | { type: 'diagnostics'; id: number; diagnostics: TsRustDiagnostic[] }
      | { type: 'error'; id: number; message: string }
    if (msg.id !== requestId) return // stale response, a newer check is in flight
    if (msg.type === 'diagnostics') {
      const items = mapDiagnostics(msg.diagnostics)
      diagnosticsStore.set(items)
      bus.emit('diagnostics:updated', { diagnostics: items, version: diagnosticsStore.get().version })
    } else {
      bus.emit('app:status', { message: `typechecker: ${msg.message}`.slice(0, 140), tone: 'error' })
    }
  }

  vfs.watch(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(check, DEBOUNCE_MS)
  })

  check()
}
