import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createDiskVfs } from './disk-vfs'
import { s3Fetch } from '../src/shell/commands/sigv4'

/**
 * Snapshot store for headless agent workspaces.
 *
 * Container lifecycle: pull a workspace snapshot on start, push it back on
 * idle stop. The browser `cell save` path (tar+gzip to S3) is separate;
 * this module is the server-side equivalent without gzip (plain tar — the
 * store compresses at rest if it wants to).
 *
 * CLI contract (server/run-once.ts):
 *   --pull <name>  restore snapshot before the run; 'fresh' leaves root as-is
 *   --push <name>  store snapshot after the run, even on failure
 *   CELL_SNAPSHOTS_DIR  local store dir (default: <workspace>/../snapshots,
 *                       resolved absolute — a sibling of the workspace)
 *
 * Future S3 backend env vars (see S3Store below):
 *   CELL_S3_ENDPOINT, CELL_S3_REGION, CELL_S3_BUCKET,
 *   CELL_S3_ACCESS_KEY, CELL_S3_SECRET_KEY, CELL_S3_PREFIX (optional)
 */

export interface SnapshotFileEntry {
  path: string
  sha256: string
  size: number
}

export interface SnapshotManifest {
  name: string
  createdAt: string
  files: SnapshotFileEntry[]
}

export interface PushResult {
  manifest: SnapshotManifest
  skipped: boolean
}

export interface PullResult {
  status: 'fresh' | 'restored'
  manifest?: SnapshotManifest
}

export interface SnapshotOptions {
  exclude?: RegExp[]
  slim?: boolean
}

export interface SnapshotStore {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
}

export function tarKey(name: string): string {
  return `${name}.tar`
}

export function manifestKey(name: string): string {
  return `${name}.manifest.json`
}

export function defaultSnapshotsDir(workspaceRoot: string): string {
  return resolve(join(resolve(workspaceRoot), '..', 'snapshots'))
}

function isExcluded(path: string, opts: SnapshotOptions | undefined): boolean {
  // pull scratch dirs (crashed-pull leftovers) are never part of a snapshot
  if (/(^|\/)\.snapshot-tmp-[^/]+(\/|$)/.test(path)) return true
  if (opts?.slim === true) {
    if (path === '/node_modules' || path.startsWith('/node_modules/') || path.includes('/node_modules/')) return true
  }
  const patterns = opts?.exclude ?? []
  for (const pattern of patterns) {
    // reset lastIndex for global/sticky patterns so repeated tests are stable
    pattern.lastIndex = 0
    if (pattern.test(path)) return true
  }
  return false
}

export function ensureTarAvailable(): void {
  try {
    const result = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error('tar not usable')
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('snapshots:')) throw err
    throw new Error('snapshots: system `tar` binary not found or not runnable — install tar to use snapshots')
  }
}

function runTar(args: string[], stdin: Uint8Array | null): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (err) => {
      rejectPromise(
        new Error(`snapshots: failed to run \`tar\` — is it installed? (${err instanceof Error ? err.message : String(err)})`),
      )
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      } else {
        rejectPromise(new Error(`snapshots: tar ${args[0] ?? ''} failed (exit ${String(code)}): ${Buffer.concat(err).toString('utf8').slice(0, 500)}`))
      }
    })
    if (stdin !== null && stdin.byteLength > 0) {
      child.stdin.write(stdin)
    }
    child.stdin.end()
  })
}

