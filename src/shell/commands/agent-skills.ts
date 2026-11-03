import type { Vfs } from '../../vfs/types'
import { SKILL_CONTENT } from '../../vfs/skill-content'
import { projectRoot } from './install'

/**
 * Skills: ~/.cell/skills/<name>/SKILL.md plus the project override
 * <project>/.cell/skills/<name>/SKILL.md, where <project> is the nearest
 * package.json owner above the cwd. Project skills win on name collision.
 *
 * Progressive disclosure: the system prompt only carries one line per skill
 * (name + description from frontmatter); the model pulls the full body with
 * the load_skill tool when the task actually needs it.
 *
 * Seed skills (commit, preview, debug-tsc, images) ship as real files under
 * ~/.cell/skills/ via starter.ts, and as code fallbacks here so the harness
 * works in workspaces seeded before they existed. Both read the bodies
 * from src/vfs/skill-content.ts — one source, no drift.
 */

export interface Skill {
  name: string
  description: string
  body: string
  source: 'home' | 'project' | 'builtin'
}

const HOME_SKILLS = '/home/user/.cell/skills'

/** name + description from YAML frontmatter; body is everything after it. */
export function parseSkillFile(raw: string): { name: string; description: string; body: string } | { error: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw)
  if (!match) return { error: 'missing frontmatter (---\nname: …\ndescription: …\n---)' }
  const [, front, body] = match
  const name = /^name:\s*(.+?)\s*$/m.exec(front)?.[1].replace(/^["']|["']$/g, '')
  const description = /^description:\s*(.+?)\s*$/m.exec(front)?.[1].replace(/^["']|["']$/g, '')
  if (!name) return { error: 'frontmatter needs a name' }
  if (!description) return { error: `skill '${name}': frontmatter needs a description` }
  return { name, description, body: body.trim() === '' ? '(no body)' : body }
}

function readSkillDir(vfs: Vfs, dir: string, source: 'home' | 'project', out: Map<string, Skill>, warnings: string[]): void {
  let names: string[]
  try {
    names = vfs.isDir(dir) ? vfs.readDir(dir) : []
  } catch {
    return
  }
  for (const name of names.sort()) {
    const file = `${dir}/${name}/SKILL.md`
    if (!vfs.isFile(file)) continue
    const raw = vfs.read(file)
    if (raw === null) continue
    const parsed = parseSkillFile(raw)
    if ('error' in parsed) {
      warnings.push(`${file}: ${parsed.error}`)
      continue
    }
    if (!/^[A-Za-z0-9_-]+$/.test(parsed.name)) {
      warnings.push(`${file}: bad skill name '${parsed.name}' — ignored`)
      continue
    }
    const existing = out.get(parsed.name)
    if (existing) warnings.push(`${file}: skill '${parsed.name}' overrides the ${existing.source} one`)
    out.set(parsed.name, { name: parsed.name, description: parsed.description, body: parsed.body, source })
  }
}

export const BUILTIN_SKILLS: Skill[] = SKILL_CONTENT.map((skill) => ({ ...skill, source: 'builtin' as const }))

export function loadSkills(vfs: Vfs, cwd: string): { skills: Skill[]; warnings: string[] } {
  const warnings: string[] = []
  const byName = new Map<string, Skill>()
  for (const builtin of BUILTIN_SKILLS) byName.set(builtin.name, builtin)
  readSkillDir(vfs, HOME_SKILLS, 'home', byName, warnings)
  const root = projectRoot(vfs, cwd)
  if (root !== null) readSkillDir(vfs, `${root}/.cell/skills`, 'project', byName, warnings)
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings }
}

/** One line per skill for the system prompt (progressive disclosure). */
export function skillIndex(skills: Skill[]): string {
  if (skills.length === 0) return '(no skills installed)'
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
}
