import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { diagnosticsStore } from '../diagnostics-store'
import type { DiagnosticItem } from '../events'

function toCmDiagnostic(d: DiagnosticItem, doc: EditorView['state']['doc']): CmDiagnostic {
  const lastLine = doc.lines
  const startLine = Math.min(Math.max(0, d.startLine), lastLine - 1)
  const endLine = Math.min(Math.max(d.endLine, startLine), lastLine - 1)
  const startText = doc.line(startLine + 1)
  const endText = doc.line(endLine + 1)
  const from = startText.from + Math.min(d.startChar, startText.text.length)
  const to = Math.max(
    from + 1,
    endText.from + Math.min(d.endChar, endText.text.length),
  )
  return {
    from,
    to,
    severity: d.category === 'error' ? 'error' : d.category === 'warning' ? 'warning' : 'info',
    message: `${d.text} (TS${d.code})`,
  }
}

/**
 * CodeMirror lint source bound to one file, fed by the shared diagnostics
 * store. Recomputed when the store version changes because the extension
 * array is rebuilt per version (see CodeEditor); the source clamps the
 * (possibly stale) positions to the live document.
 */
export function diagnosticsLinter(path: string): Extension {
  return linter((view: EditorView) => {
    const { items } = diagnosticsStore.get()
    return items.filter((d) => d.path === path).map((d) => toCmDiagnostic(d, view.state.doc))
  })
}

export const diagnosticGutter: Extension = lintGutter()
