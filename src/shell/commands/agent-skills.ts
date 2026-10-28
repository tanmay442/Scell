import type { Vfs } from '../../vfs/types'
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
 * Three seed skills (commit, preview, debug-tsc) ship as real files under
 * ~/.cell/skills/ via starter.ts, and as code fallbacks here so the harness
 * works in workspaces seeded before they existed.
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
    out.set(parsed.name, { name: parsed.name, description: parsed.description, body: parsed.body, source })
  }
}

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'commit',
    description: 'Stage and commit the worktree with a clear message (git add/commit, panel flow).',
    body: [
      '# commit',
      '',
      'Commit the current work the way Cell expects:',
      '',
      '1. `git status` to see what changed; `git diff` to review it.',
      '2. Read the changed files (`read`) — never commit code you have not inspected.',
      '3. `git add` exactly the files that belong together (leave scratch files out).',
      '4. `git commit -m "<imperative summary>"` — one change per commit.',
      '5. Verify with `git log --oneline -3` and `git status` (tree should be clean).',
      '',
      'Identity comes from `~/.gitconfig`. Do not push unless the user asked.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'preview',
    description: 'Open and verify a static app with cell preview (index.html + api/ functions).',
    body: [
      '# preview',
      '',
      'Verify a browser app the Cell way:',
      '',
      '1. The entry is `index.html` at the project dir (or a subdir you name).',
      '2. Run `cell preview [dir]` — it opens the panel and bundles with esbuild-wasm.',
      '3. `api/*.js` files run as Vercel-style functions in the node isolate on every request.',
      '4. Edits hot-reload (~600ms debounce). Check the terminal for bundler errors',
      '   (`preview: cannot resolve …` usually means `npm install` first).',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'debug-tsc',
    description: 'Fix TypeScript errors: reproduce with tsc, edit precisely, re-check.',
    body: [
      '# debug-tsc',
      '',
      'Fix type errors without guessing:',
      '',
      '1. Reproduce: run `tsc` (or `npx tsc --noEmit`) in the project and read the errors.',
      '2. `read` each flagged file around the reported line — fix the cause, not the message.',
      '3. Prefer small `edit` replacements over rewrites; keep the tsconfig strictness as-is.',
      '4. Re-run `tsc` until clean, then run the relevant unit check (`pnpm test <file>`).',
    ].join('\n'),
    source: 'builtin',
  },
]

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
