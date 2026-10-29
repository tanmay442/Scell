import type { ChatEntry } from './agent-store'

export type DisplayEntry = ChatEntry & { resultText?: string }

/** Fold result entries into their tool entry (adjacent, same call). */
export function mergeToolResults(entries: readonly ChatEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = []
  for (const entry of entries) {
    const prev = out[out.length - 1]
    if (entry.kind === 'result' && prev?.kind === 'tool') {
      out[out.length - 1] = { ...prev, resultText: entry.text }
      continue
    }
    out.push(entry)
  }
  return out
}

export type DisplayItem =
  | { kind: 'single'; entry: DisplayEntry }
  | { kind: 'tools'; id: number; entries: DisplayEntry[] }

/** Group consecutive tool entries into one collapsible tool block. */
export function groupItems(entries: readonly ChatEntry[]): DisplayItem[] {
  const merged = mergeToolResults(entries)
  const items: DisplayItem[] = []
  for (const entry of merged) {
    const last = items[items.length - 1]
    if (entry.kind === 'tool' && last?.kind === 'tools') {
      last.entries.push(entry)
      continue
    }
    if (entry.kind === 'tool') {
      items.push({ kind: 'tools', id: entry.id, entries: [entry] })
      continue
    }
    items.push({ kind: 'single', entry })
  }
  return items
}

/**
 * Split assistant text into markdown and html-fenced parts. Line-based:
 * an opening fence is a line that is exactly ```html (any case), the
 * closing fence a line that is exactly ``` — so backticks inside the
 * HTML (JS template literals) cannot truncate the block early.
 */
export function splitHtmlBlocks(text: string): { kind: 'md' | 'html'; text: string }[] {
  const lines = text.split('\n')
  const parts: { kind: 'md' | 'html'; text: string }[] = []
  let md: string[] = []
  let html: string[] | null = null
  const flushMd = () => {
    if (md.length > 0) parts.push({ kind: 'md', text: md.join('\n') })
    md = []
  }
  for (const line of lines) {
    if (html === null && /^```html\s*$/i.test(line.trim())) {
      flushMd()
      html = []
      continue
    }
    if (html !== null && line.trim() === '```') {
      parts.push({ kind: 'html', text: html.join('\n') })
      html = null
      continue
    }
    if (html !== null) html.push(line)
    else md.push(line)
  }
  if (html !== null) parts.push({ kind: 'html', text: html.join('\n') })
  flushMd()
  return parts.length > 0 ? parts : [{ kind: 'md', text }]
}
