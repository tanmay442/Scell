/**
 * Single source for the three built-in skill bodies. starter.ts seeds
 * these as ~/.cell/skills/<name>/SKILL.md files; agent-skills.ts uses
 * the same content as in-code fallbacks for workspaces seeded before
 * the files existed. Edit here only — both consumers follow.
 */
export interface SkillContent {
  name: string
  description: string
  body: string
}

export const SKILL_CONTENT: SkillContent[] = [
  {
    name: 'commit',
    description: 'Stage and commit the worktree with a clear message (git add/commit, panel flow).',
    body: `# commit

Commit the current work the way Cell expects:

1. \`git status\` to see what changed; \`git diff\` to review it.
2. Read the changed files (\`read\`) — never commit code you have not inspected.
3. \`git add\` exactly the files that belong together (leave scratch files out).
4. \`git commit -m "<imperative summary>"\` — one change per commit.
5. Verify with \`git log --oneline -3\` and \`git status\` (tree should be clean).

Identity comes from \`~/.gitconfig\`. Do not push unless the user asked.`,
  },
  {
    name: 'preview',
    description: 'Open and verify a static app with cell preview (index.html + api/ functions).',
    body: `# preview

Verify a browser app the Cell way:

1. The entry is \`index.html\` at the project dir (or a subdir you name).
2. Run \`cell preview [dir]\` — it opens the panel and bundles with esbuild-wasm.
3. \`api/*.js\` files run as Vercel-style functions in the node isolate on every request.
4. Edits hot-reload (~600ms debounce). Check the terminal for bundler errors (\`preview: cannot resolve …\` usually means \`npm install\` first).`,
  },
  {
    name: 'debug-tsc',
    description: 'Fix TypeScript errors: reproduce with tsc, edit precisely, re-check.',
    body: `# debug-tsc

Fix type errors without guessing:

1. Reproduce: run \`tsc\` (or \`npx tsc --noEmit\`) in the project and read the errors.
2. \`read\` each flagged file around the reported line — fix the cause, not the message.
3. Prefer small \`edit\` replacements over rewrites; keep the tsconfig strictness as-is.
4. Re-run \`tsc\` until clean, then run the relevant unit check (\`pnpm test <file>\`).`,
  },
]

/** Render one skill as a SKILL.md file (frontmatter + body). */
export function skillFileContent(skill: SkillContent): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`
}
