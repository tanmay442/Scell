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

/** Minimal exports-field support: '.', string or condition objects. */
function pickExports(exportsField: unknown, depth = 0): string | null {
  if (depth > 6) return null
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
  if (NODE_BUILTINS.has(id) || id.startsWith('node:')) {
    return { kind: 'builtin', name: id.replace(/^node:/, '') }
  }
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/') ? normalize(id) : join(dirname(fromFile), id)
    const found = tryCandidates(fs, base)
    return found !== null ? { kind: 'file', path: found } : { kind: 'not-found', id, from: fromFile }
  }
  // bare specifier: walk node_modules upward
  let dir = dirname(fromFile)
  for (;;) {
    const found = tryCandidates(fs, join(dir, `node_modules/${id}`))
    if (found !== null) return { kind: 'file', path: found }
    if (dir === '/') break
    dir = dirname(dir)
  }
  return { kind: 'not-found', id, from: fromFile }
}
