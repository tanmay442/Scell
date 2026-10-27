import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import { fetchMetadata, fetchTarballEntries, pickVersion, type RegistryVersion } from './registry'

/**
 * Dependency installer: BFS over the semver graph, flat hoisting with
 * first-wins at the root and nested node_modules only on version conflict —
 * the model pnpm made popular, minus the symlink trickery a browser VFS
 * cannot honor. Binaries inside packages are stored as raw bytes.
 */

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
  onProgress?: (line: string) => void,
): Promise<InstallReport> {
  const report: InstallReport = { added: [], warnings: [] }
  const rootInstalled = new Map<string, string>() // name -> version at /node_modules
  const queue: Queued[] = requests.map((r) => ({ ...r, installRoot: '/' }))
  const seen = new Set<string>() // `${installRoot}::${name}`

  while (queue.length > 0) {
    const { name, range, installRoot } = queue.shift()!
    const key = `${installRoot}::${name}`
    if (seen.has(key)) continue
    seen.add(key)

    const manifestPath = `${installRoot}node_modules/${name}/package.json`
    const existing = vfs.read(manifestPath)
    if (existing !== null) {
      try {
        const installedVersion = (JSON.parse(existing) as { version?: string }).version
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
      const peerManifest = vfs.read(`/node_modules/${peer}/package.json`)
      if (peerManifest === null && !requests.some((r) => r.name === peer)) {
        report.warnings.push(`npm WARN ${name}@${version.version} requires a peer of ${peer}@${peerRange} but none was installed`)
      }
    }

    // pick install dir: root for top-level requests, otherwise nested under
    // the dependent package — version conflicts never clobber the root copy
    const installDir = `${installRoot === '/' ? '' : installRoot}/node_modules/${name}`
    const nested = installRoot !== '/'
    if (installRoot === '/') {
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

/** The dependency graph the root package.json declares. */
export function rootDependencies(vfs: Vfs): { name: string; range: string }[] {
  const manifest = vfs.read('/package.json')
  if (manifest === null) return []
  try {
    const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return [
      ...Object.entries(parsed.dependencies ?? {}),
      ...Object.entries(parsed.devDependencies ?? {}),
    ].map(([name, range]) => ({ name, range }))
  } catch {
    return []
  }
}

export function readManifest(vfs: Vfs, path = '/package.json'): Record<string, unknown> | null {
  const text = vfs.read(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export function writeManifest(vfs: Vfs, manifest: Record<string, unknown>, path = '/package.json'): void {
  vfs.write(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** bin command map across installed packages: name -> absolute js path. */
export function collectBins(vfs: Vfs): Map<string, string> {
  const bins = new Map<string, string>()
  const root = '/node_modules'
  if (!vfs.isDir(root)) return bins
  for (const pkgName of vfs.readDir(root)) {
    const manifestPath = `${root}/${pkgName}/package.json`
    const manifest = readManifest(vfs, manifestPath)
    if (!manifest || typeof manifest.bin !== 'string' && typeof manifest.bin !== 'object') continue
    const pkgDir = `${root}/${pkgName}`
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

export type { RegistryVersion }
