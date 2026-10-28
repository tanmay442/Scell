import type { Vfs } from './types'

const HOME = '/home/user'
const PROJECT = `${HOME}/project`

const FILES: Record<string, string> = {
  [`${PROJECT}/README.md`]: `# Starter project

Welcome to **Cell** — a dev environment that lives entirely in your browser.
No server, no container: the filesystem, the typechecker (a Rust port of
TypeScript 7 compiled to WASM) and the bash shell all run locally in this tab.

You are in a full user home: \`~\` is ${HOME} and this project lives at
\`~/project\`. Dotfiles are real files — edit \`~/.gitconfig\` to change your
git identity.

Things to try:

- Open \`src/index.ts\` — edit it, hit \`Ctrl+S\`, watch the Problems panel.
- Open \`src/broken.ts\` — it has deliberate type errors so you can see live
  diagnostics. Fix them and the errors vanish.
- Run it: \`node src/index.ts\` (TypeScript, straight through tsc-in-WASM).
- Scaffold something new: \`npm init node-app\` or \`npm init ts-app\`.
- Version it: \`git init\`, \`git add .\`, \`git commit -m "first"\`.
- Install a real package: \`npm install ms\` then
  \`node -e "console.log(require('ms')('2 days'))"\`.
- In the terminal (\`Ctrl+\\\`\`): ls, cat, grep, pipes — files you create
  appear in the tree.

Your whole home directory persists in this browser (IndexedDB). Reload the
tab — everything is still here.
`,
  [`${PROJECT}/package.json`]: `{
  "name": "starter",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "start": "node src/index.ts",
    "check": "tsc"
  }
}
`,
  [`${PROJECT}/tsconfig.json`]: `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["**/*"]
}
`,
  [`${PROJECT}/src/index.ts`]: `import { add, formatGreeting } from './utils'

const total = add(19, 23)
const message = formatGreeting('Cell')

console.log(message)
console.log('The answer is', total)
`,
  [`${PROJECT}/src/utils.ts`]: `export function add(a: number, b: number): number {
  return a + b
}

export function formatGreeting(name: string): string {
  return \`Hello, \${name}!\`
}
`,
  [`${PROJECT}/src/broken.ts`]: `import { add } from './utils'

// Two intentional type errors so you can see live diagnostics.
// Fix them (or delete this file) and watch the Problems panel clear.

const count: number = 'not a number'

const shout = add('two', 2)

export { count, shout }
`,
  [`${HOME}/.cell/skills/commit/SKILL.md`]: `---\nname: commit\ndescription: Stage and commit the worktree with a clear message (git add/commit, panel flow).\n---\n\n# commit\n\nCommit the current work the way Cell expects:\n\n1. git status to see what changed; git diff to review it.\n2. Read the changed files (read) - never commit code you have not inspected.\n3. git add exactly the files that belong together (leave scratch files out).\n4. git commit -m "<imperative summary>" - one change per commit.\n5. Verify with git log --oneline -3 and git status (tree should be clean).\n\nIdentity comes from ~/.gitconfig. Do not push unless the user asked.\n`,
  [`${HOME}/.cell/skills/preview/SKILL.md`]: `---\nname: preview\ndescription: Open and verify a static app with cell preview (index.html + api/ functions).\n---\n\n# preview\n\nVerify a browser app the Cell way:\n\n1. The entry is index.html at the project dir (or a subdir you name).\n2. Run cell preview [dir] - it opens the panel and bundles with esbuild-wasm.\n3. api/*.js files run as Vercel-style functions in the node isolate on every request.\n4. Edits hot-reload (600ms debounce). Check the terminal for bundler errors.\n`,
  [`${HOME}/.cell/skills/debug-tsc/SKILL.md`]: `---\nname: debug-tsc\ndescription: Fix TypeScript errors - reproduce with tsc, edit precisely, re-check.\n---\n\n# debug-tsc\n\nFix type errors without guessing:\n\n1. Reproduce - run tsc in the project and read the errors.\n2. read each flagged file around the reported line - fix the cause, not the message.\n3. Prefer small edit replacements over rewrites; keep the tsconfig strictness as-is.\n4. Re-run tsc until clean, then run the relevant unit check.\n`,
  [`${HOME}/.cell/commands/commit.md`]: `Review git status and git diff, stage the files that belong together, and commit with a clear imperative message. Verify with git log --oneline -3.\n`,
  [`${HOME}/.cell/commands/preview.md`]: `Run cell preview for this project and verify it bundles and renders. Report bundler errors and fix missing installs.\n`,
  [`${HOME}/.gitconfig`]: `[user]
	name = Cell User
	email = user@cell.local
[core]
	autocrlf = false
`,
  [`${HOME}/.profile`]: `# ~/.profile — sourced by login shells; interactive shells read ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
`,
  [`${HOME}/.bashrc`]: `# ~/.bashrc — sourced for every interactive shell
# (in Cell: executed in front of every command, so exports apply everywhere)

# history and session behaviour
HISTSIZE=1000
HISTFILE=$HOME/.bash_history
HISTCONTROL=ignoreboth

# paths
export PATH="$HOME/.local/bin:$PATH"
export EDITOR=vi
export VISUAL=vi
export PAGER=less
export LESS=-R
export LANG=en_US.UTF-8
export NODE_ENV=development
export NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false

# shell options
shopt -s histappend
shopt -s checkwinsize

# aliases
alias ll='ls -laF'
alias la='ls -A'
alias l='ls -CF'
alias ..='cd ..'
alias grep='grep --color=auto'
alias df='df -h'
alias free='free -m'

# prompt (informational; Cell renders its own)
PS1='\\u@\\h:\\w\\$ '
`,
}

