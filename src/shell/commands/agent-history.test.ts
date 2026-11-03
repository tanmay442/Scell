import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs/vfs'
import { saveSession } from './agent-sessions'
import { searchHistory } from './agent-history'

function seed(vfs: ReturnType<typeof createVfs>) {
  const session = (id: string, prompt: string, turns: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>) =>
    saveSession(vfs, {
      id,
      startedAt: '2026-01-01T00:00:00.000Z',
      provider: 'meta',
      model: 'm',
      prompt,
      transcript: [prompt],
      turns,
      steps: 1,
    })
  session('agent-aaa', 'fix the login redirect bug', [{ role: 'user', text: 'fix the login redirect bug' }])
  session('agent-bbb', 'deploy the new landing page', [
    { role: 'user', text: 'deploy the new landing page' },
    { role: 'assistant', text: 'deployed to preview, login redirect works now' },
  ])
}

describe('agent-history', () => {
  it('finds topics across sessions with snippets', () => {
    const vfs = createVfs()
    seed(vfs)
    const hits = searchHistory(vfs, 'login redirect')
    expect(hits.length).toBe(2)
    // agent-aaa mentions it twice (prompt + turn), agent-bbb once
    expect(hits[0].sessionId).toBe('agent-aaa')
    expect(hits[0].snippet).toContain('login redirect')
    expect(hits[1].sessionId).toBe('agent-bbb')
  })

  it('returns nothing for misses and blank queries', () => {
    const vfs = createVfs()
    seed(vfs)
    expect(searchHistory(vfs, 'zebra quasar')).toEqual([])
    expect(searchHistory(vfs, '   ')).toEqual([])
  })

  it('respects the limit', () => {
    const vfs = createVfs()
    seed(vfs)
    expect(searchHistory(vfs, 'the', 1)).toHaveLength(1)
  })

  it('survives corrupt session files', () => {
    const vfs = createVfs()
    seed(vfs)
    vfs.write('/home/user/.cell/sessions/agent-zzz.json', '{{broken')
    expect(() => searchHistory(vfs, 'login')).not.toThrow()
    expect(searchHistory(vfs, 'login').length).toBeGreaterThan(0)
  })
})
