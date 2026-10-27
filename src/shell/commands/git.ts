import type { WasmGitModule } from 'wasm-git/lg2_async.js'
import type { Vfs } from '../../vfs/types'
import type { CommandResult } from './npm'

/**
 * Full git via wasm-git: libgit2 1.9.4 compiled to WASM (Asyncify build —
 * no SharedArrayBuffer, runs on the main thread). We drive lg2, libgit2's
 * example CLI, exactly like the real `git` binary: same subcommands, same
 * semantics, same repository format.
 *
 * There is no hidden repo store: the workspace — including `.git/` — is
 * copied into libgit2's MEMFS before each command and copied back after,
 * binary-safe. The `.git` directory is a real directory in the VFS, visible
 * in the tree, persisted with the workspace like every other file.
 *
 * Network (clone/fetch/push): libgit2's own https transport over
 * XMLHttpRequest — but a browser may only reach servers that send CORS
 * headers, and lg2's Asyncify wedge never returns when the XHR is blocked
 * outright. So origins are probed with fetch first: reachable origins get
 * the real direct transport; blocked ones go through a CORS relay,
 * configurable in ~/.gitconfig:
 *
 *   [cell]
 *       corsproxy = https://your-relay.example/
 */

const WASM_URL = '/wasm/lg2_async.wasm'
/** the bridge mirrors the whole VFS at MEMFS / */
const GIT_ROOT = '/'
const HOME = '/home/user'
const GITCONFIG_MEMFS = '/home/web_user/.gitconfig'
const DEFAULT_RELAYS = ['https://gh-proxy.com/', 'https://cors.isomorphic-git.org/']
/** MEMFS paths that are emscripten/git internals, never workspace files */
const MEMFS_SKIP = new Set(['/home/web_user', '/tmp', '/dev', '/proc', '/etc', '/var', '/usr', '/bin', '/lib', '/opt', '/workspace'])

function isMemfsSkip(path: string): boolean {
  // node_modules is never synced: git wouldn't track it anyway, and moving
  // a freshly installed 100MB CLI through MEMFS per status call kills the tab
  if (path.includes('/node_modules/')) return true
  if (MEMFS_SKIP.has(path)) return true
  for (const skip of MEMFS_SKIP) {
    if (path.startsWith(`${skip}/`)) return true
  }
  return false
}

type GitModule = WasmGitModule

let modulePromise: Promise<GitModule> | null = null
let outputCollector: { out: string[]; err: string[] } | null = null

/** Browser: the copy in /public. Node (tests): the installed package file. */
function resolveWasmUrl(): string {
  if (typeof document !== 'undefined') return WASM_URL
  return new URL('../../../node_modules/wasm-git/lg2_async.wasm', import.meta.url).href
}

async function loadGit(): Promise<GitModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const initGit = (await import('wasm-git/lg2_async.js')).default
      const mod = await initGit({
        locateFile: () => resolveWasmUrl(),
        print: (text: string) => outputCollector?.out.push(text),
        printErr: (text: string) => outputCollector?.err.push(text),
      })
      mod.FS.mkdirTree('/home/web_user')
      return mod
    })().catch((err) => {
      modulePromise = null
      throw err
    })
  }
  return modulePromise
}

// ---- text/binary classification -------------------------------------------

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * The VFS stores text and bytes separately (editors and the typechecker read
 * text; packfiles and indexes are bytes). MEMFS only has bytes — this decides
 * which kind a synced-back file is. Text = strict UTF-8 with no control
 * characters beyond tab/newline/CR/FF/ESC.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true
  let text: string
  try {
    text = utf8Strict.decode(bytes)
  } catch {
    return false
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 27) return false
    if (code === 0xfffd) return false
  }
  return true
}

// ---- repo discovery: real .git directories in the VFS ----------------------

/** Every worktree whose `.git` exists in the VFS (a dir with HEAD, or a linked file). */
export function findGitRepos(vfs: Vfs): string[] {
  const roots = new Set<string>()
  for (const path of vfs.listAllFiles()) {
    if (path.endsWith('/.git/HEAD') && vfs.isFile(path)) {
      roots.add(path.slice(0, -'/.git/HEAD'.length) || '/')
    } else if (path.endsWith('/.git') && vfs.isFile(path)) {
      // submodule / worktree pointer file ("gitdir: …") — still a repo root
      roots.add(path.slice(0, -'/.git'.length) || '/')
    }
  }
  return [...roots].sort()
}

