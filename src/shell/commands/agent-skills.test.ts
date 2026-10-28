import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { loadSkills, parseSkillFile, skillIndex, BUILTIN_SKILLS } from './agent-skills'

describe('skill loader', () => {
  it('parses frontmatter name+description, keeps the body', () => {
    const parsed = parseSkillFile('---\nname: demo\ndescription: Does things.\n---\n\n# body here\n')
    expect(parsed).toMatchObject({ name: 'demo', description: 'Does things.' })
    if (!('error' in parsed)) expect(parsed.body).toContain('# body here')
  })

  it('rejects files without frontmatter', () => {
    expect(parseSkillFile('# no frontmatter\n')).toHaveProperty('error')
    expect(parseSkillFile('---\nname: x\n---\nbody\n')).toHaveProperty('error')
  })

  it('ships the built-in seeds even with no files', () => {
    const vfs = createVfs()
    const { skills } = loadSkills(vfs, '/home/user')
    const names = skills.map((s) => s.name)
    expect(names).toContain('commit')
    expect(names).toContain('preview')
    expect(names).toContain('debug-tsc')
    expect(BUILTIN_SKILLS.length).toBe(3)
  })

  it('home skills override builtins, project skills override home', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/skills/commit/SKILL.md', '---\nname: commit\ndescription: Home version.\n---\n\nhome body\n')
    vfs.write('/home/user/repo/package.json', '{}')
    vfs.write('/home/user/repo/.cell/skills/commit/SKILL.md', '---\nname: commit\ndescription: Project version.\n---\n\nproject body\n')
    const { skills } = loadSkills(vfs, '/home/user/repo')
    const commit = skills.find((s) => s.name === 'commit')!
    expect(commit.description).toBe('Project version.')
    expect(commit.source).toBe('project')
  })

  it('index lists one line per skill (progressive disclosure)', () => {
    const vfs = createVfs()
    const { skills } = loadSkills(vfs, '/home/user')
    const index = skillIndex(skills)
    for (const skill of skills) {
      expect(index).toContain(`${skill.name}: ${skill.description}`)
    }
    // bodies stay out of the index
    expect(index).not.toContain('never commit code')
  })
})
