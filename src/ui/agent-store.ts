import { platform } from '../platform'
import { createShell } from '../shell/shell'
import { runAgent, generateSessionTitle, COMPACT_AT_CHARS } from '../shell/commands/agent'
import type { SessionTurn } from '../shell/commands/agent-sessions'
import { listSessions, loadSession, saveSession, sessionId } from '../shell/commands/agent-sessions'
import { loadSkills } from '../shell/commands/agent-skills'
import { registryEntries, type ToolCall } from '../shell/commands/agent-tools'
import { projectRoot } from '../shell/commands/install'
import { scopeVfs } from '../vfs/scope'
import { getActivePath } from './workspace-store'

/**
 * Agent state for the Agent home (front door). Module-level store:
 * referentially stable snapshots, subscribe/notify, plain actions.
 *
 * Every thread (session) is independent: it has its own workspace
 * folder (~/threads/<id>/), its own live entries, and its own run.
 * Switching threads — or leaving for the Workspace IDE — never stops
 * a run; runs finish in the background and their sessions persist.
 */

export interface ChatEntry {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'note' | 'visual'
  text: string
  name?: string
  status?: 'running' | 'complete' | 'error'
}

export interface AgentConfigForm {
  provider: string
  model: string
  apiKey: string
  baseURL: string
  permission: string
  thinking: string
}

export interface SessionInfo {
  id: string
  label: string
  title?: string
  pinned?: boolean
  archived?: boolean
  locked?: boolean
  /** previous run was interrupted (tab died mid-run); cleared on open */
  interrupted?: boolean
}



interface AgentSnapshot {
  entries: readonly ChatEntry[]
  running: boolean
  activeLocked: boolean
  keyAvailable: boolean
  pendingSummary: string | null
  pendingCount: number
  /** a thread (maybe not the visible one) is waiting on an approval */
  pendingGlobal: { threadId: string; summary: string } | null
  runningIds: readonly string[]
  sessions: readonly SessionInfo[]
  skills: readonly { name: string; description: string }[]
  tools: readonly string[]
  contextChars: number
  sessionId: string | null
  config: AgentConfigForm
  savedNote: string
  draft: string
  version: number
}

const CONFIG_PATH = '/home/user/.cell/agent.json'
const HOME = '/home/user'
const EMPTY_FORM: AgentConfigForm = { provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: '', baseURL: '', permission: 'full', thinking: 'xhigh' }

/** Each thread works in its own workspace folder. */
export function threadWorkspace(id: string): string {
  return `${HOME}/threads/${id}`
}

// ---- per-thread state ------------------------------------------------------

interface ApprovalEntry {
  summary: string
  resolve: (allowed: boolean) => void
}

interface ThreadState {
  id: string
  entries: ChatEntry[]
  /** artifact path -> entry id of its latest in-thread visual; a
   * re-written artifact updates that entry in place (it re-reads the
   * file on render) instead of stacking a new visual per version */
  visualEntryByPath: Map<string, number>
  running: boolean
  abort: AbortController | null
  approvals: ApprovalEntry[]
  approvalTimer: ReturnType<typeof setTimeout> | null
  compactRequested: boolean
  contextChars: number
  locked: boolean
  lastDecisionAt: number
  lastDecidedSummary: string | null
}

const threads = new Map<string, ThreadState>()
let visibleThreadId: string | null = null

function getThread(id: string): ThreadState {
  let thread = threads.get(id)
  if (thread === undefined) {
    thread = {
      id,
      entries: [],
      visualEntryByPath: new Map(),
      running: false,
      abort: null,
      approvals: [],
      approvalTimer: null,
      compactRequested: false,
      contextChars: 0,
      locked: false,
      lastDecisionAt: 0,
      lastDecidedSummary: null,
    }
    threads.set(id, thread)
    evictIdleThreads()
  }
  return thread
}

/** Bounded thread table: idle threads accumulate (entries are capped,
 * threads were not). Only non-running, non-visible threads are evicted;
 * reopening re-seeds from the persisted session, so nothing is lost. */