// ---- VFS <-> MEMFS sync ---------------------------------------------------

function isDir(mod: GitModule, path: string): boolean {
  try {
    // this emscripten build's stat is a plain object: no isDirectory()
    // method, directories are mode & 0xf000 === 0x4000 (S_IFDIR)
    const stat = mod.FS.stat(path) as unknown as { mode?: number; isDirectory?: unknown }
    if (typeof stat.isDirectory === 'function') return (stat.isDirectory as () => boolean)()
    return typeof stat.mode === 'number' && (stat.mode & 0xf000) === 0x4000
  } catch {
    return false
  }
}

function memfsRemoveRecursive(mod: GitModule, path: string) {
  if (isDir(mod, path)) {
    for (const name of mod.FS.readdir(path)) {
      if (name !== '.' && name !== '..') memfsRemoveRecursive(mod, `${path}/${name}`)
    }
    try {
      mod.FS.rmdir(path)
    } catch {
      // already gone
    }
  } else {
    try {
      mod.FS.unlink(path)
    } catch {
      // already gone
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** Bridge the user's ~/.gitconfig into libgit2's emscripten HOME before each run. */
function pushUserConfig(mod: GitModule, vfs: Vfs): void {
  const config = vfs.read(`${HOME}/.gitconfig`)
  if (config !== null) {
    try {
      mod.FS.writeFile(GITCONFIG_MEMFS, config)
    } catch {
      // best effort — lg2 has a built-in fallback identity
    }
  }
}

/** `git config --global` writes go to the emscripten HOME; mirror them back. */
function pullUserConfig(mod: GitModule, vfs: Vfs): void {
  try {
    const bytes = mod.FS.readFile(GITCONFIG_MEMFS)
    if (!looksLikeText(bytes)) return
    const text = new TextDecoder().decode(bytes)
    if (text !== vfs.read(`${HOME}/.gitconfig`)) vfs.write(`${HOME}/.gitconfig`, text)
  } catch {
    // never written — nothing to mirror
  }
}

/** Load (or reuse) the module and mirror the VFS into MEMFS for a run at gitCwd. */
async function prepareGit(vfs: Vfs, gitCwd: string): Promise<GitModule> {
  const mod = await loadGit()
  mod.FS.mkdirTree(gitCwd)
  pushUserConfig(mod, vfs)
  syncVfsToMemfs(mod, vfs)
  mod.FS.chdir(gitCwd)
  return mod
}

/** VFS workspace -> MEMFS, .git included: real files both sides. */
function syncVfsToMemfs(mod: GitModule, vfs: Vfs): void {
  const wanted = new Map<string, Uint8Array>()
  for (const path of vfs.listAllFiles()) {
    if (isMemfsSkip(path)) continue
    const bytes = vfs.readBytes(path)
    if (bytes !== null) wanted.set(path, bytes)
  }
  const removeMissing = (dir: string) => {
    let names: string[]
    try {
      names = mod.FS.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (isMemfsSkip(path)) continue
      if (isDir(mod, path)) removeMissing(path)
      else if (!wanted.has(path)) {
        try {
          mod.FS.unlink(path)
        } catch {
          // already gone
        }
      }
    }
  }
  removeMissing(GIT_ROOT)
  for (const [path, bytes] of wanted) {
    try {
      mod.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/')
      const existing = mod.FS.analyzePath(path).exists
      if (!existing || !bytesEqual(mod.FS.readFile(path), bytes)) {
        mod.FS.writeFile(path, bytes)
      }
    } catch {
      // skip unwritable entries — the command itself still runs
    }
  }
}

/**
 * MEMFS -> VFS workspace, .git included. Text-looking files land as text so
 * editors and the typechecker can open them; the rest as raw bytes. Defensive
 * by design: a filesystem surprise must never lose the command's output.
 */
function syncMemfsToVfs(mod: GitModule, vfs: Vfs): void {
  const present = new Set<string>()
  let walkOk = true
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = mod.FS.readdir(dir)
    } catch {
      walkOk = false
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (isMemfsSkip(path)) continue
      if (isDir(mod, path)) walk(path)
      else {
        try {
          present.add(path)
          const bytes = mod.FS.readFile(path)
          const current = vfs.readBytes(path)
          if (current === null || !bytesEqual(current, bytes)) {
            // copy: MEMFS may hand back a view over its own buffer
            const copy = new Uint8Array(bytes)
            if (looksLikeText(copy)) vfs.write(path, new TextDecoder().decode(copy))
            else vfs.writeBytes(path, copy)
          }
        } catch {
          // unreadable entry — skip rather than fail the whole sync
        }
      }
    }
  }
  walk(GIT_ROOT)
  // only delete when the walk succeeded — a failed walk saw nothing
  if (walkOk) {
    for (const path of vfs.listAllFiles()) {
      if (isMemfsSkip(path)) continue
      if (!present.has(path)) vfs.delete(path)
    }
  }
}

// ---- running lg2 -----------------------------------------------------------

interface LgRun {
  exitCode: number
  out: string[]
  err: string[]
  failure: string | null
}

async function runLg(mod: GitModule, lgArgs: string[]): Promise<LgRun> {
  outputCollector = { out: [], err: [] }
  const collector = outputCollector
  let exitCode = 0
  let failure: string | null = null
  try {
    // Asyncify build: callMain returns a promise; lg2 always exits through
    // emscripten's exit path, which rejects with an ExitStatus even on
    // success — read .status instead of treating the throw as failure.
    const code = await mod.callMain(lgArgs)
    if (typeof code === 'number' && code !== 0) exitCode = code
  } catch (err) {
    const status = (err as { status?: unknown })?.status
    if (typeof status === 'number') {
      exitCode = status
    } else {
      const message = (err as { message?: unknown })?.message
      if (typeof message === 'string' && !/program terminat/i.test(message)) {
        const match = /^(\d+):\s*/.exec(message)
        if (match) {
          exitCode = parseInt(match[1], 10)
          const stderrText = message.slice(match[0].length)
          if (stderrText) collector.err.push(stderrText)
        } else {
          failure = message
        }
      } else if (typeof message === 'string') {
        exitCode = 0 // "Program terminated with exit(N)" without .status
        const match = /exit\((\d+)\)/.exec(message)
        if (match) exitCode = parseInt(match[1], 10)
      } else {
        failure = `${String(err)} ${Object.keys(err ?? {}).join(',')}`
      }
    }
  } finally {
    if (outputCollector === collector) outputCollector = null
  }
  return { exitCode, out: collector.out, err: collector.err, failure }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Recursive path:size fingerprint of an MEMFS subtree, or null when missing. */
function memfsFingerprint(mod: GitModule, dir: string): string | null {
  if (!isDir(mod, dir)) return null
  const parts: string[] = []
  const walk = (p: string) => {
    for (const name of mod.FS.readdir(p)) {
      if (name === '.' || name === '..') continue
      const full = p === '/' ? `/${name}` : `${p}/${name}`
      if (isDir(mod, full)) walk(full)
      else {
        try {
          parts.push(`${full}:${(mod.FS.stat(full) as { size?: number }).size ?? 0}`)
        } catch {
          // vanished mid-walk — the fingerprint just shifts, polling continues
        }
      }
    }
  }
  walk(dir)
  return parts.sort().join('|')
}

/**
 * lg2's clone returns from callMain while the async https transfer is still
 * running; the repository materializes in the background. Wait until the
 * target subtree stops changing.
 */
async function waitForCloneSettle(mod: GitModule, target: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = '\u0000'
  let stableTicks = 0
  while (Date.now() < deadline) {
    await sleep(250)
    const now = memfsFingerprint(mod, target) ?? ''
    if (now === last) {
      stableTicks++
      if (stableTicks >= 6 && now !== '') return
    } else {
      stableTicks = 0
    }
    last = now
  }
}

// ---- CORS probing and the relay --------------------------------------------

const corsBlockedCache = new Map<string, boolean>()

/**
 * A git URL is browser-reachable when fetch can read its ref advertisement
 * (CORS allows the read). Blocked origins never get a direct lg2 attempt:
 * the Asyncify wedge does not return from a browser-blocked XHR.
 */
async function originBlocked(url: string): Promise<boolean> {
  let probeUrl: string
  try {
    const parsed = new URL(url)
    probeUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/info/refs?service=git-upload-pack`
  } catch {
    return false
  }
  const cached = corsBlockedCache.get(probeUrl)
  if (cached !== undefined) return cached
  let blocked = false
  try {
    // the response itself is irrelevant — resolving at all means CORS passed
    await fetch(probeUrl, { method: 'GET' })
  } catch {
    blocked = true
  }
  corsBlockedCache.set(probeUrl, blocked)
  return blocked
}

/** Relays from ~/.gitconfig [cell] corsproxy (comma-separated), or public defaults. Empty when disabled. */
function relaysFor(vfs: Vfs): string[] {
  const config = vfs.read(`${HOME}/.gitconfig`)
  if (config === null) return DEFAULT_RELAYS
  let inCellSection = false
  for (const rawLine of config.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inCellSection = line === '[cell]' || line === '[cell ""]'
      continue
    }
    const match = /^corsproxy\s*=\s*(.*)$/.exec(line)
    if (match && inCellSection) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (!value || value === 'off' || value === 'disabled') return []
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => (entry.endsWith('/') ? entry : `${entry}/`))
    }
  }
  return DEFAULT_RELAYS
}

function relayedUrl(relay: string, url: string): string {
  return `${relay.replace(/\/+$/, '')}/${url}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function relayHint(): string {
  return [
    'hint: browsers can only reach git servers that send CORS headers.',
    'hint: clone from a CORS-enabled server directly, or relay through your own:',
    'hint:   git config --global cell.corsproxy https://your-relay.example/',
    'hint: any relay that forwards paths to the target works, e.g. a tiny',
    'hint: nginx in front of the repo host.',
  ].join('\n')
}

// ---- remote url surgery (for relayed fetch/push) ---------------------------

function memfsReadConfig(mod: GitModule, cwd: string): string | null {
  try {
    const bytes = mod.FS.readFile(`${cwd}/.git/config`)
    return looksLikeText(bytes) ? new TextDecoder().decode(bytes) : null
  } catch {
    return null
  }
}

function parseRemoteUrl(config: string): string | null {
  const match = /^\s*url\s*=\s*(\S+)\s*$/m.exec(config)
  return match ? match[1] : null
}

function memfsSetRemoteUrl(mod: GitModule, cwd: string, nextUrl: string): void {
  const config = memfsReadConfig(mod, cwd)
  if (config === null) return
  const updated = config.replace(/^(\s*url\s*=\s*)\S+(\s*)$/m, `$1${nextUrl}$2`)
  mod.FS.writeFile(`${cwd}/.git/config`, updated)
}

// ---- clone -----------------------------------------------------------------

function repoNameFromUrl(url: string): string {
  try {
    let name = new URL(url).pathname.replace(/\/+$/, '')
    name = name.slice(name.lastIndexOf('/') + 1)
    if (name.endsWith('.git')) name = name.slice(0, -4)
    return name || 'repo'
  } catch {
    return 'repo'
  }
}

interface CloneAttempt extends LgRun {
  ok: boolean
  mod: GitModule | null
}

/**
 * One clone attempt. Runs with its own prepared module; on timeout the
 * wedged module is abandoned and the next command loads a fresh one.
 */
async function attemptClone(vfs: Vfs, url: string, target: string, gitCwd: string, timeoutMs = 150_000): Promise<CloneAttempt> {
  let mod: GitModule
  try {
    mod = await prepareGit(vfs, gitCwd)
  } catch (err) {
    return { exitCode: 1, out: [], err: [describeError(err)], failure: 'load', ok: false, mod: null }
  }
  memfsRemoveRecursive(mod, target)

  let run: LgRun | null = null
  try {
    const race = await Promise.race([
      runLg(mod, ['clone', url, target]).then((r) => ({ r })),
      sleep(timeoutMs).then(() => ({ r: null })),
    ])
    if (race.r === null) {
      // Asyncify never returns from a browser-blocked XHR — abandon ship
      modulePromise = null
      outputCollector = null
      return {
        exitCode: 1,
        out: [],
        err: [`clone of ${url} stalled after ${timeoutMs / 1000}s (transport unreachable)`],
        failure: 'timeout',
        ok: false,
        mod: null,
      }
    }
    run = race.r
  } catch (err) {
    return { exitCode: 1, out: [], err: [describeError(err)], failure: 'run', ok: false, mod }
  }

  // keep collecting: progress and remote messages flush late (Asyncify)
  outputCollector = { out: run.out, err: run.err }
  await waitForCloneSettle(mod, target)
  outputCollector = null
  const ok = run.exitCode === 0 && run.failure === null && isDir(mod, `${target}/.git`)
  return { ...run, ok, mod }
}

/** A failed earlier attempt may have left a partial target; it is removed
 * inside attemptClone once the module is at hand. */

function cloneFailureOutput(note: string, attempts: { label: string; run: LgRun }[]): CommandResult {
  const details = attempts
    .map(({ label, run }) => {
      const text = [...run.err, ...run.out].filter(Boolean).join('\n')
      return text ? `${label}: ${text}` : `${label}: exit ${run.exitCode}`
    })
    .join('\n')
  return {
    stdout: '',
    stderr: `${note}\n${details}\n${relayHint()}`,
    exitCode: 1,
  }
}

async function runCloneFlow(vfs: Vfs, rest: string[], gitCwd: string): Promise<CommandResult> {
  const positional = rest.filter((a) => !a.startsWith('-'))
  const url = positional[0]
  const explicitDir = positional[1]
  if (!url) {
    return { stdout: '', stderr: 'usage: git clone <repository> [<dir>]\n', exitCode: 1 }
  }
  if (/^(git@|ssh:\/\/)/.test(url)) {
    return {
      stdout: '',
      stderr: 'git: browsers cannot open SSH connections — clone over https instead\n',
      exitCode: 1,
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { stdout: '', stderr: `git: unsupported repository URL '${url}' (https:// required in the browser)\n`, exitCode: 1 }
  }
  const target = explicitDir
    ? normalizePath(`${gitCwd}/${explicitDir}`)
    : normalizePath(`${gitCwd}/${repoNameFromUrl(url)}`)

  const relays = relaysFor(vfs)
  const blocked = await originBlocked(url)

  // direct attempt only for reachable origins — a blocked XHR wedges lg2
  const direct: CloneAttempt = blocked
    ? {
        exitCode: 1,
        out: [],
        err: [`${hostOf(url)} does not allow direct browser access (CORS)`],
        failure: null,
        ok: false,
        mod: null,
      }
    : await attemptClone(vfs, url, target, gitCwd)

  if (direct.ok && direct.mod) {
    syncMemfsToVfs(direct.mod, vfs)
    pullUserConfig(direct.mod, vfs)
    return finish(direct)
  }

  const failures: { label: string; run: LgRun }[] = [{ label: 'direct', run: direct }]
  for (const relay of relays) {
    const relayUrl = relayedUrl(relay, url)
    if (await originBlocked(relayUrl)) continue // unreachable from this browser
    const note = `cloning via CORS relay ${relay} — ${hostOf(url)} does not allow direct browser access`
    const relayed = await attemptClone(vfs, relayUrl, target, gitCwd)
    if (relayed.ok && relayed.mod) {
      syncMemfsToVfs(relayed.mod, vfs)
      // the repo must remember its real origin, not the relay
      const config = vfs.read(`${target}/.git/config`)
      if (config !== null && config.includes(relayUrl)) {
        vfs.write(`${target}/.git/config`, config.replace(relayUrl, url))
      }
      pullUserConfig(relayed.mod, vfs)
      relayed.out.unshift(note)
      return finish(relayed)
    }
    failures.push({ label: `relay ${relay}`, run: relayed })
  }
  return cloneFailureOutput(`clone of ${url} failed`, failures)
}

function finish(run: LgRun): CommandResult {
  const stdout = run.out.length > 0 ? `${run.out.join('\n')}\n` : ''
  const stderr = run.err.length > 0 ? `${run.err.join('\n')}\n` : ''
  return { stdout, stderr, exitCode: run.exitCode === 0 && stderr.includes('error') ? 1 : run.exitCode }
}

/** fetch/push: direct when the origin is reachable, one relay retry otherwise. */
async function runNetworkCommand(
  vfs: Vfs,
  lgArgs: string[],
  gitCwd: string,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  let mod: GitModule
  try {
    mod = await prepareGit(vfs, gitCwd)
  } catch (err) {
    return { stdout: '', stderr: `git: filesystem bridge failed: ${describeError(err)}\n`, exitCode: 1 }
  }
  const config = memfsReadConfig(mod, gitCwd)
  const remoteUrl = config !== null ? parseRemoteUrl(config) : null
  const blocked = remoteUrl !== null && /^https?:\/\//i.test(remoteUrl) && (await originBlocked(remoteUrl))

  let relay: string | null = null
  if (blocked && remoteUrl) {
    for (const candidate of relaysFor(vfs)) {
      if (!(await originBlocked(relayedUrl(candidate, remoteUrl)))) {
        relay = candidate
        break
      }
    }
  }

  const useRelay = relay !== null && remoteUrl !== null
  if (useRelay) {
    memfsSetRemoteUrl(mod, gitCwd, relayedUrl(relay!, remoteUrl!))
  }
  const note = useRelay
    ? `${lgArgs[0]}ing via CORS relay ${relay} — ${hostOf(remoteUrl!)} does not allow direct browser access`
    : null

  let run: LgRun
  try {
    const race = await Promise.race([
      runLg(mod, lgArgs).then((r) => ({ r })),
      sleep(timeoutMs).then(() => ({ r: null })),
    ])
    if (race.r === null) {
      modulePromise = null
      outputCollector = null
      return {
        stdout: '',
        stderr: `git: ${lgArgs[0]} stalled after ${timeoutMs / 1000}s (transport unreachable)\n${relayHint()}\n`,
        exitCode: 1,
      }
    }
    run = race.r
  } catch (err) {
    return { stdout: '', stderr: `git: ${describeError(err)}\n`, exitCode: 1 }
  }

  if (useRelay && remoteUrl) {
    memfsSetRemoteUrl(mod, gitCwd, remoteUrl)
  }
  syncMemfsToVfs(mod, vfs)
  pullUserConfig(mod, vfs)
  if (note) run.out.unshift(note)
  return finish(run)
}

// ---- the command ----------------------------------------------------------

export async function gitCommand(vfs: Vfs, args: string[], opts: { cwd: string }): Promise<CommandResult> {
  const { cwd } = opts
  if (args.length === 0) {
    return usage()
  }

  // `git -C <dir>` convenience; cwd is a VFS path (identity mapping)
  let lgArgs = [...args]
  let gitCwd = normalizePath(cwd === '' ? HOME : cwd)
  if (lgArgs[0] === '-C') {
    const target = lgArgs[1]
    lgArgs = lgArgs.slice(2)
    gitCwd = normalizePath(`${gitCwd}/${target ?? ''}`)
  }
  // lg2's init needs an explicit target directory
  if (lgArgs[0] === 'init' && lgArgs.length === 1) {
    lgArgs = ['init', '.']
  }

  if (lgArgs[0] === 'clone') {
    return runCloneFlow(vfs, lgArgs.slice(1), gitCwd)
  }

  let mod: GitModule
  try {
    mod = await prepareGit(vfs, gitCwd)
  } catch (err) {
    return {
      stdout: '',
      stderr: `git: ${describeError(err)}\n`,
      exitCode: 1,
    }
  }

  // lg2 ships no `pull` — run it as the fetch+merge real git performs
  if (lgArgs[0] === 'pull') {
    const fetch = await runNetworkCommand(vfs, ['fetch', ...lgArgs.slice(1)], gitCwd)
    if (fetch.exitCode !== 0) return fetch
    const merge = await runLg(mod, ['merge', 'FETCH_HEAD'])
    syncMemfsToVfs(mod, vfs)
    pullUserConfig(mod, vfs)
    return finish(merge)
  }

  if (lgArgs[0] === 'fetch' || lgArgs[0] === 'push') {
    return runNetworkCommand(vfs, lgArgs, gitCwd)
  }

  const run = await runLg(mod, lgArgs)
  if (run.failure !== null) {
    return {
      stdout: '',
      stderr: `git: ${run.failure}\n`,
      exitCode: 1,
    }
  }
  syncMemfsToVfs(mod, vfs)
  pullUserConfig(mod, vfs)
  return finish(run)
}

function normalizePath(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

function describeError(err: unknown): string {
  const anyErr = err as { message?: unknown; errno?: unknown; name?: unknown; status?: unknown }
  if (typeof anyErr?.errno === 'number') {
    return `${String(anyErr.name ?? 'ErrnoError')} errno=${anyErr.errno} (${String(anyErr.message ?? 'filesystem error')})`
  }
  if (err instanceof Error) return err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err.message
  if (typeof anyErr?.message === 'string') return `${anyErr.message}${typeof anyErr.status === 'number' ? ` (status ${anyErr.status})` : ''}`
  try {
    return `${String(err)} ${JSON.stringify(Object.keys(err ?? {}))}`
  } catch {
    return String(err)
  }
}

function usage(): CommandResult {
  return {
    stdout:
      'usage: git <command> [<args>]\n\nCell runs the real libgit2 (1.9.4, WebAssembly) through lg2.\nCommon: init, clone, add, rm, status, commit, log, checkout, diff, remote, fetch, pull, push, tag, stash\nNetwork needs CORS-enabled servers; others go through the relay in ~/.gitconfig [cell] corsproxy.\n',
    stderr: '',
    exitCode: 1,
  }
}
