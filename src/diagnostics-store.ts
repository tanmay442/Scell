import type { DiagnosticItem } from './events'

/**
 * Latest language-service report, shared between the Problems panel, the
 * status bar counts and the CodeMirror lint decorations. The language
 * service is the only writer; everyone else subscribes. getSnapshot must
 * stay referentially stable between writes for useSyncExternalStore.
 */
let snapshot = { items: [] as readonly DiagnosticItem[], version: 0 }
const subscribers = new Set<() => void>()

export const diagnosticsStore = {
  get(): { items: readonly DiagnosticItem[]; version: number } {
    return snapshot
  },
  set(next: DiagnosticItem[]): void {
    snapshot = { items: next, version: snapshot.version + 1 }
    for (const notify of subscribers) notify()
  },
  subscribe(notify: () => void): () => void {
    subscribers.add(notify)
    return () => subscribers.delete(notify)
  },
}
