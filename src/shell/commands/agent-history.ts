import { listSessions, loadSession } from './agent-sessions'
import { redactSecrets } from './agent-redact'
import type { Vfs } from '../../vfs/types'

export const MAX_HISTORY_SCANNED = 200

/** Total session files (for the searched-N-of-M receipt). */
export function historySessionCount(vfs: Vfs): number {
  return listSessions(vfs).length
}

/**
 * Cross-thread search: full-text over saved session prompts, titles and
 * turn text, newest sessions first. This is how one bot keeps "all the
 * context" — the answer to "what did we decide about X last week" lives
 * in past threads, and this finds it without resuming them.
 */
export interface HistoryHit {
  sessionId: string
  title: string | null
  startedAt: string | null
  snippet: string
  score: number
}

const SNIPPET_RADIUS = 140

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

export function searchHistory(vfs: Vfs, query: string, limit = 8): HistoryHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const terms = needle.split(/\s+/).filter((t) => t.length > 1)
  if (terms.length === 0) return []
  const files = listSessions(vfs).slice(0, MAX_HISTORY_SCANNED)
  const hits: HistoryHit[] = []
  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    let loaded: ReturnType<typeof loadSession>
    try {
      loaded = loadSession(vfs, id)
    } catch {
      continue
    }
    if ('error' in loaded) continue
    const session = loaded.session
    const texts: string[] = [session.prompt, session.title ?? '']
    for (const turn of session.turns ?? []) {
      if (typeof turn.text === 'string') texts.push(turn.text)
      // tool outputs are searchable too (and redacted below) — errors and
      // command output are the most-asked-about history
      for (const result of turn.toolResults ?? []) {
        if (typeof result.content === 'string') texts.push(result.content)
      }
    }
    const haystack = texts.join('\n')
    const lower = haystack.toLowerCase()
    let score = 0
    let first = -1
    for (const term of terms) {
      let at = lower.indexOf(term)
      let count = 0
      while (at !== -1 && count < 20) {
        count++
        if (first === -1 || at < first) first = at
        at = lower.indexOf(term, at + term.length)
      }
      score += count
    }
    if (score === 0) continue
    // defense in depth: sessions are redacted at save time, but legacy or
    // hand-written files may not be — never surface a raw secret in a hit
    const rawSnippet = first === -1 ? haystack.slice(0, 200).replace(/\s+/g, ' ') : snippetAround(haystack, first)
    hits.push({
      sessionId: id,
      title: session.title ?? null,
      startedAt: session.startedAt ?? null,
      snippet: redactSecrets(rawSnippet),
      score,
    })
  }
  hits.sort((a, b) => b.score - a.score || String(b.startedAt).localeCompare(String(a.startedAt)))
  return hits.slice(0, Math.max(1, Math.min(20, limit)))
}
