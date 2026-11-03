import { describe, expect, it } from 'vitest'
import { createVfs } from '../src/vfs'
import { RESUME_PROMPT, findInterruptedThreads, resumePromptFor } from './resume'

const SESSIONS_DIR = '/home/user/.cell/sessions'

function writeSession(vfs: ReturnType<typeof createVfs>, id: string, extra: Record<string, unknown>): void {
  vfs.write(
    `${SESSIONS_DIR}/${id}.json`,
    JSON.stringify({
      id,
      startedAt: new Date(0).toISOString(),
      provider: 'test',
      model: 'test',
      prompt: 'do a thing',
      transcript: [],
      turns: [],
      steps: 0,
      ...extra,
    }),
  )
}

describe('findInterruptedThreads', () => {
  it('detects sessions with liveRun true, ignores others, skips corrupt JSON', () => {
    const vfs = createVfs()
    writeSession(vfs, 'live-1', { liveRun: true })
    writeSession(vfs, 'live-2', { liveRun: true })
    writeSession(vfs, 'idle', { liveRun: false })
    writeSession(vfs, 'never-ran', {})
    vfs.write(`${SESSIONS_DIR}/corrupt.json`, 'not json {{{')
    vfs.write(`${SESSIONS_DIR}/notes.txt`, 'not a session')

    expect(findInterruptedThreads(vfs).sort()).toEqual(['live-1', 'live-2'])
  })

  it('returns [] when no sessions exist', () => {
    expect(findInterruptedThreads(createVfs())).toEqual([])
  })
})

describe('resumePromptFor', () => {
  it('returns the exact continuation prompt', () => {
    expect(RESUME_PROMPT).toBe('Continue where you left off. Do not stop, pause, or summarize until every remaining step of the task is fully complete, then report completion exactly as originally instructed.')
    expect(resumePromptFor('any-thread')).toBe(RESUME_PROMPT)
  })
})
