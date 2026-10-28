/**
 * Pure CommonJS resolver — the same rules Node walks: builtins first, then
 * relative/absolute paths with extension probing, then node_modules lookup
 * up the directory tree. Kept free of DOM/worker imports so it is testable
 * in plain node.
 */

export const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

export interface ResolverFs {
  isFile(path: string): boolean
  readText(path: string): string | null
}

export type Resolved =
  | { kind: 'builtin'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'not-found'; id: string; from: string }

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function join(a: string, b: string): string {
  if (b.startsWith('/')) return normalize(b)
  return normalize(`${a}/${b}`)
}

function normalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

/** package.json main/exports entry resolution, node-flavored. */
function packageEntry(fs: ResolverFs, pkgDir: string): string | null {
  const defaultIndex = `${pkgDir}/index.js`
  const manifestText = fs.readText(`${pkgDir}/package.json`)
  if (manifestText === null) {
    return fs.isFile(defaultIndex) ? defaultIndex : null
  }
  let manifest: { main?: unknown; exports?: unknown; type?: unknown }
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return `${pkgDir}/index.js`
  }
  const fromExports = pickExports(manifest.exports)
  if (fromExports !== null) {
    const candidate = join(pkgDir, fromExports)
    if (fs.isFile(candidate)) return candidate
    const withExt = `${candidate}.js`
    if (fs.isFile(withExt)) return withExt
  }
  if (typeof manifest.main === 'string' && manifest.main.length > 0) {
    const candidate = join(pkgDir, manifest.main)
    if (fs.isFile(candidate)) return candidate
    const withExt = `${candidate}.js`
    if (fs.isFile(withExt)) return withExt
    const asIndex = `${candidate}/index.js`
    if (fs.isFile(asIndex)) return asIndex
  }
  const index = `${pkgDir}/index.js`
  return fs.isFile(index) ? index : null
}

function readManifest(fs: ResolverFs, pkgDir: string): Record<string, unknown> | null {
  const text = fs.readText(join(pkgDir, 'package.json'))
  if (text === null) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/** pick a string target from an exports-map node, CJS conditions first */
function exportsTargetFs(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === undefined) return null
  if (typeof node === 'string') return node
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const map = node as Record<string, unknown>
    for (const key of ['node', 'require', 'default', 'browser', 'import', 'module']) {
      const picked = exportsTargetFs(map[key], depth + 1)
      if (picked !== null) return picked
    }
  }
  return null
}

/** resolve a `pkg/subpath` through the package exports map (exact + `*`). */
function exportsSubpath(fs: ResolverFs, pkgDir: string, subpath: string): string | null {
  const manifest = readManifest(fs, pkgDir)
  const exportsField = manifest?.exports as Record<string, unknown> | undefined
  if (exportsField === undefined || typeof exportsField === 'string') return null
  const resolveTarget = (node: unknown, rest = ''): string | null => {
    const target = exportsTargetFs(node)
    if (target === null) return null
    const substituted = rest !== '' && target.includes('*') ? target.replace('*', rest) : target
    return tryCandidates(fs, join(pkgDir, substituted.replace(/^\.\//, '')))
  }
  const wanted = `./${subpath}`
  if (wanted in exportsField) {
    const found = resolveTarget(exportsField[wanted])
    if (found !== null) return found
  }
  for (const [pattern, node] of Object.entries(exportsField)) {
    const star = pattern.indexOf('*')
    if (star === -1) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (wanted.startsWith(prefix) && wanted.endsWith(suffix) && wanted.length >= prefix.length + suffix.length) {
      const found = resolveTarget(node, wanted.slice(prefix.length, wanted.length - suffix.length))
      if (found !== null) return found
    }
  }
  return null
}

/** Minimal exports-field support: '.', string or condition objects. */
function pickExports(exportsField: unknown, depth = 0): string | null {  if (depth > 6) return null
  if (typeof exportsField === 'string') return exportsField
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const obj = exportsField as Record<string, unknown>
    const dot = obj['.']
    if (dot !== undefined) return pickExports(dot, depth + 1)
    for (const key of ['node', 'require', 'default']) {
      if (obj[key] !== undefined) {
        const picked = pickExports(obj[key], depth + 1)
        if (picked !== null) return picked
      }
    }
  }
  return null
}

function tryCandidates(fs: ResolverFs, base: string): string | null {
  if (fs.isFile(base)) return base
  for (const ext of ['.js', '.json']) {
    const withExt = `${base}${ext}`
    if (fs.isFile(withExt)) return withExt
  }
  const index = `${base}/index.js`
  if (fs.isFile(index)) return index
  const indexJson = `${base}/index.json`
  if (fs.isFile(indexJson)) return indexJson
  // base might be a package directory (node_modules/<pkg>)
  const entry = packageEntry(fs, base)
  if (entry !== null) return entry
  return null
}

export function resolveId(fs: ResolverFs, fromFile: string, id: string): Resolved {
  // builtins match the root segment: require('fs/promises') and
  // require('node:path/posix') must not fall through to node_modules
  const bare = id.startsWith('node:') ? id.slice('node:'.length) : id
  if (NODE_BUILTINS.has(bare.split('/')[0])) {
    return { kind: 'builtin', name: bare }
  }
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/') ? normalize(id) : join(dirname(fromFile), id)
    const found = tryCandidates(fs, base)
    return found !== null ? { kind: 'file', path: found } : { kind: 'not-found', id, from: fromFile }
  }
  // bare specifier: split off any subpath (scoped names carry one slash of
  // their own), then walk node_modules upward
  const parts = id.split('/')
  const pkgName = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = parts.slice(pkgName.split('/').length).join('/')
  let dir = dirname(fromFile)
  for (;;) {
    const pkgDir = join(dir, `node_modules/${pkgName}`)
    if (subpath !== '') {
      // exports map first (condition + `*` patterns), then the legacy
      // direct-file layout
      const viaExports = exportsSubpath(fs, pkgDir, subpath)
      if (viaExports !== null) return { kind: 'file', path: viaExports }
      const found = tryCandidates(fs, join(pkgDir, subpath))
      if (found !== null) return { kind: 'file', path: found }
    } else {
      const found = tryCandidates(fs, pkgDir)
      if (found !== null) return { kind: 'file', path: found }
    }
    if (dir === '/') break
    dir = dirname(dir)
  }
  return { kind: 'not-found', id, from: fromFile }
}
