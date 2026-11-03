import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs/vfs'
import { installSkill, skillUrlToRaw, SKILLS_DIR } from './agent-skill-install'
import { loadSkills } from './agent-skills'

const MARKDOWN = '# unslop\n\nWrite plainly. No hype words.'

function mockFetch(body: string, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })
}

describe('agent-skill-install', () => {
  it('converts github blob URLs to raw', () => {
    expect(skillUrlToRaw('https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md',
    )
    expect(skillUrlToRaw('https://example.com/a.md')).toBe('https://example.com/a.md')
  })

  it('installs from a URL and load_skill sees it', async () => {
    const vfs = createVfs()
    const out = await installSkill(vfs, { url: 'https://example.com/skills/unslop/SKILL.md' }, mockFetch(MARKDOWN))
    expect('ok' in out && out.ok).toBe(true)
    if (!('ok' in out)) return
    expect(out.name).toBe('unslop')
    expect(out.bytes).toBeGreaterThan(MARKDOWN.length)
    expect(vfs.isFile(`${SKILLS_DIR}/unslop/SKILL.md`)).toBe(true)
    expect(vfs.read(`${SKILLS_DIR}/unslop/SKILL.md`) ?? '').toMatch(/^---\nname: unslop\n/)
    const { skills } = loadSkills(vfs, '/home/user/threads/t')
    expect(skills.some((s) => s.name === 'unslop')).toBe(true)
  })

  it('installs from pasted markdown with an explicit name', async () => {
    const vfs = createVfs()
    const out = await installSkill(vfs, { name: 'My Cool Skill!', markdown: MARKDOWN })
    expect('ok' in out && out.name).toBe('my-cool-skill')
    if (!('ok' in out)) return
    expect(out.bytes).toBeGreaterThan(MARKDOWN.length)
  })

  it('takes the name from frontmatter when not given', async () => {
    const vfs = createVfs()
    const body = '---\nname: web-search\ndescription: x\n---\n\nSearch the web properly with examples.'
    const out = await installSkill(vfs, { markdown: body })
    expect(out).toEqual({ ok: true, name: 'web-search', bytes: body.length })
  })

  it('refuses to overwrite without the flag', async () => {
    const vfs = createVfs()
    await installSkill(vfs, { name: 'dup', markdown: MARKDOWN })
    const second = await installSkill(vfs, { name: 'dup', markdown: MARKDOWN })
    expect(second).toEqual({ error: expect.stringContaining('already exists') })
    const over = await installSkill(vfs, { name: 'dup', markdown: `${MARKDOWN} more`, overwrite: true })
    expect('ok' in over && over.ok).toBe(true)
  })

  it('rejects non-http URLs, HTTP errors, junk and oversize bodies', async () => {
    const vfs = createVfs()
    expect(await installSkill(vfs, { url: 'file:///etc/passwd' }, mockFetch('x'))).toEqual({
      error: expect.stringContaining('non-http'),
    })
    expect(await installSkill(vfs, { url: 'https://example.com/missing.md' }, mockFetch('no', 404))).toEqual({
      error: expect.stringContaining('404'),
    })
    expect(await installSkill(vfs, { markdown: 'tiny' })).toEqual({ error: expect.stringContaining('too short') })
    expect(await installSkill(vfs, {})).toEqual({ error: expect.stringContaining('empty body') })
    expect(await installSkill(vfs, { markdown: 'x'.repeat(70 * 1024) })).toEqual({
      error: expect.stringContaining('cap'),
    })
    expect(await installSkill(vfs, { name: '!!!', markdown: MARKDOWN })).toEqual({
      error: expect.stringContaining('name'),
    })
  })

  it('never writes outside the skills dir', async () => {
    const vfs = createVfs()
    await installSkill(vfs, { name: '../../evil', markdown: MARKDOWN })
    expect(vfs.isFile('/home/user/evil/SKILL.md')).toBe(false)
    expect(vfs.listAllFiles().every((p) => p.startsWith(`${SKILLS_DIR}/`))).toBe(true)
  })
})

describe('agent-skill-install trust boundary', () => {
  it('refuses to shadow builtin skill names', async () => {
    const { createVfs } = await import('../../vfs/vfs')
    const vfs = createVfs()
    expect(await installSkill(vfs, { name: 'commit', markdown: '# commit\n\nDo commits well.' })).toEqual({
      error: expect.stringContaining('built-in'),
    })
    expect(vfs.isFile(`${SKILLS_DIR}/commit/SKILL.md`)).toBe(false)
  })
})

describe('agent-skill-install network + name hardening', () => {
  it('refuses plaintext http and internal hosts', async () => {
    const vfs = (await import('../../vfs/vfs')).createVfs()
    const fetch = async () => ({ ok: true, status: 200, text: async () => '# s\n\nbody text here ok' })
    expect(await installSkill(vfs, { url: 'http://example.com/s/SKILL.md' }, fetch)).toEqual({
      error: expect.stringContaining('non-https'),
    })
    for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.5', '192.168.1.1', '[::1]']) {
      const out = await installSkill(vfs, { url: `https://${host}/s/SKILL.md` }, fetch)
      expect(out).toEqual({ error: expect.stringContaining('internal') })
    }
    expect(vfs.listAllFiles()).toEqual([])
  })

  it('rejects over-long derived names instead of truncating', async () => {
    const vfs = (await import('../../vfs/vfs')).createVfs()
    const out = await installSkill(vfs, { name: 'a'.repeat(41), markdown: '# skill\n\nEnough body text here.' })
    expect(out).toEqual({ error: expect.stringContaining('max 40') })
    expect(vfs.listAllFiles()).toEqual([])
  })
})
