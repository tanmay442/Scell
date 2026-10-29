import { describe, expect, it, afterEach } from 'vitest'
import { createVfs } from '../../vfs'
import { runAgent } from './agent'
import { loadSession, listSessions } from './agent-sessions'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function anthropicText(text: string) {
  return { content: [{ type: 'text', text }] }
}
function anthropicTools(calls: { id: string; name: string; input: Record<string, unknown> }[]) {
  return { content: calls.map((call) => ({ type: 'tool_use', ...call })) }
}

describe('interrupted run persistence', () => {
  it('step 1 is on disk (flagged live) before step 2 model call runs', async () => {
    const vfs = createVfs()
    vfs.mkdir('/home/user/.cell')
    vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'anthropic', apiKey: 'k' }))
    const shell = { exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) }
    let sessionAtStep2: unknown = null
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response(JSON.stringify(anthropicTools([{ id: 't1', name: 'bash', input: { command: 'echo hi' } }])), { status: 200 })
      // step 2 begins: inspect what a tab-death right now would resume from
      const ids = listSessions(vfs)
      const loaded = loadSession(vfs, ids[0].replace(/\.json$/, ''))
      sessionAtStep2 = 'error' in loaded ? loaded.error : loaded.session
      return new Response(JSON.stringify(anthropicText('done')), { status: 200 })
    }) as typeof fetch

    const result = await runAgent(vfs, ['do a thing'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    const mid = sessionAtStep2 as { turns: unknown[]; liveRun?: boolean }
    expect(mid.liveRun).toBe(true)
    expect(JSON.stringify(mid.turns)).toContain('echo hi')

    // after normal completion the flag is gone
    const ids = listSessions(vfs)
    const loaded = loadSession(vfs, ids[0].replace(/\.json$/, ''))
    expect('error' in loaded).toBe(false)
    if (!('error' in loaded)) expect(loaded.session.liveRun).toBeUndefined()
  })
})
