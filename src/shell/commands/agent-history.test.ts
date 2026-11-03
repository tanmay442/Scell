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

describe('agent-history redaction + count receipt', () => {
  it('redacts secrets from snippets even when the file was hand-written', () => {
    const vfs = createVfs()
    // bypass saveSession (which redacts) to simulate a legacy file
    vfs.write(
      '/home/user/.cell/sessions/agent-legacy.json',
      JSON.stringify({
        id: 'agent-legacy',
        startedAt: '2026-01-01T00:00:00.000Z',
        provider: 'meta',
        model: 'm',
        prompt: 'deploy notes',
        transcript: [],
        turns: [{ role: 'tool', text: '', toolResults: [{ id: '1', content: 'key xoxb-123456789012-ABCDEFGHIJ here' }] }],
        steps: 1,
      }),
    )
    const hits = searchHistory(vfs, 'xoxb')
    expect(hits.length).toBe(1)
    expect(hits[0].snippet).not.toContain('xoxb-123456789012-ABCDEFGHIJ')
  })

  it('adds a receipt when older sessions fall outside the scan cap', async () => {
    const { runTool } = await import('./agent-tools')
    const vfs = createVfs()
    for (let i = 0; i < 205; i++) {
      saveSession(vfs, {
        id: `agent-${String(i).padStart(4, '0')}`,
        startedAt: '2026-01-01T00:00:00.000Z',
        provider: 'meta',
        model: 'm',
        prompt: `common topic task ${i}`,
        transcript: [],
        turns: [],
        steps: 1,
      })
    }
    const out = await runTool(
      { vfs, shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, cwd: '/home/user' } as never,
      { id: 'h', name: 'history_search', input: { query: 'common topic', limit: 3 } },
    )
    expect(out.isError).toBeFalsy()
    expect(out.content).toMatch(/searched the 200 newest of 205 sessions/)
  })
})

describe('agent-history perf guards', () => {
  it('skips oversized sessions with a receipt and memoizes repeats', async () => {
    const { searchHistory, lastHistorySkippedBig } = await import('./agent-history')
    const vfs = createVfs()
    seed(vfs)
    vfs.write('/home/user/.cell/sessions/agent-big.json', JSON.stringify({ id: 'agent-big', prompt: 'x'.repeat(300 * 1024) }))
    const first = searchHistory(vfs, 'login')
    expect(lastHistorySkippedBig()).toBe(1)
    const second = searchHistory(vfs, 'login')
    expect(second).toEqual(first)
    expect(lastHistorySkippedBig()).toBe(1)
  })
})
