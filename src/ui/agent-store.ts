import { platform } from '../platform'
import { createShell } from '../shell/shell'
import { runAgent, generateSessionTitle, COMPACT_AT_CHARS } from '../shell/commands/agent'
import type { SessionTurn } from '../shell/commands/agent-sessions'
import { listSessions, loadSession } from '../shell/commands/agent-sessions'
import { loadSkills } from '../shell/commands/agent-skills'
import { registryEntries, type ToolCall } from '../shell/commands/agent-tools'
import { getActivePath } from './workspace-store'

/**
 * Shared agent state for the Agent home (front door). One module
 * store, following the diagnostics-store pattern: referentially
 * stable snapshots, subscribe/notify, actions as plain functions.
 * Module-level, so switching to the Workspace and back loses nothing.
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
}

export interface SessionInfo {
  id: string
  label: string
  title?: string
}

export interface AgentSnapshot {
  entries: readonly ChatEntry[]
  running: boolean
  pendingSummary: string | null
  pendingCount: number
  sessions: readonly SessionInfo[]
  skills: readonly { name: string; description: string }[]
  tools: readonly string[]
  contextChars: number
  sessionId: string | null
  resumeTarget: string | null
  config: AgentConfigForm
  savedNote: string
  draft: string
  version: number
}

const CONFIG_PATH = '/home/user/.cell/agent.json'
const HOME = '/home/user'
const EMPTY_FORM: AgentConfigForm = { provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: '', baseURL: '', permission: 'full' }

let entryId = 0
let snapshot: AgentSnapshot = {
  entries: [],
  running: false,
  pendingSummary: null,
  pendingCount: 0,
  sessions: [],
  skills: [],
  tools: [],
  contextChars: 0,
  sessionId: null,
  resumeTarget: null,
  config: EMPTY_FORM,
  savedNote: '',
  draft: '',
  version: 0,
}
const subscribers = new Set<() => void>()

function set(patch: Partial<AgentSnapshot>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const notify of subscribers) notify()
}

function pushEntry(kind: ChatEntry['kind'], text: string, name?: string, status?: ChatEntry['status']): void {
  const entry: ChatEntry = { id: ++entryId, kind, text, ...(name ? { name } : {}), ...(status ? { status } : {}) }
  const entries = [...snapshot.entries, entry]
  set({ entries: entries.length > 400 ? entries.slice(-400) : entries })
}

/** Mark the most recent running tool entry with its outcome. */
function settleToolEntry(name: string, isError: boolean): void {
  const entries = [...snapshot.entries]
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'tool' && entries[i].status === 'running') {
      entries[i] = { ...entries[i], status: isError ? 'error' : 'complete' }
      set({ entries })
      return
    }
  }
  void name
}

/** Streaming text deltas coalesce into the current assistant entry. */
function appendAssistantDelta(delta: string): void {
  const entries = [...snapshot.entries]
  const last = entries[entries.length - 1]
  if (last && last.kind === 'assistant') {
    entries[entries.length - 1] = { ...last, text: last.text + delta }
    set({ entries })
  } else {
    pushEntry('assistant', delta)
  }
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
    }
  } catch {
    return EMPTY_FORM
  }
}

function sessionInfo(vfs: ReturnType<typeof platform>['vfs'], id: string): SessionInfo {
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return { id, label: id }
  const title = loaded.session.title?.trim()
  if (title !== undefined && title !== '') return { id, label: title, title }
  const prompt = loaded.session.prompt.trim()
  if (prompt !== '') return { id, label: prompt.length > 42 ? `${prompt.slice(0, 42)}…` : prompt }
  return { id, label: id }
}

/** Sessions without a model title get one lazily (one cheap call each,
 * attempted once per session per page load; old sessions included). */
