import * as esbuild from 'esbuild-wasm'
import type { Vfs } from '../vfs/types'
import { vfsPath } from '../vfs/types'

/**
 * Bundles a browser app entry (src/main.tsx and friends) inside the page
 * with esbuild-wasm — the Go bundler compiled to WebAssembly — resolving
 * every module from the Cell VFS: app source, node_modules, json, images.
 * CSS side-effect imports are captured separately (the Tailwind runtime
 * compiles them in the preview iframe; plain css is inlined as-is).
 */

let esbuildReady: Promise<void> | null = null

function ensureEsbuild(): Promise<void> {
  esbuildReady ??= (async () => {
    if (typeof document !== 'undefined') {
      await esbuild.initialize({ wasmURL: '/wasm/esbuild.wasm' })
    }
    // the node build (tests) self-initializes from its own esbuild.wasm
  })().catch((err: unknown) => {
    esbuildReady = null
    throw err
  })
  return esbuildReady
}

const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']
const DATAURL_EXTS = ['.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.avif']

interface Resolver {
  resolve(fromDir: string, id: string): string | null
  readText(path: string): string | null
  readBytes(path: string): Uint8Array | null
}

function makeResolver(vfs: Vfs): Resolver {
  const packageJsonCache = new Map<string, Record<string, unknown> | null>()
  const readJson = (path: string): Record<string, unknown> | null => {
    if (packageJsonCache.has(path)) return packageJsonCache.get(path) ?? null
    const bytes = vfs.readBytes(path)
    if (bytes === null) {
      packageJsonCache.set(path, null)
      return null
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      packageJsonCache.set(path, parsed)
      return parsed
    } catch {
      packageJsonCache.set(path, null)
      return null
    }
  }

  /** pick a string target from an exports-map node, browser/import first */
  function exportsTarget(node: unknown): string | null {
    if (typeof node === 'string') return node
    if (node === null || typeof node !== 'object') return null
    const map = node as Record<string, unknown>
    for (const key of ['browser', 'import', 'module', 'require', 'default']) {
      const value = map[key]
      if (typeof value === 'string') return value
      if (value !== null && typeof value === 'object') {
        const nested = exportsTarget(value)
        if (nested !== null) return nested
      }
    }
    return null
  }

  /** resolve a subpath ('dom', 'react') through a package's exports map */
  function exportsSubpath(pkgDir: string, subpath: string): string | null {
    const manifest = readJson(`${pkgDir}/package.json`)
    if (manifest === null) return null
    const exportsField = manifest.exports as Record<string, unknown> | string | undefined
    if (exportsField === undefined) return null
    if (typeof exportsField === 'string') return null
    const wanted = subpath === '' ? '.' : `./${subpath}`
    // exact match first
    if (wanted in exportsField) {
      const target = exportsTarget(exportsField[wanted])
      if (target !== null) return tryFile(`${pkgDir}/${target.replace(/^\.\//, '')}`)
    }
    // wildcard patterns: './prefix*' or './*'
    for (const [pattern, node] of Object.entries(exportsField)) {
      const star = pattern.indexOf('*')
      if (star === -1) continue
      const prefix = pattern.slice(0, star)
      const suffix = pattern.slice(star + 1)
      if (wanted.startsWith(prefix) && wanted.endsWith(suffix) && wanted.length >= prefix.length + suffix.length) {
        const rest = wanted.slice(prefix.length, wanted.length - suffix.length)
        const target = exportsTarget(node)
        if (target !== null) {
          const resolved = target.includes('*') ? target.replace('*', rest) : target
          const found = tryFile(`${pkgDir}/${resolved.replace(/^\.\//, '')}`)
          if (found) return found
        }
      }
    }
    return null
  }

  function packageEntry(pkgDir: string): string | null {
    const manifest = readJson(`${pkgDir}/package.json`)
    if (manifest === null) return null
    const dot = exportsSubpath(pkgDir, '')
    if (dot !== null) return dot
    for (const field of ['browser', 'module', 'main'] as const) {
      const value = manifest[field]
      if (typeof value === 'string') {
        const found = tryFile(`${pkgDir}/${value.replace(/^\.\//, '')}`)
        if (found) return found
      }
    }
    return tryFile(`${pkgDir}/index.js`) ?? tryFile(`${pkgDir}/index.mjs`)
  }

  function tryFile(path: string): string | null {
    if (vfs.isFile(path)) return path
    for (const ext of JS_EXTS) {
      if (vfs.isFile(`${path}${ext}`)) return `${path}${ext}`
    }
    if (vfs.isFile(`${path}.json`)) return `${path}.json`
    return null
  }

  function tryCandidates(base: string): string | null {
    const found = tryFile(base)
    if (found) return found
    for (const ext of ['.css', '.scss']) {
      if (vfs.isFile(`${base}${ext}`)) return `${base}${ext}`
    }
    if (vfs.isDir(base)) return packageEntry(base)
    return null
  }

  return {
    readText(path) {
      const bytes = vfs.readBytes(path)
      return bytes === null ? null : new TextDecoder().decode(bytes)
    },
    readBytes(path) {
      return vfs.readBytes(path)
    },
    resolve(fromDir, id) {
      if (id.startsWith('./') || id.startsWith('../')) {
        return tryCandidates(vfsPath.normalize(`${fromDir}/${id}`))
      }
      if (id.startsWith('/')) return tryCandidates(vfsPath.normalize(id))
      // bare: node_modules walk-up. scoped names carry one slash of their
      // own ('@scope/pkg'); anything after that is an exports subpath
      const parts = id.split('/')
      const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
      const subpath = parts.slice(pkgName.split('/').length).join('/')
      let dir = fromDir
      for (;;) {
        const pkgDir = vfsPath.join(dir, `node_modules/${pkgName}`)
        if (vfs.isDir(pkgDir)) {
          if (subpath !== '') {
            const viaExports = exportsSubpath(pkgDir, subpath)
            if (viaExports !== null) return viaExports
            // no exports match: legacy subpath file
            const found = tryCandidates(vfsPath.join(pkgDir, subpath))
            if (found !== null) return found
          } else {
            const found = packageEntry(pkgDir)
            if (found !== null) return found
          }
        }
        if (dir === '/') break
        dir = vfsPath.dirname(dir)
      }
      return null
    },
  }
}

