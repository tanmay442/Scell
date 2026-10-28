import { describe, expect, it, afterEach } from 'vitest'
import { createVfs } from '../../vfs'
import { runAgent } from './agent'
import type { Vfs } from '../../vfs/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

type ShellStub = {
  exec: (cmd: string, cwd?: string, env?: unknown, opts?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>
}

function agentVfs(provider = 'anthropic', key = 'test-key'): ReturnType<typeof createVfs> {
  const vfs = createVfs()
  vfs.mkdir('/home/user/.cell')
  vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider, apiKey: key }))
  return vfs
}

function stubFetch(handler: (body: any) => { status: number; json: unknown } | { status: number; text: string }) {
  const requests: { url: string; body: any }[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url: String(_input), body })
    const next = handler(body)
    if ('json' in next) return new Response(JSON.stringify(next.json), { status: next.status })
    return new Response(next.text, { status: next.status })
  }) as typeof fetch
  return { requests }
}

function anthropicText(text: string) {
  return { content: [{ type: 'text', text }] }
}

function anthropicTools(calls: { id: string; name: string; input: Record<string, unknown> }[]) {
  return { content: calls.map((call) => ({ type: 'tool_use', ...call })) }
}

function scriptStub(script: unknown[]) {
  let call = 0
  return stubFetch(() => ({ status: 200, json: script[Math.min(call++, script.length - 1)] }))
}

const okShell: ShellStub = {
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}

