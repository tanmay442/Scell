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

// Pure-Python wheels pyodide cannot serve itself (no CORS on PyPI, so the
// browser cannot micropip-install from files.pythonhosted.org). Pinned
// here AND in src/python/runner.ts VENDOR_WHEELS — keep the two in sync.
// Same-origin /vendor/wheels works in every runtime (browser, workers).
const wheelsDir = join(root, 'public', 'vendor', 'wheels')
mkdirSync(wheelsDir, { recursive: true })
const wheels = ['https://files.pythonhosted.org/packages/3f/4b/77e8ad4ac42c9d93600f40541a50e9feb3a61d2bbee2d76f659346072051/pypdf-6.21.4-py3-none-any.whl']
for (const url of wheels) {
  const name = url.slice(url.lastIndexOf('/') + 1)
  const dest = join(wheelsDir, name)
  if (existsSync(dest)) {
    console.log(`vendor-public: wheels/${name} (cached)`)
    continue
  }
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`vendor-public: wheel fetch failed: ${url} HTTP ${res.status}`)
    process.exit(1)
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  console.log(`vendor-public: wheels/${name}`)
}
