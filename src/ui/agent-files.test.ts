import { describe, expect, it } from 'vitest'
import { splitFileRefs, fileKind } from './agent-files'

const existing = new Set(['/home/user/threads/t1/artifacts/chart.html', '/home/user/threads/t1/plots/p.png'])
const resolve = (candidate: string): string | null => {
  if (candidate.startsWith('~/')) {
    const abs = `/home/user${candidate.slice(1)}`
    return existing.has(abs) ? abs : null
  }
  if (candidate.startsWith('/')) return existing.has(candidate) ? candidate : null
  const inWorkspace = `/home/user/threads/t1/${candidate}`
  if (existing.has(inWorkspace)) return inWorkspace
  for (const path of existing) if (path.endsWith(`/${candidate}`)) return path
  return null
}

describe('splitFileRefs', () => {
  it('explicit cell-file links always linkify', () => {
    const parts = splitFileRefs('see [the chart](cell-file:/home/user/x/y.html) now', resolve)
    expect(parts).toEqual([
      { kind: 'md', text: 'see ' },
      { kind: 'file', path: '/home/user/x/y.html', label: 'the chart' },
      { kind: 'md', text: ' now' },
    ])
  })

  it('absolute and tilde paths linkify only when they resolve', () => {
    const yes = splitFileRefs('saved to /home/user/threads/t1/artifacts/chart.html ok', resolve)
    expect(yes[1]).toEqual({ kind: 'file', path: '/home/user/threads/t1/artifacts/chart.html', label: 'chart.html' })
    const no = splitFileRefs('saved to /home/user/nope/missing.html ok', resolve)
    expect(no).toEqual([{ kind: 'md', text: 'saved to /home/user/nope/missing.html ok' }])
    const tilde = splitFileRefs('at ~/threads/t1/artifacts/chart.html', resolve)
    expect(tilde[1]).toEqual({ kind: 'file', path: '/home/user/threads/t1/artifacts/chart.html', label: 'chart.html' })
  })

  it('relative paths and inline-code filenames resolve against the workspace', () => {
    const rel = splitFileRefs('wrote artifacts/chart.html for you', resolve)
    expect(rel[1]).toEqual({ kind: 'file', path: '/home/user/threads/t1/artifacts/chart.html', label: 'chart.html' })
    const code = splitFileRefs('- `p.png` — 86KB OK', resolve)
    expect(code[1]).toEqual({ kind: 'file', path: '/home/user/threads/t1/plots/p.png', label: 'p.png' })
  })

  it('plain text passes through untouched', () => {
    expect(splitFileRefs('no files here, just words.md in prose', resolve)).toEqual([
      { kind: 'md', text: 'no files here, just words.md in prose' },
    ])
  })
})

describe('fileKind', () => {
  it('classifies previews', () => {
    expect(fileKind('a/b.png')).toBe('image')
    expect(fileKind('a/b.html')).toBe('html')
    expect(fileKind('a/b.py')).toBe('text')
    expect(fileKind('a/b.zip')).toBe('other')
  })
})