export interface BundleResult {
  js: string
  css: string
  /** the css graph references tailwindcss — inject the runtime compiler */
  tailwind: boolean
}

const BARE_CSS_IMPORT = /@import\s+["']([^"'.][^"']*)["']\s*;/g

/** Expand bare `@import "pkg"` lines in css from node_modules (tw-animate-css & friends). */
function expandBareCssImports(resolver: Resolver, css: string, fromDir: string): string {
  return css.replace(BARE_CSS_IMPORT, (full, spec: string) => {
    const sub = spec.split(' ')[0]
    const resolved = resolver.resolve(fromDir, sub)
    if (resolved === null) return full
    const text = resolver.readText(resolved)
    return text === null ? full : text
  })
}

export async function bundleEntry(
  vfs: Vfs,
  projectDir: string,
  entry: string,
): Promise<BundleResult | { error: string }> {
  await ensureEsbuild()
  const resolver = makeResolver(vfs)
  const cssFiles: string[] = []
  const loaderFor = (path: string): esbuild.Loader => {
    const ext = `.${vfsPath.ext(path)}`
    if (ext === '.tsx') return 'tsx'
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts'
    if (ext === '.jsx') return 'jsx'
    if (ext === '.json') return 'json'
    if (DATAURL_EXTS.includes(ext)) return 'dataurl'
    return 'js'
  }

  const plugin: esbuild.Plugin = {
    name: 'cell-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const fromDir = args.kind === 'entry-point' ? projectDir : args.resolveDir || projectDir
        if (/\.css$/.test(args.path)) {
          const resolved = resolver.resolve(fromDir, args.path)
          if (resolved !== null) {
            cssFiles.push(resolved)
            return { path: 'cell-css', namespace: 'cell-css' }
          }
          return { errors: [{ text: `preview: cannot resolve css '${args.path}'` }] }
        }
        const resolved = resolver.resolve(fromDir, args.path)
        if (resolved === null) {
          return { errors: [{ text: `preview: cannot resolve '${args.path}' from ${fromDir}` }] }
        }
        return { path: resolved, namespace: 'cell-fs' }
      })
      build.onLoad({ filter: /.*/, namespace: 'cell-fs' }, (args) => {
        const ext = `.${vfsPath.ext(args.path)}`
        const loader = loaderFor(args.path)
        if (loader === 'dataurl') {
          const bytes = resolver.readBytes(args.path)
          if (bytes === null) return { errors: [{ text: `preview: unreadable ${args.path}` }] }
          return { contents: bytes as unknown as Uint8Array, loader }
        }
        const text = resolver.readText(args.path)
        if (text === null) return { errors: [{ text: `preview: unreadable ${args.path}` }] }
        // css side-effect imports resolve into the empty cell-css module and
        // are captured at resolve time — no stripping needed
        return { contents: text, loader, resolveDir: vfsPath.dirname(args.path) }
      })
      build.onLoad({ filter: /.*/, namespace: 'cell-css' }, () => ({ contents: '', loader: 'js' }))
    },
  }

  let result: esbuild.BuildResult
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      plugins: [plugin],
      write: false,
      logLevel: 'silent',
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { error: text.split('\n').slice(0, 6).join('\n') }
  }
  // single-output builds are named <stdout>; multi-output ones carry .js paths
  const js = result.outputFiles?.find((file) => file.path.endsWith('.js') || file.path === '<stdout>')?.text ?? ''
  if (js === '') {
    const failure = result.errors.map((item) => item.text).join('\n')
    return { error: failure !== '' ? failure : 'preview: bundler produced no javascript' }
  }
  const cssRoot = cssFiles[0] !== undefined ? vfsPath.dirname(cssFiles[0]) : projectDir
  const css = expandBareCssImports(resolver, [...new Set(cssFiles)].map((path) => resolver.readText(path) ?? '').join('\n'), cssRoot)
  const tailwind = /@import\s+["']tailwindcss/.test(css) || /tailwindcss/.test(css.slice(0, 500))
  return { js, css, tailwind }
}
