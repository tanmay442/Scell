import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { wrapProtectedVfs } from './protected-vfs'

function seeded() {
  const vfs = createVfs()
  vfs.write('/home/user/.cell/agent.json', '{"apiKey":"sk-testsecret123"}')
  vfs.write('/home/user/.cell/skills/commit/SKILL.md', '---\nname: commit\n---\nbody')
  vfs.write('/home/user/project/hello.txt', 'hello')
  return vfs
}

describe('wrapProtectedVfs', () => {
  it('protected reads look missing, never throw', () => {
    const wrapped = wrapProtectedVfs(seeded())
    expect(wrapped.read('/home/user/.cell/agent.json')).toBeNull()
    expect(wrapped.readBytes('/home/user/.cell/agent.json')).toBeNull()
    expect(wrapped.exists('/home/user/.cell/agent.json')).toBe(false)
    expect(wrapped.isFile('/home/user/.cell/agent.json')).toBe(false)
    expect(wrapped.stat('/home/user/.cell/agent.json')).toBeNull()
    expect(wrapped.readDir('/home/user/.cell')).toEqual([])
  })

  it('listings and snapshots hide .cell entirely', () => {
    const vfs = seeded()
    const wrapped = wrapProtectedVfs(vfs)
    expect(wrapped.readDir('/home/user')).not.toContain('.cell')
    expect(wrapped.listAllFiles()).toEqual(['/home/user/project/hello.txt'])
    expect(Object.keys(wrapped.snapshot())).toEqual(['/home/user/project/hello.txt'])
    // raw side untouched
    expect(vfs.read('/home/user/.cell/agent.json')).toContain('sk-testsecret123')
  })

  it('writes to protected paths throw EACCES; project writes pass', () => {
    const vfs = seeded()
    const wrapped = wrapProtectedVfs(vfs)
    expect(() => wrapped.write('/home/user/.cell/agent.json', 'x')).toThrow(/EACCES/)
    expect(() => wrapped.writeBytes('/home/user/.cell/x', new Uint8Array(1))).toThrow(/EACCES/)
    expect(() => wrapped.delete('/home/user/.cell/agent.json')).toThrow(/EACCES/)
    expect(() => wrapped.rename('/home/user/project/hello.txt', '/home/user/.cell/h.txt')).toThrow(/EACCES/)
    expect(() => wrapped.rename('/home/user/.cell/agent.json', '/home/user/project/a.txt')).toThrow(/EACCES/)
    expect(() => wrapped.restore({})).toThrow(/EACCES/)
    wrapped.write('/home/user/project/new.txt', 'ok')
    expect(vfs.read('/home/user/project/new.txt')).toBe('ok')
  })
})

describe('write-protected (readable) paths', () => {
  it('.bashrc reads pass, writes throw', () => {
    const vfs = seeded()
    vfs.write('/home/user/.bashrc', 'export X=1\n')
    const wrapped = wrapProtectedVfs(vfs)
    expect(wrapped.read('/home/user/.bashrc')).toContain('export X=1')
    expect(() => wrapped.write('/home/user/.bashrc', 'cat /home/user/.cell/agent.json\n')).toThrow(/EACCES/)
  })
})
