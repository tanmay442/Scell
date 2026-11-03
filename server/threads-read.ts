import type { Vfs } from '../src/vfs/types'
import { isValidThreadId, THREADS_DIR } from './bindings'
import { loadSession } from '../src/shell/commands/agent-sessions'

/**
 * Read-only thread browser for the web UI's "On the server" section:
 * Telegram chats, background workers and headless runs never touch the
 * browser VFS, so the UI fetches them here instead. No secrets, no
 * session bytes beyond the transcript — and transcripts are already
 * redacted at save time.
 */
export interface ThreadSummary {
  threadId: string
  /** telegram chat thread | spawned background worker | plain run */
  kind: 'telegram' | 'worker' | 'run'
  sessionId: string | null
  title: string | null
  updatedAt: string | null
  messages: number
  busy: boolean
}

export interface ThreadFile {
  name: string
  size: number
  mtime: number
}

export interface ThreadDetail extends ThreadSummary {
  /** newest-first transcript lines, capped (receipt appended when cut) */
  transcript: string[]
  files: ThreadFile[]
  foldersTruncated: boolean
}

const TRANSCRIPT_CAP = 300
const FILES_CAP = 100

function threadKind(threadId: string): ThreadSummary['kind'] {
  if (threadId.startsWith('tg-') && /-w[0-9a-z]+$/.test(threadId)) return 'worker'
  if (threadId.startsWith('tg-')) return 'telegram'
  return 'run'
}

/** thread dir stem → newest session stem, via the .thread sidecars. */
function sessionByThread(vfs: Vfs): Map<string, { session: string; mtime: number }> {
  const out = new Map<string, { session: string; mtime: number }>()
  let names: string[] = []
  try {
    names = vfs.readDir('/home/user/.cell/sessions')
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.thread')) continue
    const session = name.slice(0, -'.thread'.length)
    let target = ''
    try {
      target = (vfs.read(`/home/user/.cell/sessions/${name}`) ?? '').trim()
    } catch {
      continue
    }
    if (!isValidThreadId(target) || !isValidThreadId(session)) continue
    const stat = vfs.stat(`/home/user/.cell/sessions/${session}.json`)
    const mtime = stat?.mtime ?? 0
    const existing = out.get(target)
    if (existing === undefined || mtime >= existing.mtime) out.set(target, { session, mtime })
  }
  return out
}

export function listThreads(vfs: Vfs, busyIds: string[] = []): ThreadSummary[] | { error: string } {
  let dirs: string[] = []
  try {
    dirs = vfs.isDir(THREADS_DIR) ? vfs.readDir(THREADS_DIR) : []
  } catch {
    return { error: 'cannot list threads' }
  }
  const sessions = sessionByThread(vfs)
  const out: ThreadSummary[] = []
  for (const threadId of dirs.sort()) {
    if (!isValidThreadId(threadId)) continue
    // stray files (a dropped .keep, an editor backup) are not threads —
    // without this check every file becomes an unopenable thread row
    let isDir = false
    try {
      isDir = vfs.isDir(`${THREADS_DIR}/${threadId}`)
    } catch {
      isDir = false
    }
    if (!isDir) continue
    const mapped = sessions.get(threadId) ?? null
    let title: string | null = null
    let messages = 0
    let updatedAt: string | null = null
    let sessionId: string | null = null
    if (mapped !== null) {
      const loaded = loadSession(vfs, mapped.session)
      // sidecar without a session file (or a corrupt one) still lists
      // the thread, but claims no session
      if (!('error' in loaded)) {
        sessionId = mapped.session
        title = loaded.session.title ?? null
        messages = loaded.session.turns.filter((t) => t.role === 'user' || t.role === 'assistant').length
        updatedAt = loaded.session.startedAt ?? null
      }
    }
    out.push({
      threadId,
      kind: threadKind(threadId),
      sessionId,
      title,
      updatedAt,
      messages,
      busy: busyIds.includes(threadId),
    })
  }
  return out
}

export function readThread(vfs: Vfs, threadId: string, busyIds: string[] = []): ThreadDetail | { error: string; code: 400 | 410 } {
  if (!isValidThreadId(threadId)) return { error: `bad thread id '${threadId}'`, code: 400 }
  let isDir = false
  try {
    isDir = vfs.isDir(`${THREADS_DIR}/${threadId}`)
  } catch {
    return { error: 'cannot read thread', code: 400 }
  }
  if (!isDir) return { error: 'thread workspace is gone', code: 410 }
  const summaries = listThreads(vfs, busyIds)
  if ('error' in summaries) return { error: summaries.error, code: 400 }
  const summary = summaries.find((s) => s.threadId === threadId)
  if (!summary) return { error: 'thread workspace is gone', code: 410 }
  let transcript: string[] = []
  if (summary.sessionId !== null) {
    const loaded = loadSession(vfs, summary.sessionId)
    if (!('error' in loaded)) {
      const lines = [...loaded.session.transcript].reverse()
      transcript = lines.slice(0, TRANSCRIPT_CAP)
      if (lines.length > TRANSCRIPT_CAP) transcript.push(`… ${lines.length - TRANSCRIPT_CAP} older lines omitted`)
    }
  }
  const files: ThreadFile[] = []
  let foldersTruncated = false
  try {
    const all = vfs.listAllFiles().filter((p) => p.startsWith(`${THREADS_DIR}/${threadId}/`))
    const scoped: Array<{ path: string; stat: { type: 'file'; size: number; mtime: number } }> = []
    const isFileStat = (stat: { type: string; size: number; mtime: number } | null): stat is { type: 'file'; size: number; mtime: number } =>
      stat !== null && stat.type === 'file'
    // filter FIRST (dotfiles, nested .cell), then cap: filtered entries
    // must not eat FILES_CAP slots, and nested secrets must never list
    for (const path of all) {
      if (path.includes('/.cell/')) continue
      const base = path.split('/').pop() ?? ''
      if (base.startsWith('.') || base === '') continue
      let stat: ReturnType<Vfs['stat']>
      try {
        stat = vfs.stat(path)
      } catch {
        continue
      }
      if (!isFileStat(stat)) continue
      scoped.push({ path, stat })
    }
    scoped.sort((a, b) => b.stat.mtime - a.stat.mtime)
    if (scoped.length > FILES_CAP) foldersTruncated = true
    for (const { path, stat } of scoped.slice(0, FILES_CAP)) {
      files.push({ name: path.slice(`${THREADS_DIR}/${threadId}/`.length), size: stat.size, mtime: stat.mtime })
    }
  } catch {
    foldersTruncated = true
  }
  return { ...summary, transcript, files, foldersTruncated }
}
