import { canonicalRealPath, createDiskVfs, workspaceBaseReal } from './disk-vfs'
import { createNodeShell } from './node-shell'
import { scopeVfs } from '../src/vfs/scope'
import { ensureAgentConfig } from './bootstrap'
import { sessionId } from '../src/shell/commands/agent-sessions'
import type { ShellLike } from '../src/shell/commands/shell-types'
import type { Vfs } from '../src/vfs/types'
import { vfsPath } from '../src/vfs/types'

/**
 * Per-run capabilities for the headless agent server. Each run receives
 * exactly one thread directory plus the shared ~/.cell tree it needs to
 * function — nothing else is nameable through its Vfs, by construction.
 *
 * What a run CAN reach:
 *   - /home/user/threads/<threadId> (the scope root, cwd): full read/write.
 *   - /home/user/.cell (bind-mounted to itself): agent config
 *     (~/.cell/agent.json), sessions (~/.cell/sessions/, read/write so
 *     --resume keeps working), skills/tools/commands registries
 *     (~/.cell/skills|tools|commands, read), job logs (~/.cell/jobs, write).
 *     Agent-initiated file/shell access to this tree stays refused by the
 *     deny lists in src/shell/commands/agent-tools.ts — the mount preserves
 *     runAgent-internal access (config/session/skill loads, session saves),
 *     not agent access.
 * What a run CANNOT reach:
 *   - Any other thread dir, any other project, the rest of the workspace:
 *     file tools throw EINVAL outside the grant.
 *   - The host outside the workspace: unchanged disk-vfs containment.
 * Shell honesty note: the shells below run real bash rooted at the workspace
 * with the thread dir as cwd — bash itself is not chrooted (a command can
 * still spell `../..`), exactly as before. The hard boundary is the Vfs
 * scope (file tools + runAgent internals) plus the existing bash deny-pattern
 * scans; the shell cwd default keeps honest commands inside the thread.
 */

export const THREADS_DIR = '/home/user/threads'
export const CELL_CONFIG_MOUNT = '/home/user/.cell'
const SESSIONS_DIR = '/home/user/.cell/sessions'

/** Thread/session ids are bare file stems: no paths, no traversal games. */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_.-]+$/

