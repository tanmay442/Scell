import { listSessions, loadSession } from '../src/shell/commands/agent-sessions'
import type { Vfs } from '../src/vfs/types'

/** Continuation prompt scheduled for threads interrupted by a dead server. */
export const RESUME_PROMPT = 'Continue where you left off. Do not stop, pause, or summarize until every remaining step of the task is fully complete, then report completion exactly as originally instructed.'

/**
 * Scan `~/.cell/sessions/*.json` for sessions whose `liveRun` flag is still
 * set. The agent loop sets `liveRun` while a run is live, so a dead server
 * leaves it set on every thread that was mid-run — those are the threads
 * that need a `continue` job at boot. Corrupt sessions are skipped.
 *
 * Returns bare session stems (the resume keys).
 */
export function findInterruptedThreads(vfs: Vfs): string[] {
  const interrupted: string[] = []
  for (const name of listSessions(vfs)) {
    const stem = name.endsWith('.json') ? name.slice(0, -5) : name
    const loaded = loadSession(vfs, stem)
    if ('error' in loaded) continue
    if (loaded.session.liveRun === true) interrupted.push(stem)
  }
  return interrupted
}

/** Short continuation prompt for a rescheduled interrupted thread. */
export function resumePromptFor(_threadId: string): string {
  return RESUME_PROMPT
}
