import type { Vfs } from './types'
import { SKILL_CONTENT, skillFileContent } from './skill-content'

const HOME = '/home/user'
const PROJECT = `${HOME}/project`

const FILES: Record<string, string> = {
  ...Object.fromEntries(SKILL_CONTENT.map((skill) => [`${HOME}/.cell/skills/${skill.name}/SKILL.md`, skillFileContent(skill)])),
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
  [`${HOME}/.cell/commands/commit.md`]: `Review git status and git diff, stage the files that belong together, and commit with a clear imperative message. Verify with git log --oneline -3.\n`,
  [`${HOME}/.cell/commands/preview.md`]: `Run cell preview for this project and verify it bundles and renders. Report bundler errors and fix missing installs.\n`,
  [`${HOME}/.cell/agent.json`]: `{ "provider": "meta", "model": "muse-spark-1.3-contributor", "permission": "full" }\n`,
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

/**
 * Tombstone marking a workspace the starter has seeded (P0-9). An empty
 * workspace is ambiguous — fresh browser or deliberate `rm -rf` — and the
 * old empty-check reseeded both, resurrecting the starter after a wipe.
 * The marker survives partial wipes (it lives in .cell); full wipes are
 * covered by the out-of-band IDB flag in persistence.ts.
 */
export const SEED_MARKER = `${HOME}/.cell/seeded`

/** Seed the starter home, but only into a workspace never seeded before. */
export function seedStarterProject(vfs: Vfs): void {
  if (vfs.exists(SEED_MARKER)) return
  if (vfs.listAllFiles().length > 0) {
    // legacy workspace from before the marker: adopt, do not clobber
    vfs.write(SEED_MARKER, `seeded ${new Date().toISOString()}\n`)
    return
  }
  for (const [path, content] of Object.entries(FILES)) {
    vfs.write(path, content)
  }
  vfs.write(SEED_MARKER, `seeded ${new Date().toISOString()}\n`)
}

/**
 * Some earlier builds saved a broken workspace: the migration wrote only the
 * dotfiles and the starter project never landed. Heal those homes — seed the
 * project files whenever ~/project is gone and nothing but dotfiles remain,
 * so a deliberate `rm -rf ~/project` next to real work is respected.
 */
export function ensureStarterProject(vfs: Vfs): void {
  // a seeded workspace stays as the user left it: a deliberate `rm -rf
  // ~/project` must not resurrect the starter (P0-9)
  if (vfs.exists(SEED_MARKER)) return
  if (vfs.exists(`${PROJECT}/README.md`)) return
  const hasRealContent = vfs.listAllFiles().some((path) => !path.slice(path.lastIndexOf('/') + 1).startsWith('.'))
  if (hasRealContent) {
    // legacy workspace with real user content: adopt, do not reseed
    if (!vfs.exists(SEED_MARKER)) vfs.write(SEED_MARKER, `seeded ${new Date().toISOString()}\n`)
    return
  }
  for (const [path, content] of Object.entries(FILES)) {
    if (path.startsWith(`${PROJECT}/`) && vfs.read(path) === null) vfs.write(path, content)
  }
  if (!vfs.exists(SEED_MARKER)) vfs.write(SEED_MARKER, `seeded ${new Date().toISOString()}\n`)
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
  if (vfs.read(`${HOME}/.cell/agent.json`) === null) {
    vfs.write(`${HOME}/.cell/agent.json`, FILES[`${HOME}/.cell/agent.json`])
  }
  if (vfs.read(`${HOME}/.bashrc`) === null) {
    vfs.write(`${HOME}/.bashrc`, FILES[`${HOME}/.bashrc`])
  }
  const pkg = vfs.read(`${PROJECT}/package.json`)
  if (pkg === LEGACY_STARTER_PACKAGE_JSON) {
    vfs.write(`${PROJECT}/package.json`, FILES[`${PROJECT}/package.json`])
  }
  // adopt pre-marker workspaces so ensure() never heals them again
  if (!vfs.exists(SEED_MARKER)) {
    vfs.write(SEED_MARKER, `seeded ${new Date().toISOString()}\n`)
  }
}
