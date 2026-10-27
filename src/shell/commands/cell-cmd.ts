import { gunzipSync, gzipSync } from 'fflate'
import type { Vfs, VfsFileMap } from '../../vfs/types'
import { looksLikeText } from './git'
import { s3Fetch, type S3Config } from './sigv4'
import { runAgent } from './agent'
import { vfsPath } from '../../vfs/types'
import { tarFiles, untar } from './untar'
import type { CommandResult, ShellLike } from './npm'
import { platform } from '../../platform'

function platformBusEmit(payload: { dir: string }): void {
  try {
    platform().bus.emit('preview:open', payload)
  } catch {
    // platform not up (unit tests) — the preview command is a no-op then
  }
}

/**
 * `cell` — workspace-level tooling for long agentic sessions:
 *
 *   cell save      tar+gzip the whole VFS and PUT it to S3-compatible storage
 *   cell list      snapshots in the bucket
 *   cell load [n]  restore a snapshot (latest by default) — replaces the VFS
 *   cell status    configuration and workspace summary
 *
 * Storage is configured in ~/.cell/storage.json (endpoint, region, bucket,
 * keys, optional prefix) — Cloudflare R2, MinIO, AWS S3, anything speaking
 * the S3 REST API with CORS enabled for this origin.
 */

const CONFIG_PATH = '/home/user/.cell/storage.json'

function readConfig(vfs: Vfs): { config: S3Config } | { error: string } {
  const raw = vfs.read(CONFIG_PATH)
  if (raw === null) {
    return {
      error: `cell: no storage configured — create ${CONFIG_PATH}:\n{\n  "endpoint": "https://<account>.r2.cloudflarestorage.com",\n  "region": "auto",\n  "bucket": "cell-workspaces",\n  "accessKeyId": "...",\n  "secretAccessKey": "...",\n  "prefix": "cell/"\n}\n`,
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<S3Config>
    if (!parsed.endpoint || !parsed.bucket || !parsed.accessKeyId || !parsed.secretAccessKey) {
      return { error: `cell: ${CONFIG_PATH} needs endpoint, bucket, accessKeyId, secretAccessKey\n` }
    }
    return {
      config: {
        endpoint: parsed.endpoint,
        region: parsed.region ?? 'auto',
        bucket: parsed.bucket,
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        prefix: parsed.prefix ?? 'cell/',
      },
    }
  } catch {
    return { error: `cell: ${CONFIG_PATH} is not valid JSON\n` }
  }
}

function snapshotName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `workspace-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.tar.gz`
}

function workspaceTar(vfs: Vfs): Uint8Array {
  const files: { path: string; data: Uint8Array }[] = []
  for (const path of vfs.listAllFiles()) {
    const data = vfs.readBytes(path)
    if (data !== null) files.push({ path, data })
  }
  return gzipSync(tarFiles(files))
}

function restoreTar(vfs: Vfs, bytes: Uint8Array): { files: number; bytes: number } {
  const entries = untar(bytes, { stripFirstSegment: false })
  const files: VfsFileMap = {}
  for (const entry of entries) {
    if (entry.type && entry.type !== 'file') continue
    const path = entry.path.replace(/^\.\//, '')
    if (!path.startsWith('/')) continue
    files[path] = looksLikeText(entry.data) ? new TextDecoder().decode(entry.data) : entry.data
  }
  vfs.restore(files)
  let total = 0
  for (const data of Object.values(files)) total += typeof data === 'string' ? data.length : data.byteLength
  return { files: Object.keys(files).length, bytes: total }
}

async function listSnapshots(config: S3Config): Promise<{ names: string[] } | { error: string }> {
  const response = await s3Fetch(config, 'GET', '', { query: { 'list-type': '2', 'max-keys': '100' } })
  if (!response.ok) {
    return { error: `cell: list failed — HTTP ${response.status} ${await safeText(response)}\n(hint: the endpoint must allow CORS for this origin)\n` }
  }
  const xml = await response.text()
  const names: string[] = []
  for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) names.push(match[1])
  names.sort().reverse()
  return { names }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200).replace(/\n/g, ' ')
  } catch {
    return ''
  }
}

