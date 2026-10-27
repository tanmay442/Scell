import type { Vfs } from './types'

const FILES: Record<string, string> = {
  '/README.md': `# Starter workspace

Welcome to **Cell** — a dev environment that lives entirely in your browser.
No server, no container: the filesystem, the typechecker (a Rust port of
TypeScript 7 compiled to WASM) and the bash shell all run locally in this tab.

Things to try:

- Open \`src/index.ts\` — edit it, hit \`Ctrl+S\`, watch the Problems panel.
- Open \`src/broken.ts\` — it has deliberate type errors so you can see live
  diagnostics. Fix them and the errors vanish.
- New File in the sidebar — any \`.ts\` anywhere is typechecked on save.
- Open the terminal (\`Ctrl+\\\`\`) and poke around:

      ls
      cat src/index.ts
      echo "hello from bash" > notes.txt
      cat notes.txt | grep hello

Your workspace persists in this browser (IndexedDB). Reload the tab —
everything is still here.
`,
  '/package.json': `{
  "name": "starter",
  "private": true,
  "type": "module"
}
`,
  '/tsconfig.json': `{
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
  '/src/index.ts': `import { add, formatGreeting } from './utils'

const total = add(19, 23)
const message = formatGreeting('Cell')

console.log(message)
console.log('The answer is', total)
`,
  '/src/utils.ts': `export function add(a: number, b: number): number {
  return a + b
}

export function formatGreeting(name: string): string {
  return \`Hello, \${name}!\`
}
`,
  '/src/broken.ts': `import { add } from './utils'

// Two intentional type errors so you can see live diagnostics.
// Fix them (or delete this file) and watch the Problems panel clear.

const count: number = 'not a number'

const shout = add('two', 2)

export { count, shout }
`,
}

/** Seed the starter project, but only into a completely empty workspace. */
export function seedStarterProject(vfs: Vfs): void {
  if (vfs.listAllFiles().length > 0) return
  for (const [path, content] of Object.entries(FILES)) {
    vfs.write(path, content)
  }
}
