import { gunzipSync } from 'fflate'
import { satisfies, valid, validRange, coerce } from 'semver'
import { untar, type TarEntry } from './untar'

/**
 * npm registry client for the browser. registry.npmjs.org serves CORS on
 * GET, so metadata and tarballs come straight over HTTPS — no proxy. The
 * tarball cache is content-addressed by URL and lives for the session.
 */

const REGISTRY = 'https://registry.npmjs.org'

export interface RegistryVersion {
  version: string
  dist: { tarball: string; shasum?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  bin?: string | Record<string, string>
  deprecated?: string
}

export interface RegistryMetadata {
  'dist-tags'?: Record<string, string>
  versions: Record<string, RegistryVersion>
}

const metadataCache = new Map<string, RegistryMetadata>()
const tarballCache = new Map<string, Uint8Array>()

export async function fetchMetadata(name: string): Promise<RegistryMetadata> {
  const cached = metadataCache.get(name)
  if (cached) return cached
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`)
  if (!response.ok) {
    throw new Error(response.status === 404 ? `npm ERR! 404 Not Found - GET ${REGISTRY}/${name}` : `npm ERR! ${response.status} fetching ${name}`)
  }
  const metadata = (await response.json()) as RegistryMetadata
  metadataCache.set(name, metadata)
  return metadata
}

export function pickVersion(metadata: RegistryMetadata, range?: string): RegistryVersion {
  const versions = metadata.versions
  if (!range || range === 'latest') {
    const latest = metadata['dist-tags']?.latest
    if (latest && versions[latest]) return versions[latest]
    const keys = Object.keys(versions)
    if (keys.length === 0) throw new Error(`npm ERR! no versions for package`)
    return versions[keys[keys.length - 1]]
  }
  if (valid(range)) {
    const exact = versions[range]
    if (!exact) throw new Error(`npm ERR! no matching version ${range}`)
    return exact
  }
  if (!validRange(range)) {
    throw new Error(`npm ERR! Invalid version range: ${range}`)
  }
  // newest matching stable release; prereleases only when the range asks for them
  const candidates = Object.keys(versions)
    .filter((v) => satisfies(v, range, { includePrerelease: range.includes('-') }))
    .sort((a, b) => (coerce(a)!.compare(coerce(b)!) || (a < b ? -1 : 1)))
  const pick = candidates[candidates.length - 1] ?? metadata['dist-tags']?.latest
  if (!pick || !versions[pick]) throw new Error(`npm ERR! No matching version found for ${range}`)
  return versions[pick]
}

async function sha1hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchTarballEntries(version: RegistryVersion, name: string): Promise<TarEntry[]> {
  const url = version.dist.tarball
  const cached = tarballCache.get(url)
  let tgz = cached
  if (!tgz) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`npm ERR! ${response.status} fetching tarball for ${name}@${version.version}`)
    tgz = new Uint8Array(await response.arrayBuffer())
    if (version.dist.shasum) {
      const actual = await sha1hex(tgz)
      if (actual !== version.dist.shasum) {
        throw new Error(`npm ERR! integrity mismatch for ${name}@${version.version} (want ${version.dist.shasum}, got ${actual})`)
      }
    }
    tarballCache.set(url, tgz)
  }
  return untar(gunzipSync(tgz))
}
