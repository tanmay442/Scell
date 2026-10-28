#!/usr/bin/env node
/**
 * postinstall: materialize the gitignored browser-vendor tree from the
 * versioned npm packages, so every fresh clone can serve the preview's
 * offline fallbacks without committing megabytes:
 *
 *   public/vendor/pyodide/ <- node_modules/pyodide/{mjs,js,wasm,lock,stdlib}
 *
 * (The tailwind browser runtime needs no copy: document.ts imports it via
 * `@tailwindcss/browser?url`, which vite serves and bundles directly.)
 * Idempotent — reruns overwrite. Fails loudly when the npm layout changes.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'pyodide', 'package.json'), 'utf8'))
console.log(`vendor-public: pyodide v${pkg.version}`)

const files = [
  'pyodide.mjs',
  'pyodide.js',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'pyodide-lock.json',
  'python_stdlib.zip',
]
const dest = join(root, 'public', 'vendor', 'pyodide')
mkdirSync(dest, { recursive: true })
for (const file of files) {
  const src = join(root, 'node_modules', 'pyodide', file)
  if (!existsSync(src)) {
    console.error(`vendor-public: missing ${src} — pyodide npm layout changed, update scripts/vendor-public.mjs`)
    process.exit(1)
  }
  cpSync(src, join(dest, file))
  console.log(`vendor-public: ${file}`)
}
