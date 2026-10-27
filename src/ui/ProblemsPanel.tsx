import { useSyncExternalStore } from 'react'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import { diagnosticsStore } from '../diagnostics-store'
import { workspaceActions } from './workspace-store'
import type { DiagnosticItem } from '../events'

export function ProblemsPanel() {
  const { items } = useSyncExternalStore(diagnosticsStore.subscribe, diagnosticsStore.get)

  if (items.length === 0) {
    return (
      <div className="panel-fallback">
        No problems found. The ts-rust typechecker (TypeScript 7 in WASM) reports here after you save — try editing
        <button className="linkish" onClick={() => workspaceActions.openFile('/src/broken.ts')}>
          src/broken.ts
        </button>
        .
      </div>
    )
  }

  const byFile = new Map<string, DiagnosticItem[]>()
  for (const item of items) {
    const list = byFile.get(item.path)
    if (list) list.push(item)
    else byFile.set(item.path, [item])
  }

  return (
    <div className="problems-list">
      {[...byFile.entries()].map(([path, list]) => (
        <div key={path}>
          <div className="problems-file">{path}</div>
          {list.map((d, i) => (
            <button
              key={`${d.code}-${i}`}
              className="problems-row"
              onClick={() => workspaceActions.openFile(d.path, d.startLine + 1)}
            >
              {d.category === 'error' ? (
                <CircleAlert size={13} className="problem-error" />
              ) : (
                <TriangleAlert size={13} className="problem-warning" />
              )}
              <span className="problems-text">{d.text}</span>
              <span className="problems-meta">
                TS{d.code} · {d.startLine + 1}:{d.startChar + 1}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