export function computeManifest(root: string, name: string, opts?: SnapshotOptions): SnapshotManifest {
  const vfs = createDiskVfs(root)
  const files: SnapshotFileEntry[] = []
  // per-file hashing: never concatenates workspace contents into one string
  for (const path of vfs.listAllFiles()) {
    if (isExcluded(path, opts)) continue
    const data = vfs.readBytes(path)
    if (data === null) continue
    const sha256 = createHash('sha256').update(data).digest('hex')
    files.push({ path, sha256, size: data.byteLength })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { name, createdAt: new Date().toISOString(), files }
}

function manifestsEqualFiles(a: SnapshotManifest, b: SnapshotManifest): boolean {
  if (a.files.length !== b.files.length) return false
  for (let i = 0; i < a.files.length; i++) {
    const fa = a.files[i]
    const fb = b.files[i]
    if (fa.path !== fb.path || fa.sha256 !== fb.sha256 || fa.size !== fb.size) return false
  }
  return true
}

function parseStoredManifest(raw: Uint8Array | null): SnapshotManifest | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as SnapshotManifest
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

async function createTarBytes(root: string, relativePaths: string[]): Promise<Uint8Array> {
  ensureTarAvailable()
  const scratch = mkdtempSync(join(tmpdir(), 'cell-snapshot-'))
  const tarPath = join(scratch, 'snapshot.tar')
  try {
    const base = resolve(root)
    mkdirSync(base, { recursive: true })
    if (relativePaths.length === 0) {
      await runTar(['--create', '--file', tarPath, '--directory', base, '--files-from', '/dev/null'], null)
    } else {
      const encoder = new TextEncoder()
      const parts: Uint8Array[] = []
      for (const rel of relativePaths) {
        const encoded = encoder.encode(rel)
        const nulled = new Uint8Array(encoded.byteLength + 1)
        nulled.set(encoded, 0)
        nulled[encoded.byteLength] = 0
        parts.push(nulled)
      }
      const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
      const stdin = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        stdin.set(part, offset)
        offset += part.byteLength
      }
      await runTar(
        ['--create', '--file', tarPath, '--directory', base, '--null', '--verbatim-files-from', '--files-from', '-'],
        stdin,
      )
    }
    return new Uint8Array(readFileSync(tarPath))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Reject link members after extraction by inspecting the extracted tree
 * directly (lstat, not tar output parsing): version-proof, and it catches
 * pre-existing-link traversal that same-archive checks miss. Snapshots
 * deliberately do not preserve symlinks or hardlinks. */
function rejectNonRegularEntries(dir: string): void {
  const walk = (current: string, rel: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const member = rel === '' ? name : `${rel}/${name}`
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        throw new Error(`snapshots: archive member '${member}' vanished during validation — store is corrupt`)
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`snapshots: archive contains symlink '${member}' — snapshots do not preserve links, restore aborted`)
      }
      if (stat.isFile() && stat.nlink > 1) {
        throw new Error(`snapshots: archive contains hard link '${member}' — snapshots do not preserve links, restore aborted`)
      }
      if (stat.isDirectory()) walk(full, member)
    }
  }
  walk(dir, '')
}

