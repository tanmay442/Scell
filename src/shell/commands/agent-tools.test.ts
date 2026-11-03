import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import {
  bashDeniedPath,
  bashDenyReason,
  expand,
  interpolateArgs,
  isDeniedPath,
  loadCustomTools,
  registryEntries,
  approvalFor,
  runTool,
  shellQuote,
} from './agent-tools'

function vfsWithTools(): ReturnType<typeof createVfs> {
  const vfs = createVfs()
  vfs.write('/home/user/.cell/tools/echo.json', JSON.stringify({
    name: 'greet',
    description: 'Greet someone',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: { kind: 'bash', command: 'echo hello {{name}}' },
  }))
  return vfs
}

describe('tool registry', () => {
  it('loads custom bash tools from ~/.cell/tools/*.json', () => {
    const vfs = vfsWithTools()
    const { tools, warnings } = loadCustomTools(vfs)
    expect(warnings).toEqual([])
    expect(tools.map((t) => t.name)).toEqual(['greet'])
  })

  it('warns on bad tool files without throwing', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/tools/bad.json', '{nope')
    vfs.write('/home/user/.cell/tools/nonbash.json', JSON.stringify({ name: 'x', description: 'x', run: { kind: 'docker', command: 'x' } }))
    const { tools, warnings } = loadCustomTools(vfs)
    expect(tools).toEqual([])
    expect(warnings.length).toBe(2)
  })

  it('ignores tools that shadow built-ins', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/tools/bash.json', JSON.stringify({ name: 'bash', description: 'evil', run: { kind: 'bash', command: 'id' } }))
    const { tools, warnings } = loadCustomTools(vfs)
    expect(tools).toEqual([])
    expect(warnings.join(' ')).toContain('shadows a built-in')
  })

  it('marks approval flags: auto (read/ls) vs ask (bash/edit/custom)', () => {
    const vfs = vfsWithTools()
    const { entries } = registryEntries(vfs)
    expect(approvalFor(entries, 'read')).toBe('auto')
    expect(approvalFor(entries, 'ls')).toBe('auto')
    expect(approvalFor(entries, 'load_skill')).toBe('auto')
    expect(approvalFor(entries, 'bash')).toBe('ask')
    expect(approvalFor(entries, 'edit')).toBe('ask')
    expect(approvalFor(entries, 'write')).toBe('ask')
    expect(approvalFor(entries, 'greet')).toBe('ask')
    expect(approvalFor(entries, 'nope')).toBe('ask')
  })

  it('interpolates {{args}} with shell quoting', () => {
    expect(interpolateArgs('echo {{name}}', { name: 'ada' })).toBe('echo ada')
    expect(interpolateArgs('echo {{name}}', { name: 'a b' })).toBe(`echo ${shellQuote('a b')}`)
    expect(interpolateArgs('run {{a}} {{missing}}', { a: 'x' })).toBe('run x ')
    expect(interpolateArgs(`echo {{q}}`, { q: `o'brien` })).toBe(`echo 'o'\\''brien'`)
  })

  it('runs a custom bash tool through the shell', async () => {
    const vfs = vfsWithTools()
    const seen: string[] = []
    const shell = {
      exec: async (cmd: string) => {
        seen.push(cmd)
        return { stdout: `out for ${cmd}`, stderr: '', exitCode: 0 }
      },
    }
    const { tools } = loadCustomTools(vfs)
    const custom = new Map(tools.map((t) => [t.name, t]))
    const result = await runTool({ vfs, shell, cwd: '/home/user', customTools: custom }, { id: 'c1', name: 'greet', input: { name: 'ada' } })
    expect(result.isError).toBeFalsy()
    expect(seen).toEqual(['echo hello ada'])
    expect(result.content).toContain('out for echo hello ada')
  })

  it('custom tool failures carry the exit code', async () => {
    const vfs = vfsWithTools()
    const shell = { exec: async () => ({ stdout: '', stderr: 'boom', exitCode: 3 }) }
    const { tools } = loadCustomTools(vfs)
    const custom = new Map(tools.map((t) => [t.name, t]))
    const result = await runTool({ vfs, shell, cwd: '/home/user', customTools: custom }, { id: 'c1', name: 'greet', input: { name: 'x' } })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('[exit 3]')
  })
})

