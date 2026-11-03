import { listSessions, loadSession } from './agent-sessions'
import { redactSecrets } from './agent-redact'
import type { Vfs } from '../../vfs/types'

export const MAX_HISTORY_SCANNED = 200
/** Single sessions bigger than this are skipped (with a receipt): parsing
 * 200 × 100KB transcripts per keystroke-query is the measured hot path. */
export const MAX_HISTORY_FILE_BYTES = 256 * 1024

/** Total session files (for the searched-N-of-M receipt). */
export function historySessionCount(vfs: Vfs): number {
  return listSessions(vfs).length
}

/** Memoized searches: same query + same session set (by mtime/size)
 * skips re-scoring. Capped — history grows, the cache must not. */
const historyCache = new Map<string, HistoryHit[]>()
const HISTORY_CACHE_MAX = 50
/** sessions skipped by the per-file size cap on the last search (receipt) */
let lastSkippedBig = 0
export function lastHistorySkippedBig(): number {
  return lastSkippedBig
}

function historyFingerprint(vfs: Vfs, files: string[]): string | null {
  try {
    const parts: string[] = []
    for (const file of files) {
      const stat = vfs.stat(`/home/user/.cell/sessions/${file}`)
      if (stat === null) return null
      parts.push(`${file}:${stat.size}:${stat.mtime}`)
    }
    return parts.join(',')
  } catch {
    return null
  }
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
  // memoize exact repeats (same query, unchanged session set): an agent
  // that history_searches in a loop must not re-parse 200 files per turn
  const fingerprint = historyFingerprint(vfs, files)
  const cacheKey = fingerprint === null ? null : `${needle}::${fingerprint}`
  if (cacheKey !== null) {
    const cached = historyCache.get(cacheKey)
    if (cached !== undefined) return cached.slice(0, Math.max(1, Math.min(20, limit)))
  }
  const hits: HistoryHit[] = []
  let skippedBig = 0
  lastSkippedBig = 0
  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    // skip the pathological: a single 100KB tool dump would otherwise
    // dominate every search (receipt appended at the end)
    try {
      const size = vfs.stat(`/home/user/.cell/sessions/${file}`)?.size ?? 0
      if (size > MAX_HISTORY_FILE_BYTES) {
        skippedBig++
        continue
      }
    } catch {
      continue
    }
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
  lastSkippedBig = skippedBig
  const out = hits.slice(0, Math.max(1, Math.min(20, limit)))
  if (cacheKey !== null) {
    if (historyCache.size >= HISTORY_CACHE_MAX) {
      const oldest = historyCache.keys().next()
      if (!oldest.done) historyCache.delete(oldest.value)
    }
    historyCache.set(cacheKey, out)
  }
  return out
}