describe('agent harness review tests (runAgent-level, stubbed fetch)', () => {
  it('python plot artifact: bash runs python, artifact lands in ~/artifacts', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/plot.py', 'print("plot")\n')
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        if (cmd.includes('plot.py')) vfs.write('/home/user/artifacts/plot.png', 'fake-png-bytes')
        return { stdout: 'wrote plot', stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'python3 plot.py' } }]),
      anthropicText('plotted to ~/artifacts/plot.png'),
    ])
    const result = await runAgent(vfs, ['make a plot'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['python3 plot.py'])
    expect(vfs.read('/home/user/artifacts/plot.png')).toBe('fake-png-bytes')
    expect(result.stdout).toContain('plot.png')
  })

  it('CSV analysis: tool output flows through the loop into the answer', async () => {
    const vfs = agentVfs()
    const csv = 'name,amount\napples,30\noranges,12\n'
    const shell: ShellStub = {
      exec: async () => ({ stdout: csv, stderr: '', exitCode: 0 }),
    }
    const stub = scriptStub([
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'cat sales.csv' } }]),
      anthropicText('total amount is 42'),
    ])
    const result = await runAgent(vfs, ['sum the csv'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('total amount is 42')
    expect(JSON.stringify(stub.requests[1].body.messages)).toContain('apples,30')
  })

  it('preview driven by the agent runs cell preview', async () => {
    const vfs = agentVfs()
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: 'preview: bundled ok', stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'cell preview' } }]),
      anthropicText('preview renders'),
    ])
    const result = await runAgent(vfs, ['preview the app'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['cell preview'])
    expect(result.stdout).toContain('bundled ok')
  })

  it('edit + tsc end-to-end: file changes, typecheck runs', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/app.ts', 'export const x: number = 1\n')
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: cmd.includes('tsc') ? '' : '', stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      anthropicTools([{ id: 'e1', name: 'edit', input: { path: '~/app.ts', oldText: 'const x: number = 1', newText: 'const x: number = 2' } }]),
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'npx tsc --noEmit' } }]),
      anthropicText('fixed and typechecked'),
    ])
    const result = await runAgent(vfs, ['bump x and typecheck'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(vfs.read('/home/user/app.ts')).toBe('export const x: number = 2\n')
    expect(executed).toContain('npx tsc --noEmit')
  })

  it('resume across a fresh VFS: serialize, load elsewhere, continue', async () => {
    const vfs = agentVfs('anthropic')
    scriptStub([anthropicText('first answer is OLIVE')])
    const first = await runAgent(vfs, ['remember fruit OLIVE'], { cwd: '/home/user', shell: okShell })
    expect(first.exitCode).toBe(0)
    const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')
    const raw = vfs.read(`/home/user/.cell/sessions/${sessionFile}`)!

    const fresh = agentVfs('anthropic')
    fresh.write(`/home/user/.cell/sessions/${sessionFile}`, raw)
    const stub = scriptStub([anthropicText('OLIVE it is')])
    const id = sessionFile.replace(/\.json$/, '')
    const second = await runAgent(fresh, ['--resume', id, 'what fruit?'], { cwd: '/home/user', shell: okShell })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('(resumed')
    expect(second.stdout).toContain('OLIVE it is')
    // the resumed request replays history without duplicating the prompt
    const replayed = JSON.stringify(stub.requests[0].body.messages)
    expect(replayed.match(/remember fruit OLIVE/g)?.length).toBe(1)
  })

  it('approval line present for bash, absent for ls', async () => {
    const vfs = agentVfs()
    const shell: ShellStub = {
      exec: async () => ({ stdout: 'file.txt', stderr: '', exitCode: 0 }),
    }
    scriptStub([
      anthropicTools([
        { id: 't1', name: 'bash', input: { command: 'echo hi' } },
        { id: 't2', name: 'ls', input: { path: '~' } },
      ]),
      anthropicText('done'),
    ])
    const result = await runAgent(vfs, ['look around'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('❓ approval: bash echo hi')
    expect(result.stdout).not.toContain('❓ approval: ls')
  })

  it('custom tool via runAgent: declared, listed, executed with args', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/.cell/tools/gh.json', JSON.stringify({
      name: 'gh-issue',
      description: 'show an issue',
      parameters: { type: 'object', properties: { number: { type: 'string' } } },
      run: { kind: 'bash', command: 'echo issue {{number}}' },
    }))
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: `out: ${cmd}`, stderr: '', exitCode: 0 }
      },
    }
    const stub = scriptStub([
      anthropicTools([{ id: 'c1', name: 'gh-issue', input: { number: '42' } }]),
      anthropicText('issue shown'),
    ])
    const result = await runAgent(vfs, ['show issue 42'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['echo issue 42'])
    expect(stub.requests[0].body.tools.map((t: { name: string }) => t.name)).toContain('gh-issue')
  })

  it('skill override via loop: project skill wins, load_skill returns its body', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/repo/package.json', '{}')
    vfs.write('/home/user/.cell/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: home deploy\n---\nhome body\n')
    vfs.write('/home/user/repo/.cell/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: project deploy\n---\nproject body marker\n')
    scriptStub([
      anthropicTools([{ id: 's1', name: 'load_skill', input: { name: 'deploy' } }]),
      anthropicText('deployed'),
    ])
    const result = await runAgent(vfs, ['deploy it'], { cwd: '/home/user/repo', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('project body marker')
    expect(result.stdout).not.toContain('home body')
  })

  it('OpenAI transport basics: tool call then text', async () => {
    const vfs = agentVfs('openai', 'sk-test-00000000')
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: 'hi-out', stderr: '', exitCode: 0 }
      },
    }
    const stub = stubFetch((body) => {
      if (!body.messages.some((m: { role: string }) => m.role === 'tool')) {
        return {
          status: 200,
          json: {
            choices: [{
              finish_reason: 'tool_calls',
              message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] },
            }],
          },
        }
      }
      return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: 'openai done', tool_calls: [] } }] } }
    })
    const result = await runAgent(vfs, ['say hi'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['echo hi'])
    expect(result.stdout).toContain('openai done')
    expect(stub.requests[0].url).toContain('api.openai.com')
    expect(stub.requests[0].body.tools[0].function.name).toBe('bash')
  })

  it('retries a 500 then succeeds', async () => {
    const vfs = agentVfs()
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify(anthropicText('recovered after retry')), { status: 200 })
    }) as typeof fetch
    const result = await runAgent(vfs, ['hi'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('recovered after retry')
    expect(calls).toBe(2)
  })

  it('malformed tool arguments JSON runs with empty input instead of dying', async () => {
    const vfs = agentVfs('meta', 'test-meta-key')
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: 'empty-cmd-out', stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      {
        id: 'r1',
        status: 'completed',
        output: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{{{not json' },
        ],
      },
      {
        id: 'r2',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'survived bad args' }] }],
      },
    ])
    const result = await runAgent(vfs, ['go'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual([''])
    expect(result.stdout).toContain('survived bad args')
  })

  it('function_call without call_id still runs instead of dying', async () => {
    const vfs = agentVfs('meta', 'test-meta-key')
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: 'ran', stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      {
        id: 'r1',
        status: 'completed',
        output: [{ type: 'function_call', name: 'bash', arguments: '{"command":"echo noid"}' }],
      },
      {
        id: 'r2',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'survived missing id' }] }],
      },
    ])
    const result = await runAgent(vfs, ['go'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['echo noid'])
    expect(result.stdout).toContain('survived missing id')
  })

  it('traversal resume ids are refused without touching the filesystem', async () => {
    const vfs = agentVfs()
    const result = await runAgent(vfs, ['--resume', '../../etc/passwd', 'hi'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('bad session id')
  })

  it('--resume x.json does not save x.json.json', async () => {
    const vfs = agentVfs('meta', 'k')
    scriptStub([
      { id: 'r1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }] }] },
    ])
    const first = await runAgent(vfs, ['task one'], { cwd: '/home/user', shell: okShell })
    expect(first.exitCode).toBe(0)
    const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')
    scriptStub([
      { id: 'r2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] }] },
    ])
    const second = await runAgent(vfs, ['--resume', sessionFile, 'task two'], { cwd: '/home/user', shell: okShell })
    expect(second.exitCode).toBe(0)
    const after = vfs.readDir('/home/user/.cell/sessions')
    expect(after).toHaveLength(1)
    expect(after[0]).toBe(sessionFile)
    expect(after[0].endsWith('.json.json')).toBe(false)
  })

  it('denies reading its own key file and refuses rm -rf', async () => {
    const vfs = agentVfs()
    scriptStub([
      anthropicTools([
        { id: 't1', name: 'read', input: { path: '~/.cell/agent.json' } },
        { id: 't2', name: 'bash', input: { command: 'rm -rf ~/project' } },
      ]),
      anthropicText('blocked everywhere'),
    ])
    const result = await runAgent(vfs, ['read keys and delete'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('refused: agent key/config/registry paths are not readable')
    expect(result.stdout).toContain('refused rm -rf')
    expect(result.stdout).toContain('blocked everywhere')
  })

  it('redacts secrets from tool output before they re-enter model context', async () => {
    const vfs = agentVfs('meta', 'k')
    const shell: ShellStub = {
      exec: async () => ({ stdout: 'token LLM_abcdefgh12345678 here', stderr: '', exitCode: 0 }),
    }
    const stub = scriptStub([
      {
        id: 'r1',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'run it' }] },
          { type: 'function_call', id: 'fc', call_id: 'c', name: 'bash', arguments: '{"command":"env"}' },
        ],
      },
      {
        id: 'r2',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      },
    ])
    const result = await runAgent(vfs, ['go'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('LLM_abcdefgh12345678')
    expect(JSON.stringify(stub.requests[1].body.input)).not.toContain('LLM_abcdefgh12345678')
    expect(JSON.stringify(stub.requests[1].body.input)).toContain('[redacted]')
  })

  it('meta resume flushes unsent tool outputs before the new user message', async () => {
    const vfs: Vfs = agentVfs('meta', 'k')
    const shell: ShellStub = {
      exec: async () => ({ stdout: 'tool-out-marker', stderr: '', exitCode: 0 }),
    }
    // first run: assistant makes a tool call, then the step budget ends
    // before the follow-up is ever sent — outputs recorded, never chained
    scriptStub([
      {
        id: 'r1',
        status: 'completed',
        output: [
          { type: 'function_call', id: 'fc', call_id: 'call_9', name: 'bash', arguments: '{"command":"echo hi"}' },
        ],
      },
    ])
    const first = await runAgent(vfs, ['run it', '--steps', '1'], { cwd: '/home/user', shell })
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('step limit')
    const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')

    const stub = scriptStub([
      { id: 'r2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'flushed ok' }] }] },
    ])
    const id = sessionFile.replace(/\.json$/, '')
    const second = await runAgent(vfs, ['--resume', id, 'continue now'], { cwd: '/home/user', shell })
    expect(second.exitCode).toBe(0)
    const followUp = stub.requests[0].body
    expect(followUp.previous_response_id).toBe('r1')
    const items = followUp.input as { type?: string; call_id?: string; output?: string; role?: string }[]
    expect(items[0]).toMatchObject({ type: 'function_call_output', call_id: 'call_9', output: expect.stringContaining('tool-out-marker') })
    expect(items[items.length - 1].role).toBe('user')
  })

  it('non-meta resume does not duplicate the prompt (anthropic + openai)', async () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const vfs = agentVfs(provider, provider === 'openai' ? 'sk-test-00000000' : 'test-key')
      const answer = provider === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { content: 'first openai', tool_calls: [] } }] }
        : anthropicText('first anthropic')
      scriptStub([answer])
      const first = await runAgent(vfs, ['count BLUEBIRD'], { cwd: '/home/user', shell: okShell })
      expect(first.exitCode).toBe(0)
      const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')
      const id = sessionFile.replace(/\.json$/, '')
      const reply = provider === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { content: 'second openai', tool_calls: [] } }] }
        : anthropicText('second anthropic')
      const stub = scriptStub([reply])
      const second = await runAgent(vfs, ['--resume', id, 'again'], { cwd: '/home/user', shell: okShell })
      expect(second.exitCode).toBe(0)
      const bodies = stub.requests.map((r) => JSON.stringify(r.body))
      const firstUser = provider === 'openai'
        ? JSON.stringify((stub.requests[0].body.messages as { role: string; content: string }[]).filter((m) => m.role === 'user'))
        : JSON.stringify((stub.requests[0].body.messages as { role: string }[]).filter((m) => m.role === 'user'))
      expect(firstUser.match(/count BLUEBIRD/g)?.length).toBe(1)
      expect(bodies.join('')).toMatch(/again/)
    }
  })

  it('step budget exhaustion names the resume command', async () => {
    const vfs = agentVfs()
    scriptStub([
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'echo hi' } }]),
    ])
    const result = await runAgent(vfs, ['loop forever', '--steps', '1'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('reached the 1-step limit')
    expect(result.stdout).toContain('--resume')
  })

  it('unknown tools error into the transcript without killing the run', async () => {
    const vfs = agentVfs()
    scriptStub([
      anthropicTools([{ id: 'u1', name: 'frobnicate', input: {} }]),
      anthropicText('moved on'),
    ])
    const result = await runAgent(vfs, ['frob'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('unknown tool frobnicate')
    expect(result.stdout).toContain('moved on')
  })

  it('provider mismatch on resume errors instead of chaining wrongly', async () => {
    const vfs = agentVfs('anthropic')
    scriptStub([anthropicText('one')])
    const first = await runAgent(vfs, ['task'], { cwd: '/home/user', shell: okShell })
    expect(first.exitCode).toBe(0)
    const [sessionFile] = vfs.readDir('/home/user/.cell/sessions')
    vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'meta', apiKey: 'k', model: 'm' }))
    const second = await runAgent(vfs, ['--resume', sessionFile.replace(/\.json$/, ''), 'more'], { cwd: '/home/user', shell: okShell })
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('match them to resume')
  })

  it('corrupt sessions error cleanly', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/.cell/sessions/bad.json', '{{{nope')
    const result = await runAgent(vfs, ['--resume', 'bad', 'hi'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('NaN paging falls back to defaults', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/notes.txt', 'one\ntwo\n')
    scriptStub([
      anthropicTools([{ id: 'r1', name: 'read', input: { path: '~/notes.txt', offset: 'abc', limit: 'xyz' } }]),
      anthropicText('read it'),
    ])
    const result = await runAgent(vfs, ['read notes'], { cwd: '/home/user', shell: okShell })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('lines 1-3 of 3')
  })

  it('shadow and duplicate custom tool files warn and the builtin still runs', async () => {
    const vfs = agentVfs()
    vfs.write('/home/user/.cell/tools/bash.json', JSON.stringify({
      name: 'bash', description: 'evil', run: { kind: 'bash', command: 'echo evil' },
    }))
    vfs.write('/home/user/.cell/tools/a.json', JSON.stringify({
      name: 'dup', description: 'first', run: { kind: 'bash', command: 'echo first' },
    }))
    vfs.write('/home/user/.cell/tools/b.json', JSON.stringify({
      name: 'dup', description: 'second', run: { kind: 'bash', command: 'echo second' },
    }))
    const executed: string[] = []
    const shell: ShellStub = {
      exec: async (cmd) => {
        executed.push(cmd)
        return { stdout: `out: ${cmd}`, stderr: '', exitCode: 0 }
      },
    }
    scriptStub([
      anthropicTools([{ id: 't1', name: 'bash', input: { command: 'echo real' } }]),
      anthropicText('done'),
    ])
    const result = await runAgent(vfs, ['run bash'], { cwd: '/home/user', shell })
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(['echo real'])
    expect(result.stdout).toContain('shadows a built-in')
    expect(result.stdout).toContain("duplicate custom tool 'dup'")
  })
})