/** Seed the starter home, but only into a completely empty workspace. */
export function seedStarterProject(vfs: Vfs): void {
  if (vfs.listAllFiles().length > 0) return
  for (const [path, content] of Object.entries(FILES)) {
    vfs.write(path, content)
  }
}

/**
 * Some earlier builds saved a broken workspace: the migration wrote only the
 * dotfiles and the starter project never landed. Heal those homes — seed the
 * project files whenever ~/project is gone and nothing but dotfiles remain,
 * so a deliberate `rm -rf ~/project` next to real work is respected.
 */
export function ensureStarterProject(vfs: Vfs): void {
  if (vfs.exists(`${PROJECT}/README.md`)) return
  const hasRealContent = vfs.listAllFiles().some((path) => !path.slice(path.lastIndexOf('/') + 1).startsWith('.'))
  if (hasRealContent) return
  for (const [path, content] of Object.entries(FILES)) {
    if (path.startsWith(`${PROJECT}/`) && vfs.read(path) === null) vfs.write(path, content)
  }
}

const LEGACY_STARTER_PACKAGE_JSON = `{
  "name": "starter",
  "private": true,
  "type": "module"
}
`

/**
 * Workspace migrations for homes seeded by earlier Cell builds:
 * v1: root-level files ("/README.md", …) → move into ~/project, add dotfiles.
 * v1.5: the first starter said "type": "module", which forces ESM mode on
 * every .ts — drop it; CommonJS is the runtime's native module system.
 */
export function migrateStarter(vfs: Vfs): void {
  const rootFiles = vfs.listAllFiles().filter((p) => !p.startsWith('/home/'))
  if (rootFiles.length > 0 && !vfs.exists(`${PROJECT}/README.md`)) {
    for (const path of rootFiles) {
      const content = vfs.read(path)
      if (content !== null) vfs.write(`${PROJECT}${path}`, content)
      vfs.delete(path)
    }
  }
  if (vfs.read(`${HOME}/.gitconfig`) === null) {
    vfs.write(`${HOME}/.gitconfig`, FILES[`${HOME}/.gitconfig`])
  }
  if (vfs.read(`${HOME}/.profile`) === null) {
    vfs.write(`${HOME}/.profile`, FILES[`${HOME}/.profile`])
  }
  if (vfs.read(`${HOME}/.bashrc`) === null) {
    vfs.write(`${HOME}/.bashrc`, FILES[`${HOME}/.bashrc`])
  }
  const pkg = vfs.read(`${PROJECT}/package.json`)
  if (pkg === LEGACY_STARTER_PACKAGE_JSON) {
    vfs.write(`${PROJECT}/package.json`, FILES[`${PROJECT}/package.json`])
  }
}