export function isValidThreadId(id: string): boolean {
  if (id === '' || id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  return THREAD_ID_PATTERN.test(id)
}

/** Absolute VFS path of a thread dir; strips a trailing .json resume suffix. */
export function threadVfsPath(threadId: string): string {
  const bare = threadId.endsWith('.json') ? threadId.slice(0, -5) : threadId
  if (!isValidThreadId(bare)) {
    throw new Error(`bad thread id '${threadId}' — use the bare session/thread stem`)
  }
  return `${THREADS_DIR}/${bare}`
}

export interface RunContext {
  vfs: Vfs
  shell: ShellLike
  jobShell: ShellLike
  /** absolute VFS path of the thread dir — the run's workspace */
  cwd: string
}

/**
 * Build one run's capabilities: a scoped Vfs (thread dir + ~/.cell mount),
 * shells rooted at the workspace backing dir, and the thread cwd. Pre-seeds
 * the thread dir and the agent config so the run starts functional.
 */
export function buildRunContext(root: string, threadId: string): RunContext {
  const threadPath = threadVfsPath(threadId)
  const base = createDiskVfs(root)
  // readlink-aware scope: planted symlinks canonicalize outside the grant
  const toVfsPath = (real: string): string | null => {
    const baseReal = workspaceBaseReal(root)
    if (real === baseReal) return '/'
    if (!real.startsWith(`${baseReal}/`)) return null
    return vfsPath.normalize(`/${real.slice(baseReal.length + 1)}`)
  }
  const vfs = scopeVfs(base, threadPath, { [CELL_CONFIG_MOUNT]: CELL_CONFIG_MOUNT }, {
    resolveReal: (abs) => {
      try {
        return toVfsPath(canonicalRealPath(root, abs))
      } catch {
        return null
      }
    },
  })
  vfs.mkdir(threadPath)
  ensureAgentConfig(vfs)
  const shell = createNodeShell(root)
  const jobShell = createNodeShell(root)
  return { vfs, shell, jobShell, cwd: threadPath }
}

/** Fresh runs mint a thread id from the same generator sessions use. */
export function freshThreadId(): string {
  return sessionId()
}

/**
 * Resolve which thread dir a resumed run belongs in. Fresh runs write a
 * `<sessionId>.thread` sidecar (via noteThreadId) mapping their runAgent
 * session id to their thread dir; a resume follows that mapping so the run
 * lands back on the files it created. Sessions without a sidecar (older
 * runs, browser-created sessions) fall back to the resume id itself.
 */
export function resolveThreadForResume(root: string, resumeId: string): string {
  const bare = resumeId.endsWith('.json') ? resumeId.slice(0, -5) : resumeId
  if (!isValidThreadId(bare)) {
    throw new Error(`bad thread id '${resumeId}' — use the bare session/thread stem`)
  }
  try {
    const base = createDiskVfs(root)
    const sidecar = base.read(`${SESSIONS_DIR}/${bare}.thread`)
    const mapped = sidecar?.trim() ?? ''
    if (mapped !== '' && isValidThreadId(mapped)) return mapped
  } catch {
    // best-effort: fall through to the bare id
  }
  return bare
}

/**
 * Find the runAgent session id that owns a thread dir by scanning the
 * `<session>.thread` sidecars for one pointing at it. Returns null when
 * no session has recorded this thread yet (nothing ever ran there).
 * Used to resume a thread (`--resume <sessionId>`) without knowing which
 * session id the run minted — the forward map alone cannot answer that.
 */
export function resolveSessionForThread(root: string, threadId: string): string | null {
  const bare = threadId.endsWith('.json') ? threadId.slice(0, -5) : threadId
  if (!isValidThreadId(bare)) return null
  try {
    const base = createDiskVfs(root)
    if (!base.isDir(SESSIONS_DIR)) return null
    for (const name of base.readDir(SESSIONS_DIR)) {
      if (!name.endsWith('.thread')) continue
      if ((base.read(`${SESSIONS_DIR}/${name}`) ?? '').trim() !== bare) continue
      const sessionStem = name.slice(0, -'.thread'.length)
      if (isValidThreadId(sessionStem) && base.isFile(`${SESSIONS_DIR}/${sessionStem}.json`)) return sessionStem
    }
  } catch {
    // best-effort: callers treat null as "nothing to resume"
  }
  return null
}

/**
 * Record the session-id -> thread-id mapping for a fresh run (call from
 * runAgent's onSession). Best-effort: never fails the run. The sidecar sits
 * next to the session file but is not valid JSON-session data, so
 * listSessions/loadSession ignore it.
 */
export function noteThreadId(vfs: Vfs, sessionIdValue: string, threadId: string): void {
  try {
    const bareSession = sessionIdValue.endsWith('.json') ? sessionIdValue.slice(0, -5) : sessionIdValue
    const bareThread = threadId.endsWith('.json') ? threadId.slice(0, -5) : threadId
    if (!isValidThreadId(bareSession) || !isValidThreadId(bareThread)) return
    vfs.write(`${SESSIONS_DIR}/${bareSession}.thread`, `${bareThread}\n`)
  } catch {
    // the mapping is an optimization — the run must not fail over it
  }
}

/**
 * Resolve the run's cwd: default is the thread dir; an explicit request may
 * point at the thread dir or anywhere under it (absolute, ~-rooted, or
 * relative to the thread dir). Anything else is refused.
 */
export function resolveCwd(threadPath: string, requested: string | null | undefined): string {
  if (requested === null || requested === undefined || requested.trim() === '') return threadPath
  const raw = requested.trim()
  const normalized = raw === '~'
    ? '/home/user'
    : raw.startsWith('~/')
      ? vfsPath.normalize(`/home/user${raw.slice(1)}`)
      : raw.startsWith('/')
        ? vfsPath.normalize(raw)
        : vfsPath.join(threadPath, raw)
  if (normalized !== threadPath && !normalized.startsWith(`${threadPath}/`)) {
    throw new Error(`refused: cwd outside thread scope '${requested}'`)
  }
  return normalized
}