function assertSafeTarMembers(stdout: string): void {
  for (const line of stdout.split('\n')) {
    const member = line.trim().replace(/^\.\//, '')
    if (member === '' || member === '.') continue
    if (member.startsWith('/') || member.split('/').includes('..')) {
      throw new Error(`snapshots: archive member escapes workspace: '${line.trim()}' — restore aborted`)
    }
  }
}

export async function pushSnapshot(
  root: string,
  store: SnapshotStore,
  name: string,
  opts?: SnapshotOptions,
): Promise<PushResult> {
  ensureTarAvailable()
  const manifest = computeManifest(root, name, opts)
  const stored = parseStoredManifest(await store.get(manifestKey(name)))
  if (stored !== null && stored.name === name && manifestsEqualFiles(stored, manifest)) {
    return { manifest: stored, skipped: true }
  }
  const relativePaths = manifest.files.map((entry) => entry.path.replace(/^\/+/, ''))
  const tarBytes = await createTarBytes(root, relativePaths)
  await store.put(tarKey(name), tarBytes)
  await store.put(manifestKey(name), new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
  return { manifest, skipped: false }
}

export async function pullSnapshot(root: string, store: SnapshotStore, name: string): Promise<PullResult> {
  ensureTarAvailable()
  const stored = parseStoredManifest(await store.get(manifestKey(name)))
  if (stored === null) {
    if ((await store.get(tarKey(name))) !== null) {
      throw new Error(`snapshots: '${tarKey(name)}' exists but '${manifestKey(name)}' is missing — store is corrupt`)
    }
    return { status: 'fresh' }
  }
  const tarBytes = await store.get(tarKey(name))
  if (tarBytes === null) {
    throw new Error(`snapshots: manifest '${name}' exists but '${tarKey(name)}' is missing — store is corrupt`)
  }
  // scratch lives INSIDE the workspace root: rename() cannot cross the
  // container/volume device boundary, and wipe/move stay on one filesystem.
  // Concurrent pulls use distinct dirs; the wipe loop below skips them.
  const base = resolve(root)
  mkdirSync(base, { recursive: true })
  const scratch = mkdtempSync(join(base, '.snapshot-tmp-'))
  const tarPath = join(scratch, 'snapshot.tar')
  const extractDir = join(scratch, 'extract')
  try {
    writeFileSync(tarPath, tarBytes)
    const listed = await runTar(['--list', '--file', tarPath], null)
    assertSafeTarMembers(listed.stdout)
    // extract + validate + verify BEFORE touching the live workspace: a
    // tar that aborts mid-extract must not destroy existing state
    mkdirSync(extractDir, { recursive: true })
    await runTar(['--extract', '--file', tarPath, '--directory', extractDir], null)
    rejectNonRegularEntries(extractDir)
    const rebuilt = computeManifest(extractDir, name)
    if (!manifestsEqualFiles(stored, rebuilt)) {
      throw new Error(`snapshots: '${name}' tar contents do not match its manifest (stale or tampered store) — restore aborted`)
    }
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('.snapshot-tmp-')) continue
      rmSync(join(base, entry), { recursive: true, force: true })
    }
    for (const entry of readdirSync(extractDir)) {
      renameSync(join(extractDir, entry), join(base, entry))
    }
    return { status: 'restored', manifest: stored }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function LocalDirStore(dir: string): SnapshotStore {
  const base = resolve(dir)
  function keyPath(key: string): string {
    const full = resolve(join(base, key))
    if (full !== base && !full.startsWith(`${base}${sep}`)) {
      throw new Error(`snapshots: store key escapes directory: '${key}'`)
    }
    return full
  }
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const full = keyPath(key)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, bytes)
    },
    async get(key: string): Promise<Uint8Array | null> {
      const full = keyPath(key)
      if (!existsSync(full)) return null
      return new Uint8Array(readFileSync(full))
    },
  }
}

export interface S3StoreOptions {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  prefix?: string
}

/**
 * S3 backend reusing the browser's self-contained SigV4 signer
 * (src/shell/commands/sigv4.ts). That module has no browser-only imports —
 * just WebCrypto subtle + global fetch, both available in Node 18+ — so no
 * aws-sdk is needed. Keys map 1:1 to SnapshotStore keys
 * (`<name>.tar`, `<name>.manifest.json`) under the prefix.
 */
export function S3Store(options: S3StoreOptions): SnapshotStore {
  const config = {
    endpoint: options.endpoint,
    region: options.region,
    bucket: options.bucket,
    accessKeyId: options.accessKey,
    secretAccessKey: options.secretKey,
    prefix: options.prefix ?? '',
  }
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const response = await s3Fetch(config, 'PUT', key, {
        body: bytes,
        contentType: key.endsWith('.json') ? 'application/json' : 'application/x-tar',
      })
      if (!response.ok) {
        throw new Error(`snapshots: S3 PUT '${key}' failed — HTTP ${response.status}`)
      }
    },
    async get(key: string): Promise<Uint8Array | null> {
      const response = await s3Fetch(config, 'GET', key)
      if (response.status === 404) return null
      if (!response.ok) {
        throw new Error(`snapshots: S3 GET '${key}' failed — HTTP ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

export function S3StoreFromEnv(): SnapshotStore {
  const endpoint = process.env.CELL_S3_ENDPOINT ?? ''
  const region = process.env.CELL_S3_REGION ?? 'auto'
  const bucket = process.env.CELL_S3_BUCKET ?? ''
  const accessKey = process.env.CELL_S3_ACCESS_KEY ?? ''
  const secretKey = process.env.CELL_S3_SECRET_KEY ?? ''
  if (endpoint === '' || bucket === '' || accessKey === '' || secretKey === '') {
    throw new Error(
      'snapshots: S3 store needs CELL_S3_ENDPOINT, CELL_S3_BUCKET, CELL_S3_ACCESS_KEY, CELL_S3_SECRET_KEY (optional: CELL_S3_REGION, CELL_S3_PREFIX)',
    )
  }
  return S3Store({ endpoint, region, bucket, accessKey, secretKey, prefix: process.env.CELL_S3_PREFIX ?? '' })
}
