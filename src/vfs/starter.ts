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
  [`${HOME}/.gitconfig`]: `[user]
	name = Cell User
	email = user@cell.local
[core]
	autocrlf = false
`,
  [`${HOME}/.profile`]: `# ~/.profile — sourced by login shells
export PATH="$HOME/.local/bin:$PATH"
`,
}

/** Seed the starter home, but only into a completely empty workspace. */
export function seedStarterProject(vfs: Vfs): void {
  if (vfs.listAllFiles().length > 0) return
  for (const [path, content] of Object.entries(FILES)) {
    vfs.write(path, content)
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
  const pkg = vfs.read(`${PROJECT}/package.json`)
  if (pkg === LEGACY_STARTER_PACKAGE_JSON) {
    vfs.write(`${PROJECT}/package.json`, FILES[`${PROJECT}/package.json`])
  }
}
