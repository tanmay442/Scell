import { describe, expect, it } from 'vitest'
import { mapDiagnostics } from './map'
import type { TsRustDiagnostic } from './types'

describe('mapDiagnostics', () => {
  it('maps positions and categories verbatim', () => {
    const items = mapDiagnostics([
      {
        fileName: '/project/src/broken.ts',
        pos: 10,
        end: 24,
        startPosition: { line: 2, character: 7 },
        endPosition: { line: 2, character: 21 },
        code: 2322,
        category: 1,
        text: "Type 'string' is not assignable to type 'number'.",
      },
    ])
    expect(items).toEqual([
      {
        path: '/src/broken.ts',
        code: 2322,
        category: 'error',
        text: "Type 'string' is not assignable to type 'number'.",
        startLine: 2,
        startChar: 7,
        endLine: 2,
        endChar: 21,
      },
    ])
  })

  it('drops diagnostics outside the project root', () => {
    const items = mapDiagnostics([
      { fileName: '/lib.es2022.d.ts', pos: 0, end: 1, code: 1, category: 1, text: 'x' },
      { pos: 0, end: 1, code: 2, category: 1, text: 'project-level, no file' },
    ])
    expect(items).toEqual([])
  })

  it('falls back to line 0 when positions are missing', () => {
    const items = mapDiagnostics([{ fileName: '/project/a.ts', pos: -1, end: -1, code: 1, category: 0, text: 'warn' }])
    expect(items[0]).toMatchObject({ path: '/a.ts', category: 'warning', startLine: 0 })
  })

  it('sorts by file then position', () => {
    const items = mapDiagnostics([
      { fileName: '/project/b.ts', pos: 0, end: 1, code: 1, category: 1, text: 'b1', startPosition: { line: 5, character: 0 } },
      { fileName: '/project/a.ts', pos: 0, end: 1, code: 1, category: 1, text: 'a2', startPosition: { line: 9, character: 0 } },
      { fileName: '/project/a.ts', pos: 0, end: 1, code: 1, category: 1, text: 'a1', startPosition: { line: 2, character: 0 } },
    ])
    expect(items.map((i) => i.text)).toEqual(['a1', 'a2', 'b1'])
  })
})
