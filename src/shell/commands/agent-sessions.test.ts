import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { saveSession, loadSession, listSessions, truncateTurns, type AgentSession, type SessionTurn } from './agent-sessions'

function session(id = 'agent-20240101-000000-abc'): AgentSession {
  return {
    id,
    startedAt: '2024-01-01T00:00:00.000Z',
    provider: 'meta',
    model: 'muse-spark-1.3-contributor',
    prompt: 'do things',
    transcript: ['agent ▸ do things'],
    turns: [
      { role: 'user', text: 'do things' },
      { role: 'assistant', text: 'done' },
    ],
    steps: 1,
  }
}

describe('sessions', () => {
  it('save/resume round-trips transcript and turns', () => {
    const vfs = createVfs()
    const path = saveSession(vfs, session())
    expect(path).toBe('/home/user/.cell/sessions/agent-20240101-000000-abc.json')
    const loaded = loadSession(vfs, 'agent-20240101-000000-abc')
    expect('session' in loaded).toBe(true)
    if ('session' in loaded) {
      expect(loaded.session.prompt).toBe('do things')
      expect(loaded.session.turns.length).toBe(2)
      expect(loaded.session.transcript).toEqual(['agent ▸ do things'])
    }
  })

  it('loads with or without the .json suffix', () => {
    const vfs = createVfs()
    saveSession(vfs, session())
    expect('session' in loadSession(vfs, 'agent-20240101-000000-abc.json')).toBe(true)
  })

  it('missing sessions error cleanly and listSessions sorts newest first', () => {
    const vfs = createVfs()
    expect(loadSession(vfs, 'nope')).toHaveProperty('error')
    expect(listSessions(vfs)).toEqual([])
    saveSession(vfs, session('agent-20240101-000000-aaa'))
    saveSession(vfs, session('agent-20240102-000000-bbb'))
    expect(listSessions(vfs)).toEqual(['agent-20240102-000000-bbb.json', 'agent-20240101-000000-aaa.json'])
  })

  it('truncation keeps the first prompt and the tail', () => {
    const turns: SessionTurn[] = [
      { role: 'user', text: 'first' },
      ...Array.from({ length: 60 }, (_, i): SessionTurn => ({ role: 'assistant', text: `turn ${i}` })),
    ]
    const capped = truncateTurns(turns)
    expect(capped.length).toBeLessThanOrEqual(40)
    expect(capped[0].text).toBe('first')
    expect(capped[capped.length - 1].text).toBe('turn 59')
  })

  it('secrets never land in the saved session', () => {
    const vfs = createVfs()
    const dirty = session()
    dirty.turns = [{ role: 'user', text: 'key LLM_abcdefgh12345678 here' }]
    saveSession(vfs, dirty)
    const raw = vfs.read('/home/user/.cell/sessions/agent-20240101-000000-abc.json')!
    expect(raw).not.toContain('LLM_abcdefgh12345678')
    expect(raw).toContain('[redacted]')
  })
})
