import type { VfsEvent } from './vfs/types'

/**
 * App-wide diagnostics produced by the language service (ts-rust wasm).
 * Positions are UTF-16 line/character, 0-based — they map directly onto
 * CodeMirror positions and LSP-style coordinates.
 */
export interface DiagnosticItem {
  path: string
  code: number | string
  category: 'error' | 'warning' | 'suggestion' | 'message'
  text: string
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export interface AppEvents {
  'vfs:changed': VfsEvent
  'editor:open': { path: string }
  'diagnostics:updated': { diagnostics: DiagnosticItem[]; version: number }
  'terminal:cwd': { cwd: string }
  'app:status': { message: string; tone: 'info' | 'ok' | 'error' }
  'app:ready': Record<string, never>
}

type Handler<T> = (payload: T) => void

/** Minimal typed pub/sub. One instance lives on the Platform. */
export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>()

  on<K extends keyof AppEvents>(event: K, handler: Handler<AppEvents[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as Handler<never>)
    return () => set.delete(handler as Handler<never>)
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    const set = this.handlers.get(event)
    if (set) for (const h of set) (h as Handler<AppEvents[K]>)(payload)
  }
}