export async function cellCommand(vfs: Vfs, args: string[], opts: { cwd: string; shell?: ShellLike }): Promise<CommandResult> {
  const sub = args[0] ?? 'help'

  if (sub === 'agent') {
    if (!opts.shell) return { stdout: '', stderr: 'cell agent: no shell available in this context\n', exitCode: 1 }
    return runAgent(vfs, args.slice(1), { cwd: opts.cwd, shell: opts.shell })
  }

  if (sub === 'preview') {
    const positional = args.slice(1).filter((a) => !a.startsWith('-'))
    const dir = positional[0] !== undefined ? vfsPath.normalize(positional[0].replace(/^~/, '/home/user').startsWith('/') ? positional[0].replace(/^~/, '/home/user') : `${opts.cwd}/${positional[0]}`) : opts.cwd
    if (!vfs.isFile(vfsPath.join(dir, 'index.html'))) {
      return { stdout: '', stderr: `cell preview: no index.html in ${dir}\n`, exitCode: 1 }
    }
    const functions = vfs.isDir(`${dir}/api`) ? vfs.readDir(`${dir}/api`).filter((name) => name.endsWith('.js')) : []
    platformBusEmit({ dir })
    return {
      stdout: `preview opened for ${dir.replace(/^\/home\/user/, '~')} — the panel renders index.html live.\n${functions.length > 0 ? `api functions: ${functions.map((name) => `/api/${name.replace(/\.js$/, '')}`).join(', ')} run in the node isolate on every call.\n` : ''}edits reload it automatically (600ms debounce).\n`,
      stderr: '',
      exitCode: 0,
    }
  }

  if (sub === 'status') {
    const configured = readConfig(vfs)
    const paths = vfs.listAllFiles()
    let total = 0
    for (const path of paths) total += vfs.stat(path)?.size ?? 0
    const lines = [
      `workspace: ${paths.length} files, ${(total / 1024).toFixed(1)} KB`,
      `storage: ${'config' in configured ? `${configured.config.bucket} @ ${configured.config.endpoint}` : 'not configured'}`,
      'persistence: IndexedDB (this browser) + snapshots above',
    ]
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 }
  }

  if (sub === 'save' || sub === 'push') {
    const configured = readConfig(vfs)
    if ('error' in configured) return { stdout: '', stderr: configured.error, exitCode: 1 }
    const name = snapshotName()
    const body = workspaceTar(vfs)
    const response = await s3Fetch(configured.config, 'PUT', name, {
      body,
      contentType: 'application/gzip',
    })
    if (!response.ok) {
      return {
        stdout: '',
        stderr: `cell: save failed — HTTP ${response.status} ${await safeText(response)}\n(hint: the endpoint must allow CORS PUT for this origin)\n`,
        exitCode: 1,
      }
    }
    return { stdout: `saved ${name} (${(body.byteLength / 1024).toFixed(1)} KB) to ${configured.config.bucket}\n`, stderr: '', exitCode: 0 }
  }

  if (sub === 'list' || sub === 'ls') {
    const configured = readConfig(vfs)
    if ('error' in configured) return { stdout: '', stderr: configured.error, exitCode: 1 }
    const listed = await listSnapshots(configured.config)
    if ('error' in listed) return { stdout: '', stderr: listed.error, exitCode: 1 }
    if (listed.names.length === 0) return { stdout: 'no snapshots yet — run `cell save`\n', stderr: '', exitCode: 0 }
    return { stdout: `${listed.names.map((name, i) => `${listed.names.length - i}. ${name}`).join('\n')}\n`, stderr: '', exitCode: 0 }
  }

  if (sub === 'load' || sub === 'pull' || sub === 'restore') {
    const configured = readConfig(vfs)
    if ('error' in configured) return { stdout: '', stderr: configured.error, exitCode: 1 }
    const listed = await listSnapshots(configured.config)
    if ('error' in listed) return { stdout: '', stderr: listed.error, exitCode: 1 }
    if (listed.names.length === 0) {
      return { stdout: '', stderr: 'cell: no snapshots to load — run `cell save` first\n', exitCode: 1 }
    }
    const index = args[1] !== undefined ? parseInt(args[1], 10) : 1
    const name = Number.isFinite(index) && index >= 1 && index <= listed.names.length
      ? listed.names[index - 1]
      : args[1]
    if (!name || !listed.names.includes(name)) {
      return { stdout: '', stderr: `cell: no such snapshot — run \`cell list\` (${listed.names.length} available)\n`, exitCode: 1 }
    }
    const response = await s3Fetch(configured.config, 'GET', name)
    if (!response.ok) {
      return { stdout: '', stderr: `cell: load failed — HTTP ${response.status}\n`, exitCode: 1 }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    let restored: { files: number; bytes: number }
    try {
      restored = restoreTar(vfs, gunzipSync(bytes))
    } catch (err) {
      return { stdout: '', stderr: `cell: snapshot is corrupt: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }
    }
    return {
      stdout: `restored ${name} — ${restored.files} files (${(restored.bytes / 1024).toFixed(1)} KB). Reload advised: everything is live in the tree.\n`,
      stderr: '',
      exitCode: 0,
    }
  }

  return {
    stdout:
      'usage: cell <command>\n\npreview run the app right here: cell preview [dir] — static + Vercel-style api/\nagent   run the headless AI agent: cell agent "fix the failing test" [--steps N]\nsave    snapshot the whole workspace to object storage (tar.gz, SigV4 PUT)\nlist    snapshots in the bucket\nload    restore a snapshot: `cell load` (latest) or `cell load 3`\nstatus  configuration and workspace summary\n\nagent config: ~/.cell/agent.json — storage: ~/.cell/storage.json — env keys: ~/.cell/env.json\n',
    stderr: '',
    exitCode: sub === 'help' ? 0 : 1,
  }
}
