import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import { fetchMetadata, fetchTarballEntries, pickVersion, type RegistryVersion } from './registry'

/**
 * Dependency installer: BFS over the semver graph, flat hoisting with
 * first-wins at the project root and nested node_modules only on version
 * conflict — the model pnpm made popular, minus the symlink trickery a
 * browser VFS cannot honor. Binaries inside packages are stored as raw bytes.
 *
 * Installs are rooted: a project install lives under the package.json that
 * owns it (found by walking up from the cwd), a `npm i -g` install lives
 * under GLOBAL_ROOT so its bins become PATH commands.
 */

export const GLOBAL_ROOT = '/home/user/.local/lib/node_modules'

export interface InstallReport {
  added: { name: string; version: string; nested: boolean }[]
  warnings: string[]
}

interface Queued {
  name: string
  range?: string
  /** where this dependency must be visible from — its dependents' dir */
  installRoot: string
}

export async function installPackages(
  vfs: Vfs,
  requests: { name: string; range?: string }[],
  root = '/',
  onProgress?: (line: string) => void,
): Promise<InstallReport> {
  const report: InstallReport = { added: [], warnings: [] }
  const base = root === '/' ? '' : root
  const rootInstalled = new Map<string, string>() // name -> version at <root>/node_modules
  const queue: Queued[] = requests.map((r) => ({ ...r, installRoot: root }))
  const seen = new Set<string>() // `${installRoot}::${name}`

  while (queue.length > 0) {
    const { name, range, installRoot } = queue.shift()!
    const key = `${installRoot}::${name}`
    if (seen.has(key)) continue
    seen.add(key)

    const manifestPath = `${installRoot === '/' ? '' : installRoot}/node_modules/${name}/package.json`
    const existing = readManifest(vfs, manifestPath)
    if (existing !== null) {
      try {
        const installedVersion = (existing as { version?: string }).version
        // already satisfied? then this edge of the graph is done
        const metadata = await fetchMetadata(name)
        try {
          const resolved = pickVersion(metadata, range)
          if (resolved.version === installedVersion) continue
        } catch {
          continue // range unresolvable but the package is present — keep it
        }
      } catch {
        // corrupt manifest — reinstall over it
      }
    }

    onProgress?.(`resolving ${name}${range ? `@${range}` : ''}`)
    const metadata = await fetchMetadata(name)
    const version = pickVersion(metadata, range)
    if (version.deprecated) {
      report.warnings.push(`npm WARN deprecated ${name}@${version.version}: ${version.deprecated}`)
    }
    for (const [peer, peerRange] of Object.entries(version.peerDependencies ?? {})) {
      const peerManifest = readManifest(vfs, `${base}/node_modules/${peer}/package.json`)
      if (peerManifest === null && !requests.some((r) => r.name === peer)) {
        report.warnings.push(`npm WARN ${name}@${version.version} requires a peer of ${peer}@${peerRange} but none was installed`)
      }
    }

    // pick install dir: project root for top-level requests, otherwise nested
    // under the dependent package — version conflicts never clobber the root
    const installDir = `${installRoot === '/' ? '' : installRoot}/node_modules/${name}`
    const nested = installRoot !== root
    if (installRoot === root) {
      const rootVersion = rootInstalled.get(name)
      if (rootVersion !== undefined && rootVersion !== version.version) {
        report.warnings.push(`npm WARN keeping ${name}@${rootVersion} at root; ${version.version} requested additionally`)
        continue
      }
      rootInstalled.set(name, version.version)
    }

    onProgress?.(`fetching ${name}@${version.version}`)
    const entries = await fetchTarballEntries(version, name)
    const prefix = `${installDir}/`
    for (const entry of entries) {
      vfs.writeBytes(vfsPath.join(prefix, entry.path), entry.data)
    }
    report.added.push({ name, version: version.version, nested })

    for (const [depName, depRange] of Object.entries(version.dependencies ?? {})) {
      // visible at the package's own root; the resolver walks up from there
      queue.push({ name: depName, range: depRange, installRoot: installDir })
    }
  }

  return report
}

/** Nearest ancestor (cwd included) holding a package.json, like npm itself. */
export function projectRoot(vfs: Vfs, cwd: string): string | null {
  let dir = vfsPath.normalize(cwd)
  for (;;) {
    if (vfs.isFile(vfsPath.join(dir, 'package.json'))) return dir
    if (dir === '/') return null
    dir = vfsPath.dirname(dir)
  }
}

/** The dependency graph a project package.json declares. */
export function rootDependencies(vfs: Vfs, root = '/'): { name: string; range: string }[] {
  const manifest = vfs.read(`${root === '/' ? '' : root}/package.json`)
  if (manifest === null) return []
  try {
    const parsed = manifest as string
    const json = JSON.parse(parsed) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return [
      ...Object.entries(json.dependencies ?? {}),
      ...Object.entries(json.devDependencies ?? {}),
    ].map(([name, range]) => ({ name, range }))
  } catch {
    return []
  }
}

export function readManifest(vfs: Vfs, path = '/package.json'): Record<string, unknown> | null {
  // installed packages are stored as bytes — read() returns null for those,
  // so manifests always go through the byte reader
  const bytes = vfs.readBytes(path)
  if (bytes === null) return null
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) as Record<string, unknown>
  } catch {
    return null
  }
}

export function writeManifest(vfs: Vfs, manifest: Record<string, unknown>, path = '/package.json'): void {
  vfs.write(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** bin command map for one node_modules root: name -> absolute js/exe path. */
export function collectBins(vfs: Vfs, root = '/'): Map<string, string> {
  const bins = new Map<string, string>()
  // GLOBAL_ROOT (and any dir already ending in node_modules) IS the modules dir
  const modules = root.endsWith('/node_modules') ? root : `${root === '/' ? '' : root}/node_modules`
  if (!vfs.isDir(modules)) return bins
  for (const pkgName of vfs.readDir(modules)) {
    const manifest = readManifest(vfs, `${modules}/${pkgName}/package.json`)
    if (!manifest || typeof manifest.bin !== 'string' && typeof manifest.bin !== 'object') continue
    const pkgDir = `${modules}/${pkgName}`
    const resolveBin = (rel: string) => `${pkgDir}/${rel.replace(/^\.\//, '')}`
    if (typeof manifest.bin === 'string') {
      bins.set(pkgName, resolveBin(manifest.bin))
    } else {
      for (const [command, rel] of Object.entries(manifest.bin as Record<string, string>)) {
        bins.set(command, resolveBin(rel))
      }
    }
  }
  return bins
}

/**
 * npm's bin resolution: nearest node_modules first, walking up, global last —
 * so a project-local bin always wins over a global one.
 */
export function findBins(vfs: Vfs, cwd: string): Map<string, string> {
  const bins = new Map<string, string>()
  let dir = vfsPath.normalize(cwd)
  const roots: string[] = []
  for (;;) {
    roots.push(dir)
    if (dir === '/') break
    dir = vfsPath.dirname(dir)
  }
  // farthest first, cwd last (nearest wins), global before the walk-up chain
  for (const root of [GLOBAL_ROOT, ...roots.slice().reverse()]) {
    for (const [name, path] of collectBins(vfs, root)) bins.set(name, path)
  }
  return bins
}
