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

export const SESSIONS_DIR = '/home/user/.cell/sessions'

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
  startedAt: string
  provider: string
  model: string
  prompt: string
  transcript: string[]
  turns: SessionTurn[]
  steps: number
}

const MAX_TURNS = 40

/** Keep the first user prompt + the last turns; drop the middle. */
export function truncateTurns(turns: SessionTurn[]): SessionTurn[] {
  if (turns.length <= MAX_TURNS) return turns
  const head = turns.slice(0, 1)
  const tail = turns.slice(turns.length - (MAX_TURNS - 1))
  // shrink oversized tool payloads in what we keep
  const shrink = (turn: SessionTurn): SessionTurn => ({
    ...turn,
    text: turn.text.length > 8000 ? `${turn.text.slice(0, 8000)}\n… [truncated]` : turn.text,
    toolResults: turn.toolResults?.map((result) => ({
      ...result,
      content: result.content.length > 8000 ? `${result.content.slice(0, 8000)}\n… [truncated]` : result.content,
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
  const direct = id.endsWith('.json') ? id : `${SESSIONS_DIR}/${id}.json`
  const candidates = [direct, `${SESSIONS_DIR}/${id}`]
  for (const path of candidates) {
    const raw = vfs.read(path)
    if (raw === null) continue
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
  return { error: `no session '${id}' — see ~/.cell/sessions/\n` }
}

export function listSessions(vfs: Vfs): string[] {
  try {
    if (!vfs.isDir(SESSIONS_DIR)) return []
    return vfs.readDir(SESSIONS_DIR).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch {
    return []
  }
}