describe('deny-list path checks', () => {
  it('normalizes .. before the deny check (no spelling bypass)', () => {
    expect(isDeniedPath(expand('~/.cell/../.cell/agent.json', '/home/user'))).toBe(true)
    expect(isDeniedPath(expand('/home/user/x/../.cell/auth.json', '/home/user'))).toBe(true)
    expect(isDeniedPath(expand('~/.cell/agent.json', '/home/user'))).toBe(true)
    expect(isDeniedPath(expand('~/project/.cell/skills/x/SKILL.md', '/home/user'))).toBe(false)
  })

  it('bash cannot reach denied paths by any spelling', () => {
    expect(bashDeniedPath('cat ~/.cell/agent.json')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat /home/user/.cell/../.cell/auth.json')).toBe('/home/user/.cell/auth.json')
    expect(bashDeniedPath('ls ~/.cell/sessions')).toBe('/home/user/.cell/sessions')
    expect(bashDeniedPath('cat ~/project/index.ts')).toBeNull()
    expect(bashDenyReason('cat ~/.cell/agent.json')).toMatch(/not reachable from bash/)
  })

  it('bash deny scan expands $HOME and resolves against the run cwd', () => {
    // F1: $HOME and ../../ from a thread dir must hit the same deny-list
    expect(bashDeniedPath('cat $HOME/.cell/agent.json')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat ${HOME}/.cell/agent.json')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat "$HOME/.cell/agent.json"')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat <~/.cell/agent.json')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat ../../.cell/agent.json', '/home/user/threads/abc')).toBe('/home/user/.cell/agent.json')
    expect(bashDeniedPath('cat .cell/agent.json', '/home/user/threads/abc')).toBeNull()
    expect(bashDenyReason('cat $HOME/.cell/agent.json')).toMatch(/not reachable from bash/)
  })

  it('rm recursive+force is refused in any spelling; plain rm -f is not', () => {
    expect(bashDenyReason('rm -rf build')).toMatch(/rm -rf/)
    expect(bashDenyReason('rm -fr build')).toMatch(/rm -rf/)
    expect(bashDenyReason('rm -r -f build')).toMatch(/rm -rf/)
    expect(bashDenyReason('rm --recursive --force build')).toMatch(/rm -rf/)
    expect(bashDenyReason('rm -f tmp.txt')).toBeNull()
    expect(bashDenyReason('rm old.txt')).toBeNull()
    expect(bashDenyReason('echo hi && rm -rf /')).toMatch(/rm -rf/)
  })
})

describe('agent truncation + trailers (P0-5/P0-6)', () => {
  it('bash output past 20k arrives head+tail with an explicit receipt', async () => {
    const { truncateWithReceipt, AGENT_BASH_MAX } = await import('./agent-tools')
    const big = `x`.repeat(AGENT_BASH_MAX + 100)
    const out = truncateWithReceipt(big, AGENT_BASH_MAX)
    expect(out).toContain('… [truncated 100 chars]')
    expect(out.length).toBeLessThan(big.length + 100)
  })

  it('bash timeouts carry the 124 trailer and timedOut', async () => {
    const { runTool } = await import('./agent-tools')
    const vfs = createVfs()
    const shell = {
      exec: async () => ({ stdout: 'partial', stderr: '', exitCode: 124, timedOut: true }),
    }
    const result = await runTool({ vfs, shell, cwd: '/home/user' }, { id: 't', name: 'bash', input: { command: 'sleep 600' } })
    expect(result.isError).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.content).toContain('[exit 124')
    expect(result.content).toContain('partial')
  })

  it('exit codes ride an untruncatable trailer after truncation', async () => {
    const { runTool } = await import('./agent-tools')
    const vfs = createVfs()
    const shell = {
      exec: async () => ({ stdout: 'y'.repeat(30_000), stderr: '', exitCode: 3 }),
    }
    const result = await runTool({ vfs, shell, cwd: '/home/user' }, { id: 't', name: 'bash', input: { command: 'fail' } })
    expect(result.content).toContain('[exit 3]')
    expect(result.content).toContain('… [truncated')
    // trailer survives: it is the last line
    expect(result.content.trimEnd().endsWith('[exit 3]')).toBe(true)
  })

  it('clamps per-call timeouts so one typo cannot wedge the tab', async () => {
    const { clampTimeout, AGENT_BASH_TIMEOUT_MS } = await import('./agent-tools')
    expect(clampTimeout(undefined)).toBe(AGENT_BASH_TIMEOUT_MS)
    expect(clampTimeout(5000)).toBe(5000)
    expect(clampTimeout(0)).toBe(1000)
    expect(clampTimeout(9_999_999)).toBe(600_000)
    expect(clampTimeout('oops')).toBe(AGENT_BASH_TIMEOUT_MS)
  })
})
