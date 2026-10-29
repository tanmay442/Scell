import type { Vfs } from '../../vfs/types'
import { redactJson } from './agent-redact'

/**
 * Sessions: every agent run persists its transcript + message history to
 * ~/.cell/sessions/<id>.json so `cell agent --resume <id>` can continue a
 * task where it left off. History is capped (last 40 turns / 60KB of tool
 * output) so a long session cannot grow the workspace without bound.
 *
 * Follow-up: real compaction (summarize-then-continue) instead of plain
 * truncation — the cap below discards the middle, which is fine for now.
 */

const SESSIONS_DIR = '/home/user/.cell/sessions'

/** Provider-agnostic turn history: enough for anthropic/openai/meta to resume. */
export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolCalls?: { id: string; name: string; input: Record<string, unknown> }[]
  toolResults?: { id: string; content: string; isError?: boolean }[]
  /** meta chaining: the response id this turn came from */
  responseId?: string
}

export interface AgentSession {
  id: string
  /** model-generated short title for the sidebar (set lazily) */
  title?: string
  pinned?: boolean
  archived?: boolean
  locked?: boolean
  startedAt: string
  provider: string
  model: string
  prompt: string
  transcript: string[]
  turns: SessionTurn[]
  steps: number
}

const MAX_TURNS = 40

/** Resume ids are bare file stems, never paths: no traversal, no .json games. */
const RESUME_ID = /^[A-Za-z0-9_.-]+$/

function sanitizeResumeId(id: string): string | null {
  const stem = id.endsWith('.json') ? id.slice(0, -5) : id
  if (stem === '' || stem.includes('/') || stem.includes('\\') || stem.includes('..')) return null
  if (!RESUME_ID.test(stem)) return null
  return stem
}

/** Keep the first user prompt + the last turns; drop the middle.
 * Cuts land on user-turn boundaries so a tool_use block is never
 * orphaned from its tool_result (the API rejects orphans on resume). */
export function truncateTurns(turns: SessionTurn[]): SessionTurn[] {
  if (turns.length <= MAX_TURNS) return turns
  const head = turns.slice(0, 1)
  let start = turns.length - (MAX_TURNS - 1)
  // retreat to a user boundary so the tail never starts mid-exchange —
  // but never keep more than MAX_TURNS - 1 tail turns (pathological
  // all-assistant histories just take the newest slice)
  while (start > 1 && turns[start]?.role !== 'user' && turns.length - start < MAX_TURNS - 1) start--
  let tail = turns.slice(start)
  // never end on an assistant turn whose calls have no results yet
  while (tail.length > 0) {
    const last = tail[tail.length - 1]
    if (last.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0) tail = tail.slice(0, -1)
    else break
  }
  // shrink oversized tool payloads in what we keep
  const shrink = (turn: SessionTurn): SessionTurn => ({
    ...turn,
    text: turn.text.length > 8000 ? `${turn.text.slice(0, 6000)}\n… [truncated ${turn.text.length - 8000} chars, head+tail kept]\n${turn.text.slice(-2000)}` : turn.text,
    toolResults: turn.toolResults?.map((result) => ({
      ...result,
      content: result.content.length > 8000 ? `${result.content.slice(0, 6000)}\n… [truncated ${result.content.length - 8000} chars, head+tail kept]\n${result.content.slice(-2000)}` : result.content,
    })),
  })
  return [...head.map(shrink), ...tail.map(shrink)]
}

export function sessionId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `agent-${stamp}-${rand}`
}

export function saveSession(vfs: Vfs, session: AgentSession): string {
  const capped: AgentSession = {
    ...session,
    transcript: session.transcript.slice(-200),
    turns: truncateTurns(session.turns),
  }
  const path = `${SESSIONS_DIR}/${session.id}.json`
  vfs.write(path, JSON.stringify(redactJson(capped), null, 2))
  return path
}

export function loadSession(vfs: Vfs, id: string): { session: AgentSession } | { error: string } {
  const stem = sanitizeResumeId(id.trim())
  if (stem === null) return { error: `bad session id '${id}' — use the bare file stem under ~/.cell/sessions/\n` }
  const path = `${SESSIONS_DIR}/${stem}.json`
  const raw = vfs.read(path)
  if (raw === null) return { error: `no session '${id}' — see ~/.cell/sessions/\n` }
  try {
    const parsed = JSON.parse(raw) as AgentSession
    if (!Array.isArray(parsed.turns) || !Array.isArray(parsed.transcript)) {
      return { error: `session '${id}' is corrupt (bad turns/transcript)\n` }
    }
    return { session: parsed }
  } catch {
    return { error: `session '${id}' is not valid JSON\n` }
  }
}

export function listSessions(vfs: Vfs): string[] {
  try {
    if (!vfs.isDir(SESSIONS_DIR)) return []
    return vfs.readDir(SESSIONS_DIR).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch {
    return []
  }
}
