import { platform } from '../platform'
import { createShell } from '../shell/shell'
import { runAgent, COMPACT_AT_CHARS } from '../shell/commands/agent'
import { listSessions } from '../shell/commands/agent-sessions'
import { loadSkills } from '../shell/commands/agent-skills'
import { registryEntries, type ToolCall } from '../shell/commands/agent-tools'
import { getActivePath } from './workspace-store'

/**
 * Shared agent state for the Agent chat (main area) and the Agent
 * sidebar (sessions/config/skills/tools). One module store, following
 * the diagnostics-store pattern: referentially stable snapshots,
 * subscribe/notify, all actions as plain functions.
 */

export interface ChatEntry {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'note' | 'approval'
  text: string
  name?: string
}

export interface AgentConfigForm {
  provider: string
  model: string
  apiKey: string
  baseURL: string
  permission: string
}

export interface AgentSnapshot {
  entries: readonly ChatEntry[]
  running: boolean
  pendingSummary: string | null
  sessions: readonly string[]
  skills: readonly { name: string; description: string }[]
  tools: readonly string[]
  contextChars: number
  sessionId: string | null
  resumeTarget: string | null
  config: AgentConfigForm
  savedNote: string
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
  sessions: [],
  skills: [],
  tools: [],
  contextChars: 0,
  sessionId: null,
  resumeTarget: null,
  config: EMPTY_FORM,
  savedNote: '',
  version: 0,
}
const subscribers = new Set<() => void>()

function set(patch: Partial<AgentSnapshot>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const notify of subscribers) notify()
}

function pushEntry(kind: ChatEntry['kind'], text: string, name?: string): void {
  const entry: ChatEntry = { id: ++entryId, kind, text, ...(name ? { name } : {}) }
  set({ entries: [...snapshot.entries.slice(-400), entry] })
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

export const agentActions = {
  /** Load config/sessions/skills/tools from the VFS (call on mount). */
  refresh(): void {
    const { vfs } = platform()
    const cwd = getActivePath() ?? HOME
    const { skills } = loadSkills(vfs, cwd)
    const { entries } = registryEntries(vfs)
    set({
      config: loadConfigForm(),
      sessions: listSessions(vfs).map((name) => name.replace(/\.json$/, '')),
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      tools: entries.map((entry) => entry.name),
    })
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

  setResumeTarget(id: string | null): void {
    set({ resumeTarget: id })
  },

  clearChat(): void {
    set({ entries: [], contextChars: 0, sessionId: null })
  },

  decide(allowed: boolean): void {
    decideApproval(allowed)
  },

  async run(prompt: string, steps: number): Promise<void> {
    const text = prompt.trim()
    if (snapshot.running || text === '') return
    const resumeId = snapshot.resumeTarget
    set({ running: true, resumeTarget: null })
    pushEntry('user', resumeId !== null ? `(resume ${resumeId}) ${text}` : text)
    const { vfs } = platform()
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
        onSession: (id) => set({ sessionId: id }),
        onContext: (chars) => set({ contextChars: chars }),
        onToolResult: (call, toolResult) => {
          pushEntry('result', clipLines(toolResult.content, 16), call.name)
        },
        onProgress: (line) => {
          if (line.startsWith('⏺ ')) pushEntry('tool', line.slice(2))
          else if (line.startsWith('❓')) pushEntry('note', line)
          else appendAssistantDelta(line)
        },
      })
      if (result.stderr.trim() !== '') pushEntry('note', result.stderr.trim())
      pushEntry('note', result.exitCode === 0 ? '✓ done' : `✗ exit ${result.exitCode}`)
    } catch (err) {
      pushEntry('note', `✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      cancelApprovals()
      set({ running: false })
      agentActions.refresh()
    }
  },
}

function clipLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines)`
}

// ---- approval FIFO (shared by chat + any future surface) ----

const approvalQueue: { summary: string; resolve: (allowed: boolean) => void }[] = []
let approvalTimer: ReturnType<typeof setTimeout> | null = null
let lastDecisionAt = 0

function summarizeCall(call: ToolCall): string {
  if (call.name === 'bash' || call.name === 'job_start') return String(call.input.command ?? '')
  if (call.name === 'write') return `${call.input.path} — ${String(call.input.content ?? '').slice(0, 200)}`
  if (call.name === 'edit') return `${call.input.path} — replace ${String(call.input.oldText ?? '').slice(0, 80)}…`
  if (call.input.path !== undefined) return String(call.input.path)
  return JSON.stringify(call.input).slice(0, 140)
}

function armApprovalTimer(): void {
  if (approvalTimer !== null) clearTimeout(approvalTimer)
  approvalTimer = setTimeout(() => decideApproval(false), 300_000)
}

function approve(call: ToolCall): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry = { summary: `${call.name} ${summarizeCall(call)}`, resolve }
    approvalQueue.push(entry)
    pushEntry('approval', entry.summary, call.name)
    if (approvalQueue.length === 1) {
      set({ pendingSummary: entry.summary })
      armApprovalTimer()
    }
  })
}

function decideApproval(allowed: boolean): void {
  const now = Date.now()
  if (now - lastDecisionAt < 350) return
  lastDecisionAt = now
  if (approvalTimer !== null) {
    clearTimeout(approvalTimer)
    approvalTimer = null
  }
  const head = approvalQueue.shift()
  head?.resolve(allowed)
  const next = approvalQueue[0]
  set({ pendingSummary: next ? next.summary : null })
  if (next) armApprovalTimer()
}

function cancelApprovals(): void {
  if (approvalTimer !== null) {
    clearTimeout(approvalTimer)
    approvalTimer = null
  }
  for (const entry of approvalQueue.splice(0)) entry.resolve(false)
  if (snapshot.pendingSummary !== null) set({ pendingSummary: null })
}

export { COMPACT_AT_CHARS }