function evictIdleThreads(): void {
  while (threads.size > 30) {
    const evictable = [...threads.keys()].find(
      (key) => key !== visibleThreadId && !threads.get(key)?.running,
    )
    if (evictable === undefined) break
    threads.delete(evictable)
  }
}

function visibleThread(): ThreadState | null {
  return visibleThreadId === null ? null : getThread(visibleThreadId)
}

// ---- snapshot ---------------------------------------------------------------

let entryId = 0

/** binary uploads staged by the composer, flushed into the thread workspace on send */
const pendingUploads: { name: string; bytes: Uint8Array }[] = []
let snapshot: AgentSnapshot = {
  entries: [],
  running: false,
  activeLocked: false,
  keyAvailable: false,
  pendingSummary: null,
  pendingCount: 0,
  pendingGlobal: null,
  runningIds: [],
  sessions: [],
  skills: [],
  tools: [],
  contextChars: 0,
  sessionId: null,
  config: EMPTY_FORM,
  savedNote: '',
  draft: readStoredDraft(null),
  version: 0,
}
const subscribers = new Set<() => void>()

function set(patch: Partial<AgentSnapshot>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const notify of subscribers) notify()
}

/** Copy the visible thread's live state into the snapshot. */
function publish(): void {
  const thread = visibleThreadId === null ? null : threads.get(visibleThreadId)
  let pendingGlobal: AgentSnapshot['pendingGlobal'] = null
  for (const candidate of threads.values()) {
    if (candidate.approvals.length > 0) {
      pendingGlobal = { threadId: candidate.id, summary: candidate.approvals[0].summary }
      break
    }
  }
  set({
    entries: thread ? thread.entries : [],
    running: thread?.running ?? false,
    activeLocked: thread?.locked ?? false,
    pendingSummary: thread && thread.approvals.length > 0 ? thread.approvals[0].summary : null,
    pendingCount: thread?.approvals.length ?? 0,
    contextChars: thread?.contextChars ?? 0,
    sessionId: visibleThreadId,
    pendingGlobal,
    runningIds: [...threads.values()].filter((candidate) => candidate.running).map((candidate) => candidate.id),
  })
}

export const agentStore = {
  get(): AgentSnapshot {
    return snapshot
  },
  subscribe(notify: () => void): () => void {
    subscribers.add(notify)
    return () => subscribers.delete(notify)
  },
}

// ---- thread-scoped entry helpers ---------------------------------------------

function pushEntry(thread: ThreadState, kind: ChatEntry['kind'], text: string, name?: string, status?: ChatEntry['status']): ChatEntry {
  const entry: ChatEntry = { id: ++entryId, kind, text, ...(name ? { name } : {}), ...(status ? { status } : {}) }
  thread.entries = [...thread.entries, entry]
  if (thread.entries.length > 400) thread.entries = thread.entries.slice(-400)
  publish()
  return entry
}

/** Mark the most recent running tool entry with its outcome. */
function settleToolEntry(thread: ThreadState, isError: boolean): void {
  const entries = [...thread.entries]
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'tool' && entries[i].status === 'running') {
      entries[i] = { ...entries[i], status: isError ? 'error' : 'complete' }
      thread.entries = entries
      publish()
      return
    }
  }
}

/** Streaming text deltas coalesce into the current assistant entry. */
function appendAssistantDelta(thread: ThreadState, delta: string): void {
  const entries = [...thread.entries]
  const last = entries[entries.length - 1]
  if (last && last.kind === 'assistant') {
    entries[entries.length - 1] = { ...last, text: last.text + delta }
    thread.entries = entries
    publish()
  } else {
    pushEntry(thread, 'assistant', delta)
  }
}

function clipLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines)`
}

// ---- approvals (per thread FIFO; the loop owns the 300s timeout) ------------

function summarizeCall(call: ToolCall): string {
  if (call.name === 'bash' || call.name === 'job_start') return String(call.input.command ?? '')
  if (call.name === 'write') return `${call.input.path} — ${String(call.input.content ?? '').slice(0, 200)}`
  if (call.name === 'edit') return `${call.input.path} — replace ${String(call.input.oldText ?? '').slice(0, 80)}…`
  if (call.input.path !== undefined) return String(call.input.path)
  return JSON.stringify(call.input).slice(0, 140)
}

function armApprovalTimer(thread: ThreadState): void {
  if (thread.approvalTimer !== null) clearTimeout(thread.approvalTimer)
  // aligned with the loop's own 300s approval timeout: whichever fires,
  // the entry leaves the queue so a late click cannot resolve a dead
  // promise or absorb a decision meant for the next call
  thread.approvalTimer = setTimeout(() => decideApproval(thread, false), 300_000)
}

function makeApprove(thread: ThreadState): (call: ToolCall) => Promise<boolean> {
  return (call: ToolCall) =>
    new Promise<boolean>((resolve) => {
      const entry: ApprovalEntry = { summary: `${call.name} ${summarizeCall(call)}`, resolve }
      thread.approvals.push(entry)
      if (thread.approvals.length === 1) armApprovalTimer(thread)
      publish()
      platform().bus.emit('app:status', { message: 'agent waiting for approval…', tone: 'info' })
    })
}

function decideApproval(thread: ThreadState, allowed: boolean): void {
  const head = thread.approvals[0]
  if (head === undefined) return
  if (thread.approvalTimer !== null) {
    clearTimeout(thread.approvalTimer)
    thread.approvalTimer = null
  }
  // debounce double-clicks per queue head, not globally
  const now = Date.now()
  if (thread.lastDecidedSummary === head.summary && now - thread.lastDecisionAt < 350) return
  thread.lastDecidedSummary = head.summary
  thread.lastDecisionAt = now
  thread.approvals.shift()
  head.resolve(allowed)
  if (thread.approvals.length > 0) armApprovalTimer(thread)
  publish()
}

function cancelApprovals(thread: ThreadState): void {
  if (thread.approvalTimer !== null) {
    clearTimeout(thread.approvalTimer)
    thread.approvalTimer = null
  }
  for (const entry of thread.approvals.splice(0)) entry.resolve(false)
  publish()
}

// ---- visuals ------------------------------------------------------------------


function resolveAgainst(cwd: string, path: string): string {
  if (path.startsWith('~')) return `${HOME}${path.slice(1)}`
  if (path.startsWith('/')) return path
  return `${cwd}/${path}`
}

function pushVisualIfNew(thread: ThreadState, vfs: ReturnType<typeof platform>['vfs'], path: string): void {
  if (!vfs.isFile(path)) return
  // one visual per artifact per user turn: re-writing or editing the
  // file mid-turn refreshes the existing entry (HtmlVisual re-reads
  // the file on render); after a new user message, a fresh visual for
  // the same path is welcome again
  const existingEntryId = thread.visualEntryByPath.get(path)
  if (existingEntryId !== undefined) {
    let lastUserEntryId = 0
    for (const entry of thread.entries) if (entry.kind === 'user') lastUserEntryId = entry.id
    if (existingEntryId > lastUserEntryId) return
  }
  const entry = pushEntry(thread, 'visual', path)
  thread.visualEntryByPath.set(path, entry.id)
}

/** HTML artifacts in the thread workspace become in-chat visuals. */
function pushVisualEntries(thread: ThreadState, vfs: ReturnType<typeof platform>['vfs']): void {
  try {
    const dir = `${threadWorkspace(thread.id)}/artifacts`
    if (!vfs.isDir(dir)) return
    for (const name of vfs.readDir(dir)) {
      if (name.endsWith('.html')) pushVisualIfNew(thread, vfs, `${dir}/${name}`)
    }
  } catch {
    // artifacts are best-effort
  }
}

// ---- config / sessions ---------------------------------------------------------

function loadConfigForm(): AgentConfigForm {
  try {
    const raw = platform().vfs.read(CONFIG_PATH)
    if (raw === null) return EMPTY_FORM
    const parsed = JSON.parse(raw) as Partial<AgentConfigForm>
    return {
      provider: parsed.provider ?? 'meta',
      model: parsed.model ?? '',
      apiKey: parsed.apiKey ?? '',
      baseURL: parsed.baseURL ?? '',
      permission: parsed.permission ?? 'full',
      thinking: parsed.thinking ?? 'xhigh',
    }
  } catch {
    return EMPTY_FORM
  }
}

/** Sidebar row cache: refresh() parses every session file, so unchanged
 * sessions (same mtime+size) reuse their last-computed info instead of
 * re-reading + re-parsing full transcripts. */
const sessionInfoCache = new Map<string, { stamp: string; info: SessionInfo }>()
function sessionInfo(vfs: ReturnType<typeof platform>['vfs'], id: string): SessionInfo {
  const stat = vfs.stat(`/home/user/.cell/sessions/${id}.json`)
  const stamp = stat === null ? 'missing' : `${stat.mtime}:${stat.size}`
  const cached = sessionInfoCache.get(id)
  if (cached !== undefined && cached.stamp === stamp) return cached.info
  const remember = (info: SessionInfo): SessionInfo => {
    sessionInfoCache.set(id, { stamp, info })
    if (sessionInfoCache.size > 2000) {
      const oldest = sessionInfoCache.keys().next()
      if (oldest.done !== true) sessionInfoCache.delete(oldest.value)
    }
    return info
  }
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return remember({ id, label: id })
  const flags = {
    ...(loaded.session.pinned ? { pinned: true } : {}),
    ...(loaded.session.archived ? { archived: true } : {}),
    ...(loaded.session.locked ? { locked: true } : {}),
  }
  if (loaded.session.liveRun === true && !snapshot.runningIds.includes(id)) {
    // a run was live when its tab went away: convert liveRun into a
    // persistent interrupted marker. It stays in the file until the
    // user actually opens the session — noticing it on a refresh must
    // not silently consume it
    try {
      const { liveRun: _cleared, ...rest } = loaded.session
      saveSession(vfs, { ...rest, interrupted: true })
      loaded.session = { ...rest, interrupted: true }
    } catch { /* best-effort */ }
  }
  const interruptedFlag = loaded.session.interrupted === true ? { interrupted: true } : {}
  const title = loaded.session.title?.trim()
  if (title !== undefined && title !== '') return remember({ id, label: title, title, ...flags, ...interruptedFlag })
  const prompt = loaded.session.prompt.trim()
  // same-ms same-size rewrites could theoretically serve a stale label;
  // mutateSession deletes the entry, so user edits always recompute
  if (prompt !== '') return remember({ id, label: prompt.length > 42 ? `${prompt.slice(0, 42)}…` : prompt, ...flags, ...interruptedFlag })
  return remember({ id, label: id, ...flags, ...interruptedFlag })
}

/** Patch flags/title on a stored session, preserving its history. */
function mutateSession(id: string, patch: Partial<{ title: string; pinned: boolean; archived: boolean; locked: boolean }>): void {
  sessionInfoCache.delete(id)
  const { vfs } = platform()
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return
  try {
    saveSession(vfs, { ...loaded.session, ...patch })
  } catch { /* best-effort */ }
  agentActions.refresh()
}

/** Sessions without a model title get one lazily (attempted only on
 * success, max three per sweep; old sessions included). */
const titleAttempts = new Set<string>()
async function ensureSessionTitles(vfs: ReturnType<typeof platform>['vfs']): Promise<void> {
  let titled = 0
  for (const session of snapshot.sessions) {
    if (titled >= 3) break
    if (session.title !== undefined || titleAttempts.has(session.id)) continue
    const title = await generateSessionTitle(vfs, session.id).catch(() => null)
    if (title !== null) {
      titleAttempts.add(session.id)
      titled++
      set({ sessions: snapshot.sessions.map((s) => (s.id === session.id ? { ...s, label: title, title } : s)) })
    }
  }
}

/** Restore the earlier conversation into the chat on resume, so the
 * user sees the context the agent is continuing from. */
function seedHistoryEntries(thread: ThreadState, vfs: ReturnType<typeof platform>['vfs'], id: string): void {
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return
  const turns: SessionTurn[] = loaded.session.turns.slice(-60)
  const workspace = threadWorkspace(id)
  pushEntry(thread, 'note', `↻ resumed “${loaded.session.title ?? loaded.session.prompt.slice(0, 60)}” — earlier messages restored · workspace ${workspace.replace(HOME, '~')}`)
  const resultsById = new Map<string, { content: string; isError?: boolean }>()
  for (const turn of turns) {
    if (turn.role === 'tool') {
      for (const result of turn.toolResults ?? []) resultsById.set(result.id, result)
    }
  }
  for (const turn of turns) {
    if (turn.role === 'user') pushEntry(thread, 'user', turn.text)
    else if (turn.role === 'assistant') {
      if (turn.text.trim() !== '') pushEntry(thread, 'assistant', turn.text)
      for (const call of turn.toolCalls ?? []) {
        pushEntry(thread, 'tool', `${call.name} ${call.input.path ?? call.input.command ?? ''}`.trim(), call.name, 'complete')
        const result = resultsById.get(call.id)
        if (result !== undefined) pushEntry(thread, 'result', clipLines(result.content, 12), call.name)
        // visuals produced in this session render again on revisit
        const callPath = typeof call.input.path === 'string' ? call.input.path : ''
        if (callPath.endsWith('.html')) pushVisualIfNew(thread, vfs, resolveAgainst(workspace, callPath))
      }
    }
  }
}

// ---- actions --------------------------------------------------------------------

const DRAFT_PREFIX = 'cell.draft:'
const LAST_THREAD_KEY = 'cell.lastThread'

function rememberLastThread(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LAST_THREAD_KEY)
    else localStorage.setItem(LAST_THREAD_KEY, id)
  } catch { /* private mode */ }
}

function draftKey(threadId: string | null): string {
  return `${DRAFT_PREFIX}${threadId ?? 'new'}`
}

function readStoredDraft(threadId: string | null): string {
  try {
    return localStorage.getItem(draftKey(threadId)) ?? ''
  } catch {
    return ''
  }
}

function storeDraft(threadId: string | null, text: string): void {
  try {
    if (text === '') localStorage.removeItem(draftKey(threadId))
    else localStorage.setItem(draftKey(threadId), text)
  } catch { /* private mode — drafts stay in memory */ }
}

export const agentActions = {
  refresh(): void {
    const { vfs } = platform()
    const cwd = visibleThreadId === null ? HOME : threadWorkspace(visibleThreadId)
    const { skills } = loadSkills(vfs, cwd)
    const { entries } = registryEntries(vfs)
    const form = loadConfigForm()
    let keyAvailable = form.apiKey.trim() !== ''
    if (!keyAvailable && form.provider === 'meta') {
      try {
        const mirror = platform().vfs.read('/home/user/.cell/auth.json')
        keyAvailable = mirror !== null && (JSON.parse(mirror) as { meta?: { key?: string } }).meta?.key !== undefined
      } catch { /* no mirror */ }
    }
    set({
      keyAvailable,
      config: form,
      sessions: listSessions(vfs)
        .map((name) => name.replace(/\.json$/, ''))
        .map((id) => sessionInfo(vfs, id)),
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      tools: entries.map((entry) => entry.name),
    })
  },

  ensureTitles(): void {
    void ensureSessionTitles(platform().vfs)
  },

  setConfig(patch: Partial<AgentConfigForm>): void {
    set({ config: { ...snapshot.config, ...patch }, savedNote: '' })
  },

  saveConfig(): void {
    const form = snapshot.config
    const data: Record<string, string> = { provider: form.provider, permission: form.permission, thinking: form.thinking }
    if (form.model.trim() !== '') data.model = form.model.trim()
    if (form.apiKey.trim() !== '') data.apiKey = form.apiKey.trim()
    if (form.provider === 'compat' && form.baseURL.trim() !== '') data.baseURL = form.baseURL.trim()
    platform().vfs.write(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`)
    // the banner reads keyAvailable, not the form: refresh it now so the
    // composer stops complaining the moment the key is saved
    set({ savedNote: 'saved to ~/.cell/agent.json', keyAvailable: form.apiKey.trim() !== '' || form.provider === 'compat' })
  },

  setDraft(text: string): void {
    storeDraft(visibleThreadId, text)
    set({ draft: text })
  },

  appendDraft(text: string): void {
    const current = snapshot.draft
    const next = current === '' ? text : `${current}${current.endsWith(' ') ? '' : ' '}${text}`
    storeDraft(visibleThreadId, next)
    set({ draft: next })
  },

  /** Stage binary uploads (images etc.) for the next send: text drafts
   * cannot carry bytes, so files wait here and land in the thread
   * workspace when the run starts (see run()). */
  stageUpload(name: string, bytes: Uint8Array): void {
    const clean = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'upload'
    pendingUploads.push({ name: clean, bytes })
    agentActions.appendDraft(`[upload: ${clean}]`)
  },

  /** Open a past session as the current thread. Any run already going
   * on it (or on the thread left behind) keeps working. */
  openSession(id: string): void {
    const { vfs } = platform()
    const isNew = !threads.has(id)
    const thread = getThread(id)
    visibleThreadId = id
    const info = snapshot.sessions.find((s) => s.id === id)
    thread.locked = info?.locked === true
    if (isNew) {
      const loaded = loadSession(vfs, id)
      thread.contextChars = 'error' in loaded ? 0 : loaded.session.turns.reduce((sum, turn) => sum + turn.text.length, 0)
      seedHistoryEntries(thread, vfs, id)
    }
    rememberLastThread(id)
    set({ draft: readStoredDraft(id) })
    const opened = loadSession(vfs, id)
    if (!('error' in opened) && opened.session.interrupted === true) {
      // consumed on view: clear the marker, tell the user once
      try {
        const { interrupted: _seen, ...rest } = opened.session
        saveSession(vfs, rest)
      } catch { /* best-effort */ }
      pushEntry(thread, 'note', '⚠ the previous run was interrupted — the tab closed or reloaded mid-run. Everything up to the last finished step is here; send a message to continue.')
      agentActions.refresh()
    }
    publish()
  },

  renameSession(id: string, title: string): void {
    const clean = title.trim().slice(0, 80)
    if (clean !== '') mutateSession(id, { title: clean })
  },

  togglePin(id: string): void {
    const session = snapshot.sessions.find((s) => s.id === id)
    mutateSession(id, { pinned: session?.pinned !== true })
  },

  toggleArchive(id: string): void {
    const session = snapshot.sessions.find((s) => s.id === id)
    mutateSession(id, { archived: session?.archived !== true })
  },

  toggleLock(id: string): void {
    const session = snapshot.sessions.find((s) => s.id === id)
    const locked = session?.locked !== true
    mutateSession(id, { locked })
    const thread = threads.get(id)
    if (thread !== undefined) {
      thread.locked = locked
      publish()
    }
  },

  forkSession(id: string): string | null {
    const { vfs } = platform()
    const loaded = loadSession(vfs, id)
    if ('error' in loaded) return null
    const newId = sessionId()
    try {
      saveSession(vfs, {
        ...loaded.session,
        id: newId,
        title: `${loaded.session.title ?? loaded.session.prompt.slice(0, 40)} (fork)`.slice(0, 80),
        startedAt: new Date().toISOString(),
        archived: false,
        pinned: false,
        locked: false,
      })
    } catch { return null }
    agentActions.refresh()
    return newId
  },

  deleteSession(id: string): void {
    const { vfs } = platform()
    const thread = threads.get(id)
    if (thread?.running) thread.abort?.abort()
    if (thread !== undefined) cancelApprovals(thread)
    threads.delete(id)
    if (visibleThreadId === id) visibleThreadId = null
    try {
      vfs.delete(`/home/user/.cell/sessions/${id}.json`)
    } catch { /* best-effort */ }
    publish()
    agentActions.refresh()
  },

  /** Markdown export of a session transcript (Share). */
  sessionMarkdown(id: string): string {
    const { vfs } = platform()
    const loaded = loadSession(vfs, id)
    if ('error' in loaded) return ''
    const lines = [`# ${loaded.session.title ?? loaded.session.prompt}`, '', `_${loaded.session.provider}/${loaded.session.model} · ${loaded.session.startedAt}_`, '']
    for (const line of loaded.session.transcript) lines.push(line)
    return lines.join('\n')
  },

  /** New chat: just change the view. Nothing is stopped. */
  clearChat(): void {
    visibleThreadId = null
    rememberLastThread(null)
    set({ draft: readStoredDraft(null) })
    publish()
  },

  /** After a reload the chat is empty although sessions persisted: reopen
   * the thread the user was on so history is one click away (openSession
   * seeds it). Best-effort: unknown ids are forgotten. */
  reopenLast(): void {
    if (visibleThreadId !== null || snapshot.entries.length > 0 || snapshot.running) return
    let id: string | null = null
    try {
      id = localStorage.getItem(LAST_THREAD_KEY)
    } catch { /* private mode */ }
    if (id === null) return
    if (!snapshot.sessions.some((s) => s.id === id)) {
      rememberLastThread(null)
      return
    }
    agentActions.openSession(id)
  },

  decide(allowed: boolean): void {
    const thread = visibleThread()
    if (thread !== null) decideApproval(thread, allowed)
  },

  decideFor(threadId: string, allowed: boolean): void {
    const thread = threads.get(threadId)
    if (thread !== undefined) decideApproval(thread, allowed)
  },

  /** Stop the visible thread's run. Other threads keep working. */
  stop(): void {
    const thread = visibleThread()
    if (thread === null) return
    thread.abort?.abort()
    cancelApprovals(thread)
  },

  /** Ask the visible thread's loop to compact at the next step. */
  requestCompact(): void {
    const thread = visibleThread()
    if (thread !== null) thread.compactRequested = true
  },

  async run(prompt: string): Promise<void> {
    const text = prompt.trim()
    if (text === '') return
    const { vfs, bus } = platform()
    // a fresh chat becomes a thread (with its own workspace) on send
    if (visibleThreadId === null) visibleThreadId = sessionId()
    rememberLastThread(visibleThreadId)
    const thread = getThread(visibleThreadId)
    if (thread.running) return
    const approve = makeApprove(thread)
    thread.abort = new AbortController()
    thread.running = true
    // the draft being sent may live under the fresh-chat key (the
    // thread only gets its id now) — clear both, or a reload would
    // resurrect the already-sent prompt in the composer
    storeDraft(thread.id, '')
    storeDraft(null, '')
    set({ draft: '' })
    publish()
    pushEntry(thread, 'user', text)
    bus.emit('app:status', { message: 'agent running…', tone: 'info' })

    const workspace = threadWorkspace(thread.id)
    const cwd = workspace
    try {
      vfs.mkdir(workspace)
      // flush staged uploads into the thread: binary files cannot ride in
      // the text draft, so they land here where every tool can reach them
      let prompt = text
      if (pendingUploads.length > 0) {
        vfs.mkdir(`${workspace}/uploads`)
        const staged: string[] = []
        for (const upload of pendingUploads.splice(0)) {
          const dest = `${workspace}/uploads/${upload.name}`
          vfs.writeBytes(dest, upload.bytes)
          staged.push(dest)
        }
        prompt = `${text}\n[attached files on disk: ${staged.join(', ')}]`
      }
      // pre-create the session file under this thread's id so the run
      // resumes into it and the workspace/session pairing is stable
      if ('error' in loadSession(vfs, thread.id)) {
        const form = snapshot.config
        saveSession(vfs, {
          id: thread.id,
          startedAt: new Date().toISOString(),
          provider: form.provider,
          model: form.model,
          prompt: text,
          transcript: [],
          turns: [],
          steps: 0,
        })
      }
      // thread confinement (browser): every tool the agent touches — file
      // tools, bash, python, node, git — operates on this scoped view, so
      // other threads are not nameable. Mounted alongside the thread dir:
      // ~/.cell (config/sessions/skills registries) and the project the
      // user is working in (starter project by default, IDE-open project
      // when set). Same boundary as the headless server's bindings.
      const mounts: Record<string, string> = { '/home/user/.cell': '/home/user/.cell' }
      const mountRoot = (root: string | null): void => {
        if (root === null) return
        if (root === workspace || root.startsWith(`${workspace}/`) || workspace.startsWith(`${root}/`)) return
        mounts[root] = root
      }
      mountRoot(projectRoot(vfs, getActivePath() ?? HOME))
      if (vfs.isDir('/home/user/project')) mountRoot('/home/user/project')
      const scoped = scopeVfs(vfs, workspace, mounts)
      const shell = createShell(scoped, { protected: true, approve })
      const jobShell = createShell(scoped, { protected: true, approve })
      const result = await runAgent(scoped, ['--resume', thread.id, prompt], {
        cwd,
        shell,
        jobShell,
        approve,
        signal: thread.abort.signal,
        // no upper cap on agent turns in the UI; the stop button and
        // per-step timeouts are the guardrails
        maxSteps: Number.POSITIVE_INFINITY,
        shouldCompact: () => {
          const requested = thread.compactRequested
          thread.compactRequested = false
          return requested
        },
        onSession: () => publish(),
        onContext: (chars) => {
          thread.contextChars = chars
          publish()
        },
        onToolResult: (call, toolResult) => {
          settleToolEntry(thread, toolResult.isError === true)
          pushEntry(thread, 'result', clipLines(toolResult.content, 16), call.name)
          // a visual appears when it is written, not after the run
          const writtenPath = typeof call.input.path === 'string' ? call.input.path : ''
          if ((call.name === 'write' || call.name === 'edit') && writtenPath.endsWith('.html') && !toolResult.isError) {
            pushVisualIfNew(thread, vfs, resolveAgainst(cwd, writtenPath))
          }
        },
        onProgress: (line) => {
          if (line.startsWith('⏺ ')) {
            const body = line.slice(2)
            const space = body.indexOf(' ')
            pushEntry(thread, 'tool', body, space === -1 ? body : body.slice(0, space), 'running')
          } else if (line.startsWith('❓')) {
            // approval requests render as the pending card, not a transcript line
          } else {
            appendAssistantDelta(thread, line)
          }
        },
      })
      // the transcript tail carries errors — surfacing only the exit
      // code hid them from UI users
      const tail = result.stdout.trim().split('\n').filter((line) => line.trim() !== '')
      const errorLine = [...tail].reverse().find((line) => line.startsWith('agent ✗') || line.startsWith('agent: reached'))
      if (result.stderr.trim() !== '') pushEntry(thread, 'note', result.stderr.trim())
      if (thread.abort.signal.aborted) pushEntry(thread, 'note', '■ stopped')
      else if (errorLine !== undefined) pushEntry(thread, 'note', errorLine)
      else if (result.stderr.trim() === '') pushEntry(thread, 'note', result.exitCode === 0 ? '✓ done' : `✗ exit ${result.exitCode}`)
    } catch (err) {
      pushEntry(thread, 'note', `✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      cancelApprovals(thread)
      thread.abort = null
      thread.running = false
      publish()
      pushVisualEntries(thread, vfs)
      agentActions.refresh()
      agentActions.ensureTitles()
    }
  },
}

export { COMPACT_AT_CHARS }
