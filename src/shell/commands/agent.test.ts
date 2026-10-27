import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { runAgent } from './agent'
import { projectRoot, findBins, GLOBAL_ROOT } from './install'

function agentVfs() {
  const vfs = createVfs()
  vfs.mkdir('/home/user/.cell')
  vfs.write('/home/user/.cell/agent.json', JSON.stringify({ provider: 'anthropic', apiKey: 'test-key' }))
  return vfs
}

function stubAnthropic(script: { content: unknown[] }[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  let call = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const turn = script[Math.min(call++, script.length - 1)]
    return new Response(JSON.stringify({ content: turn.content }), { status: 200 })
  }) as typeof fetch
  return { requests, restore: () => (globalThis.fetch = original) }
}

describe('cell agent loop', () => {
  it('runs tool calls through the shell and returns the transcript', async () => {
    const vfs = agentVfs()
    const executed: string[] = []
    const shell = {
      exec: async (cmd: string) => {
        executed.push(cmd)
        return { stdout: `out: ${cmd}`, stderr: '', exitCode: 0 }
      },
    }
    const stub = stubAnthropic([
      { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo hi' } }] },
      { content: [{ type: 'text', text: 'all done, agent out' }] },
    ])
    try {
      const result = await runAgent(vfs, ['fix', 'the', 'thing'], { cwd: '/home/user', shell })
      expect(result.exitCode).toBe(0)
      expect(executed).toEqual(['echo hi'])
      expect(result.stdout).toContain('⏺ bash echo hi')
      expect(result.stdout).toContain('out: echo hi')
      expect(result.stdout).toContain('all done, agent out')

      // both API calls carried the browser-direct header and the tool defs
      expect(stub.requests[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true')
      expect(stub.requests[0].body.tools.map((t: { name: string }) => t.name)).toContain('bash')
      // the second request contains the tool_result of the first turn
      expect(JSON.stringify(stub.requests[1].body.messages)).toContain('tool_result')
      expect(JSON.stringify(stub.requests[1].body.messages)).toContain('out: echo hi')
    } finally {
      stub.restore()
    }
  })

  it('writes files via the write tool', async () => {
    const vfs = agentVfs()
    const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    const stub = stubAnthropic([
      { content: [{ type: 'tool_use', id: 'w1', name: 'write', input: { path: '~/made/by-agent.ts', content: 'export const x = 1\n' } }] },
      { content: [{ type: 'text', text: 'written' }] },
    ])
    try {
      const result = await runAgent(vfs, ['create a file'], { cwd: '/home/user', shell })
      expect(result.exitCode).toBe(0)
      expect(vfs.read('/home/user/made/by-agent.ts')).toBe('export const x = 1\n')
    } finally {
      stub.restore()
    }
  })

  it('tells you how to configure without a key', async () => {
    const vfs = createVfs()
    const result = await runAgent(vfs, ['hello'], { cwd: '/home/user', shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('~/.cell/agent.json')
  })
})

describe('npm project roots and bins', () => {
  it('projectRoot walks up to the package.json owner', () => {
    const vfs = createVfs()
    vfs.write('/home/user/repo/package.json', '{}')
    vfs.write('/home/user/repo/src/main.ts', 'x')
    expect(projectRoot(vfs, '/home/user/repo/src')).toBe('/home/user/repo')
    expect(projectRoot(vfs, '/home/user/repo')).toBe('/home/user/repo')
    expect(projectRoot(vfs, '/home/user/other')).toBeNull()
  })

  it('findBins prefers project-local bins over global ones', () => {
    const vfs = createVfs()
    // global semver
    vfs.write(`${GLOBAL_ROOT}/semver/package.json`, JSON.stringify({ name: 'semver', bin: 'bin/semver.js' }))
    vfs.write(`${GLOBAL_ROOT}/semver/bin/semver.js`, '#!/usr/bin/env node\nconsole.log("global")\n')
    // project-local semver (different file content, same bin name)
    vfs.write('/home/user/repo/package.json', '{}')
    vfs.write('/home/user/repo/node_modules/semver/package.json', JSON.stringify({ name: 'semver', bin: 'bin/semver.js' }))
    vfs.write('/home/user/repo/node_modules/semver/bin/semver.js', '#!/usr/bin/env node\nconsole.log("local")\n')

    const fromProject = findBins(vfs, '/home/user/repo/src')
    expect(fromProject.get('semver')).toBe('/home/user/repo/node_modules/semver/bin/semver.js')
    const fromHome = findBins(vfs, '/home/user')
    expect(fromHome.get('semver')).toBe(`${GLOBAL_ROOT}/semver/bin/semver.js`)
  })
})
