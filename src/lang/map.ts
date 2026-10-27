import type { DiagnosticItem } from '../events'
import type { TsRustDiagnostic } from './types'

const PROJECT_ROOT = '/project'

const CATEGORY = {
  0: 'warning',
  1: 'error',
  2: 'suggestion',
  3: 'message',
} as const

/**
 * Map ts-rust diagnostics (files under /project) to Cell DiagnosticItems.
 * Positions arrive as zero-based UTF-16 line/character — the same coordinate
 * system CodeMirror uses, so they pass through untouched.
 */
export function mapDiagnostics(diags: TsRustDiagnostic[]): DiagnosticItem[] {
  const items: DiagnosticItem[] = []
  for (const d of diags) {
    if (!d.fileName || !d.fileName.startsWith(`${PROJECT_ROOT}/`)) continue
    const start = d.startPosition ?? { line: 0, character: 0 }
    const end = d.endPosition ?? { line: start.line, character: start.character + 1 }
    items.push({
      path: d.fileName.slice(PROJECT_ROOT.length),
      code: d.source ? `${d.source}-${d.code}` : d.code,
      category: CATEGORY[d.category],
      text: d.text,
      startLine: start.line,
      startChar: start.character,
      endLine: end.line,
      endChar: end.character,
    })
  }
  items.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.startChar - b.startChar)
  return items
}
