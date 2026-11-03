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
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

// Pure-Python wheels, pinned bytes served same-origin (offline-capable,
// deterministic, no index trust). PINNED HERE AND in src/python/runner.ts
// (VENDOR_WHEELS + VENDOR_WHEEL_HASHES) — check-isolate-pure.sh fails the
// build when filename or sha256 differ. Verified on download AND on
// every cached hit: a poisoned wheel is silent code execution otherwise.
const wheelsDir = join(root, 'public', 'vendor', 'wheels')
mkdirSync(wheelsDir, { recursive: true })
const wheels = [
  {
    file: 'pypdf-6.21.4-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/3f/4b/77e8ad4ac42c9d93600e9feb3a61d2bbee2d76f659346072051/pypdf-6.21.4-py3-none-any.whl',
    sha256: '33e4fb41ca352810eb4e9838aa0d82d6888a5f8bf682f43e99cce5faa666255c',
  },
  {
    file: 'seaborn-0.13.2-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/83/11/00d3c3dfc25ad54e731d91449895a79e4bf2384dc3ac01809010ba88f6d5/seaborn-0.13.2-py3-none-any.whl',
    sha256: '636f8336facf092165e27924f223d3c62ca560b1f2bb5dff7ab7fad265361987',
  },
]
for (const { file, url, sha256 } of wheels) {
  const dest = join(wheelsDir, file)
  if (existsSync(dest)) {
    const cached = readFileSync(dest)
    const digest = createHash('sha256').update(cached).digest('hex')
    if (digest === sha256) {
      console.log(`vendor-public: wheels/${file} (cached, hash verified)`)
      continue
    }
    console.error(`vendor-public: wheels/${file} cached hash MISMATCH (got ${digest}) — re-downloading`)
  }
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`vendor-public: wheel fetch failed: ${url} HTTP ${res.status}`)
    process.exit(1)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== sha256) {
    console.error(`vendor-public: wheels/${file} hash MISMATCH (got ${digest}) — refusing to write`)
    process.exit(1)
  }
  writeFileSync(dest, bytes)
  console.log(`vendor-public: wheels/${file} (hash verified)`)
}