const titleAttempts = new Set<string>()
async function ensureSessionTitles(vfs: ReturnType<typeof platform>['vfs']): Promise<void> {
  for (const session of snapshot.sessions) {
    if (session.title !== undefined || titleAttempts.has(session.id)) continue
    titleAttempts.add(session.id)
    const title = await generateSessionTitle(vfs, session.id).catch(() => null)
    if (title !== null) {
      set({ sessions: snapshot.sessions.map((s) => (s.id === session.id ? { ...s, label: title, title } : s)) })
    }
  }
}

let abortController: AbortController | null = null

export const agentActions = {
  refresh(): void {
    const { vfs } = platform()
    const cwd = getActivePath() ?? HOME
    const { skills } = loadSkills(vfs, cwd)
    const { entries } = registryEntries(vfs)
    set({
      config: loadConfigForm(),
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
    const data: Record<string, string> = { provider: form.provider, permission: form.permission }
    if (form.model.trim() !== '') data.model = form.model.trim()
    if (form.apiKey.trim() !== '') data.apiKey = form.apiKey.trim()
    if (form.provider === 'compat' && form.baseURL.trim() !== '') data.baseURL = form.baseURL.trim()
    platform().vfs.write(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`)
    set({ savedNote: 'saved to ~/.cell/agent.json' })
  },

  setDraft(text: string): void {
    set({ draft: text })
  },

  appendDraft(text: string): void {
    const current = snapshot.draft
    set({ draft: current === '' ? text : `${current}${current.endsWith(' ') ? '' : ' '}${text}` })
  },

  setResumeTarget(id: string | null): void {
    set({ resumeTarget: id })
  },

  clearChat(): void {
    if (snapshot.running) return
    set({ entries: [], contextChars: 0, sessionId: null, resumeTarget: null, draft: '' })
  },

  decide(allowed: boolean): void {
    decideApproval(allowed)
  },

  stop(): void {
    abortController?.abort()
    cancelApprovals()
  },

  async run(prompt: string, steps: number): Promise<void> {
    const text = prompt.trim()
    if (snapshot.running || text === '') return
    const resumeId = snapshot.resumeTarget
    const { vfs, bus } = platform()
    abortController = new AbortController()
    set({ running: true, resumeTarget: null, draft: '' })
    if (resumeId !== null) seedHistoryEntries(vfs, resumeId)
    pushEntry('user', text)
    bus.emit('app:status', { message: resumeId !== null ? `agent resuming ${resumeId}…` : 'agent running…', tone: 'info' })
    const cwd = getActivePath() ?? HOME
    try {
      const shell = createShell(vfs, { protected: true, approve })
      const jobShell = createShell(vfs, { protected: true, approve })
      const args = resumeId !== null
        ? ['--resume', resumeId, '--steps', String(steps), text]
        : ['--steps', String(steps), text]
      const result = await runAgent(vfs, args, {
        cwd,
        shell,
        jobShell,
        approve,
        signal: abortController.signal,
        onSession: (id) => set({ sessionId: id }),
        onContext: (chars) => set({ contextChars: chars }),
        onToolResult: (call, toolResult) => {
          settleToolEntry(call.name, toolResult.isError === true)
          pushEntry('result', clipLines(toolResult.content, 16), call.name)
        },
        onProgress: (line) => {
          if (line.startsWith('⏺ ')) {
            const body = line.slice(2)
            const space = body.indexOf(' ')
            pushEntry('tool', body, space === -1 ? body : body.slice(0, space), 'running')
          } else if (line.startsWith('❓')) {
            // approval requests render as the pending card, not a transcript line
          } else {
            appendAssistantDelta(line)
          }
        },
      })
      // the transcript tail carries errors and the step-limit line —
      // surfacing only the exit code hid both from UI users
      const tail = result.stdout.trim().split('\n').filter((line) => line.trim() !== '')
      const errorLine = [...tail].reverse().find((line) => line.startsWith('agent ✗') || line.startsWith('agent: reached'))
      if (result.stderr.trim() !== '') pushEntry('note', result.stderr.trim())
      if (abortController.signal.aborted) pushEntry('note', '■ stopped')
      else if (errorLine !== undefined) pushEntry('note', errorLine)
      else pushEntry('note', result.exitCode === 0 ? '✓ done' : `✗ exit ${result.exitCode}`)
    } catch (err) {
      pushEntry('note', `✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      cancelApprovals()
      abortController = null
      set({ running: false })
      pushVisualEntries(vfs)
      agentActions.refresh()
      agentActions.ensureTitles()
    }
  },
}

/** Restore the earlier conversation into the chat on resume, so the
 * user sees the context the agent is continuing from. */
function seedHistoryEntries(vfs: ReturnType<typeof platform>['vfs'], id: string): void {
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return
  const turns: SessionTurn[] = loaded.session.turns.slice(-60)
  pushEntry('note', `↻ resumed “${loaded.session.title ?? loaded.session.prompt.slice(0, 60)}” — earlier messages restored`)
  for (const turn of turns) {
    if (turn.role === 'user') pushEntry('user', turn.text)
    else if (turn.role === 'assistant') {
      if (turn.text.trim() !== '') pushEntry('assistant', turn.text)
      for (const call of turn.toolCalls ?? []) {
        pushEntry('tool', `${call.name} ${call.input.path ?? call.input.command ?? ''}`.trim(), call.name, 'complete')
      }
    } else if (turn.role === 'tool') {
      pushEntry('result', clipLines(turn.text, 12))
    }
  }
}

const shownVisuals = new Set<string>()

/** HTML artifacts the agent produced become in-chat visuals. */
function pushVisualEntries(vfs: ReturnType<typeof platform>['vfs']): void {
  try {
    const dir = '/home/user/artifacts'
    if (!vfs.isDir(dir)) return
    for (const name of vfs.readDir(dir)) {
      if (!name.endsWith('.html')) continue
      const path = `${dir}/${name}`
      if (shownVisuals.has(path)) continue
      shownVisuals.add(path)
      pushEntry('visual', path)
    }
  } catch {
    // artifacts are best-effort
  }
}

function clipLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines)`
}

// ---- approval FIFO (single-sourced; the loop owns the timeout) ----

const approvalQueue: { summary: string; resolve: (allowed: boolean) => void }[] = []
let lastDecisionAt = 0
let lastDecidedSummary: string | null = null

function summarizeCall(call: ToolCall): string {
  if (call.name === 'bash' || call.name === 'job_start') return String(call.input.command ?? '')
  if (call.name === 'write') return `${call.input.path} — ${String(call.input.content ?? '').slice(0, 200)}`
  if (call.name === 'edit') return `${call.input.path} — replace ${String(call.input.oldText ?? '').slice(0, 80)}…`
  if (call.input.path !== undefined) return String(call.input.path)
  return JSON.stringify(call.input).slice(0, 140)
}

function approve(call: ToolCall): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry = { summary: `${call.name} ${summarizeCall(call)}`, resolve }
    approvalQueue.push(entry)
    set({ pendingSummary: entry.summary, pendingCount: approvalQueue.length })
    platform().bus.emit('app:status', { message: 'agent waiting for approval…', tone: 'info' })
  })
}

function decideApproval(allowed: boolean): void {
  const head = approvalQueue[0]
  if (head === undefined) return
  // debounce double-clicks per queue head, not globally
  const now = Date.now()
  if (lastDecidedSummary === head.summary && now - lastDecisionAt < 350) return
  lastDecidedSummary = head.summary
  lastDecisionAt = now
  approvalQueue.shift()
  head.resolve(allowed)
  const next = approvalQueue[0]
  set({ pendingSummary: next ? next.summary : null, pendingCount: approvalQueue.length })
}

function cancelApprovals(): void {
  for (const entry of approvalQueue.splice(0)) entry.resolve(false)
  if (snapshot.pendingSummary !== null) set({ pendingSummary: null, pendingCount: 0 })
}

export { COMPACT_AT_CHARS }
