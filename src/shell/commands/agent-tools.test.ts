import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import {
  interpolateArgs,
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
