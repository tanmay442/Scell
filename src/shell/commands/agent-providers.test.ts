import { describe, expect, it, vi, afterEach } from 'vitest'
import { createVfs } from '../../vfs'
import { parseMetaSseEvents } from './agent-providers'
import { runAgent } from './agent'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllEnvs()
})

function metaVfs() {
  const vfs = createVfs()
  vfs.mkdir('/home/user/.cell')
  vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: 'test-meta-key' }))
  return vfs
}

function stubMeta(script: unknown[]) {
  const requests: { url: string; body: any }[] = []
  let call = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    const turn = script[Math.min(call++, script.length - 1)]
    return new Response(JSON.stringify(turn), { status: 200 })
  }) as typeof fetch
  return { requests }
}

describe('meta responses transport', () => {
  it('parses tool calls and chains follow-ups via previous_response_id', async () => {
    const vfs = metaVfs()
    const executed: string[] = []
    const shell = {
      exec: async (cmd: string) => {
        executed.push(cmd)
        return { stdout: 'hello-tool', stderr: '', exitCode: 0 }
      },
    }
    const stub = stubMeta([
      {
        id: 'resp_first',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'will run it' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{"command":"echo hi"}', status: 'completed' },
        ],
      },
      {
        id: 'resp_second',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'all done' }] }],
      },
    ])
    const result = await runAgent(vfs, ['run it'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['echo hi'])
    expect(result.stdout).toContain('all done')
    // first request carries input + tools; second chains previous_response_id
    expect(stub.requests[0].body.input[1].content[0].text).toBe('run it')
    expect(stub.requests[0].body.tools[0]).toMatchObject({ type: 'function', name: 'bash' })
    expect(stub.requests[1].body.previous_response_id).toBe('resp_first')
    expect(stub.requests[1].body.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'hello-tool' }])
  })

  it('treats incomplete status as truncation and continues', async () => {
    const vfs = metaVfs()
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    stubMeta([
      { id: 'resp_a', status: 'incomplete', output: [] },
      { id: 'resp_b', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }] },
    ])
    const result = await runAgent(vfs, ['go'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('truncated')
    expect(result.stdout).toContain('recovered')
  })

  it('streams deltas to onProgress when provided', async () => {
    const vfs = metaVfs()
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    const sse = [
      'event: response.output_text.delta',
      'data: {"delta":"streaming-hi"}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_s","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"streaming-hi"}]}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch
    const progress: string[] = []
    const result = await runAgent(vfs, ['hi'], { cwd: '/home/user', shell, onProgress: (line) => progress.push(line) })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('streaming-hi')
    expect(progress.join('')).toContain('streaming-hi')
  })

  it('parses SSE events incl. [DONE] terminator', () => {
    const raw = 'event: response.output_text.delta\ndata: {"delta":"a"}\n\nevent: response.completed\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n'
    const { deltas, final } = parseMetaSseEvents(raw)
    expect(deltas).toEqual(['a'])
    expect(final).toMatchObject({ id: 'r' })
  })

  it('resolves the meta key from the machine auth file when agent.json omits it', async () => {
    const vfs = createVfs()
    vfs.mkdir('/home/user/.cell')
    vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'meta', model: 'muse-spark-1.3-contributor' }))
    vi.stubEnv('CELL_AGENT_LIVE_KEY', 'env-meta-key')
    const seen: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)?.authorization ?? ''))
      return new Response(JSON.stringify({ id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }), { status: 200 })
    }) as typeof fetch
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    const result = await runAgent(vfs, ['hi'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(seen[0]).toBe('Bearer env-meta-key')
  })

  it('resume follow-up sends the new user message (not stale outputs)', async () => {
    const vfs = createVfs()
    vfs.mkdir('/home/user/.cell')
    vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: 'k' }))
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    const stub = stubMeta([
      { id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'noted' }] }] },
    ])
    const first = await runAgent(vfs, ['remember BLUEBIRD'], { cwd: '/home/user', shell })
    expect(first.exitCode).toBe(0)
    const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')
    const stub2 = stubMeta([
      { id: 'resp_2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'BLUEBIRD' }] }] },
    ])
    const second = await runAgent(vfs, ['--resume', sessionFile.replace(/\.json$/, ''), 'what was it?'], { cwd: '/home/user', shell })
    expect(second.exitCode).toBe(0)
    // first request of the resumed run chains the prior response AND carries the new prompt
    const followUp = stub2.requests[0].body
    expect(followUp.previous_response_id).toBe('resp_1')
    expect(followUp.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('what was it?') }] }])
  })

  it('saves a session and resumes it', async () => {
    const vfs = metaVfs()
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    stubMeta([
      { id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first done' }] }] },
    ])
    const first = await runAgent(vfs, ['first task'], { cwd: '/home/user', shell })
    expect(first.exitCode).toBe(0)
    const sessions = vfs.readDir('/home/user/.cell/sessions')
    expect(sessions.length).toBe(1)
    const id = sessions[0].replace(/\.json$/, '')
    stubMeta([
      { id: 'resp_2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'resumed ok' }] }] },
    ])
    const second = await runAgent(vfs, ['second task', '--resume', id], { cwd: '/home/user', shell })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('resumed ok')
    expect(second.stdout).toContain('(resumed')
  })

  it('expands /commit slash commands from the seed', async () => {
    const vfs = metaVfs()
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    const stub = stubMeta([
      { id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'committed' }] }] },
    ])
    const result = await runAgent(vfs, ['/commit'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(stub.requests[0].body.input[1].content[0].text).toContain('git status')
  })

  it('redacts secrets from the transcript', async () => {
    const vfs = metaVfs()
    vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'meta', model: 'm', apiKey: 'LLM_abcdefgh12345678' }))
    const shell = { exec: async () => ({ stdout: 'leaked LLM_abcdefgh12345678 here', stderr: '', exitCode: 0 }) }
    stubMeta([
      { id: 'r1', status: 'completed', output: [{ type: 'function_call', id: 'fc', call_id: 'c', name: 'bash', arguments: '{"command":"env"}', status: 'completed' }] },
      { id: 'r2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] },
    ])
    const result = await runAgent(vfs, ['go'], { cwd: '/home/user', shell })
    expect(result.stdout).not.toContain('LLM_abcdefgh12345678')
  })
})
