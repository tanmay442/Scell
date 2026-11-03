import type { Vfs, VfsFileMap, VfsStat } from './types'
import { vfsPath } from './types'

/**
 * Capability-scoped Vfs: a chroot-style view that exposes only the paths a
 * single run may touch. Every method takes the same absolute VFS paths the
 * agent already uses; a path resolves under the scope root `dir` (or under
 * one of the `mounts` below) or it fails. There is no way to name anything
 * else: `..` and absolute escapes are rejected before touching the backing
 * Vfs, so confinement holds by construction, not by deny-list.
 *
 * The exact boundary for one agent run (see server/bindings.ts):
 *   scope root  /home/user/threads/<threadId>   read/write — the run's own files
 *   mount       /home/user/.cell -> itself      read/write — agent config,
 *     sessions, skills/tools/commands registries, job logs (runAgent needs
 *     all of these to function; agent-initiated tool access to them stays
 *     refused by the deny lists in src/shell/commands/agent-tools.ts, so the
 *     mount preserves runAgent-internal access, not agent access)
 * Everything else in the workspace — other threads, other projects — is
 * unreachable through this view.
 *
 * Escape semantics (fail closed, two tiers):
 *   - Presence probes (exists/isFile/isDir) return false outside the grant.
 *     They reveal nothing and, critically, they keep runAgent's
 *     climb-and-probe patterns working unchanged (projectRoot walks parents
 *     looking for package.json; registry loaders guard on isDir) — the climb
 *     just reads "absent" past the scope edge instead of throwing.
 *   - Everything that reveals or mutates data (read, readBytes, isText,
 *     stat, readDir, write, writeBytes, mkdir, delete, rename) throws
 *     `EINVAL: outside capability scope '<path>'` outside the grant.
 *   - listAllFiles covers the scope plus mounts (under their scoped names)
 *     so git discovery, python payloads and skill registries keep working;
 *     snapshot covers the scope root only, with scope-relative keys (no
 *     leading slash, e.g. 'artifacts/chart.html'); restore accepts
 *     scope-relative keys, rejects absolute or `..`-escaping keys, and
 *     replaces only the scope contents.
 *   - watch forwards underlying events that fall inside the grant,
 *     translated back to scoped paths; events outside the grant are dropped.
 *   - The scope root itself cannot be deleted or renamed away (EPERM);
 *     everything under it can.
 *
 * Symlinks: with the `resolveReal` hook (wired for disk backings in
 * server/bindings.ts), confinement is readlink-aware: a symlink planted
 * inside the grant that points elsewhere in the workspace canonicalizes
 * outside the grant and is refused. Without the hook confinement is
 * lexical (backings that cannot express symlinks, like the in-memory Vfs,
 * need nothing more). Plain bash is unaffected either way — see the shell
 * honesty note in server/bindings.ts.
 */

function under(root: string, path: string): boolean {
  if (root === '/') return path.startsWith('/')
  return path === root || path.startsWith(`${root}/`)
}

/** Typed refusal for paths outside the grant: runTool matches on the
 * class (not the message) so hostile paths cannot break the matcher. */
export class ScopeError extends Error {
  path: string
  constructor(path: string) {
    super(`EINVAL: outside capability scope '${path}'`)
    this.name = 'ScopeError'
    this.path = path
  }
}

function outsideScope(path: string): ScopeError {
  return new ScopeError(path)
}

export interface ScopeOptions {
  /** Canonicalize a backing absolute path (following symlinks) back to a
   * backing absolute path, or null when it cannot be resolved. Without it
   * confinement is lexical: a symlink planted inside the grant that points
   * elsewhere in the workspace would be followed (disk-vfs's own workspace
   * check still holds, but the cross-thread boundary would not). Backings
   * that cannot express symlinks (the in-memory Vfs) need no hook. */
  resolveReal?: (backingAbsPath: string) => string | null
}

export function scopeVfs(vfs: Vfs, dir: string, mounts?: Record<string, string>, opts?: ScopeOptions): Vfs {
  const scopeRoot = vfsPath.normalize(dir)
  // longest scoped prefix wins, so nested mounts resolve deterministically
  const mountList = Object.entries(mounts ?? {})
    .map(([from, to]) => ({ from: vfsPath.normalize(from), to: vfsPath.normalize(to) }))
    .sort((a, b) => b.from.length - a.from.length)

  const canonScopeRoot = canonicalize(scopeRoot)
  const canonMounts = mountList.map((mount) => ({ ...mount, canonTo: canonicalize(mount.to) }))

  /** Best-effort canonical form of a backing path; lexical on failure. */
  function canonicalize(backingAbsPath: string): string {
    if (opts?.resolveReal === undefined) return backingAbsPath
    try {
      return opts.resolveReal(backingAbsPath) ?? backingAbsPath
    } catch {
      // unresolvable paths fail closed at the grant check below
      return `\0unresolvable\0${backingAbsPath}`
    }
  }

  /** Underlying absolute path for a scoped path, or null outside the grant. */
  function resolve(path: string): string | null {
    const normalized = vfsPath.normalize(path)
    const grant = under(scopeRoot, normalized)
      ? scopeRoot
      : canonMounts.find((mount) => under(mount.from, normalized))?.from ?? null
    if (grant === null) return null
    const mapped = grant === scopeRoot
      ? normalized
      : canonMounts.find((mount) => mount.from === grant)!.to + normalized.slice(grant.length)
    // the mapped path must still be inside the grant after symlinks resolve
    const canonGrant = grant === scopeRoot ? canonScopeRoot : canonMounts.find((mount) => mount.from === grant)!.canonTo
    if (!under(canonGrant, canonicalize(mapped))) return null
    return mapped
  }

  function need(path: string): string {
    const real = resolve(path)
    if (real === null) throw outsideScope(path)
    return real
  }

  /** Map an underlying absolute path back to its scoped path, or null. */
  function scopedEvent(path: string): string | null {
    const normalized = vfsPath.normalize(path)
    if (under(scopeRoot, normalized)) return normalized
    for (const mount of mountList) {
      if (under(mount.to, normalized)) return mount.from + normalized.slice(mount.to.length)
    }
    return null
  }

  const scopePrefix = scopeRoot === '/' ? '/' : `${scopeRoot}/`

  return {
    exists(path) {
      const real = resolve(path)
      return real === null ? false : vfs.exists(real)
    },
    isFile(path) {
      const real = resolve(path)
      return real === null ? false : vfs.isFile(real)
    },
    isDir(path) {
      const real = resolve(path)
      return real === null ? false : vfs.isDir(real)
    },
    isText(path) {
      return vfs.isText(need(path))
    },
    stat(path): VfsStat | null {
      return vfs.stat(need(path))
    },
    read(path) {
      return vfs.read(need(path))
    },
    readBytes(path) {
      return vfs.readBytes(need(path))
    },
    readDir(path) {
      return vfs.readDir(need(path))
    },
    write(path, content) {
      vfs.write(need(path), content)
    },
    writeBytes(path, content) {
      vfs.writeBytes(need(path), content)
    },
    mkdir(path) {
      vfs.mkdir(need(path))
    },
    delete(path) {
      if (vfsPath.normalize(path) === scopeRoot) {
        throw new Error(`EPERM: cannot delete capability root '${scopeRoot}'`)
      }
      vfs.delete(need(path))
    },
    rename(from, to) {
      if (vfsPath.normalize(from) === scopeRoot) {
        throw new Error(`EPERM: cannot rename capability root '${scopeRoot}'`)
      }
      vfs.rename(need(from), need(to))
    },
    listAllFiles() {
      // underlying order is sorted; mapping preserves it (deduped: a
      // backing path can surface only under one scoped name)
      // mounts ARE included: git discovery, python payloads and skill
      // registries all enumerate through here, and mounts are granted
      const seen = new Set<string>()
      const out: string[] = []
      for (const backing of vfs.listAllFiles()) {
        const scoped = scopedEvent(backing)
        if (scoped === null || seen.has(scoped)) continue
        seen.add(scoped)
        out.push(scoped)
      }
      return out
    },
    snapshot() {
      const out: VfsFileMap = {}
      for (const [key, value] of Object.entries(vfs.snapshot())) {
        const normalized = vfsPath.normalize(key)
        if (normalized.startsWith(scopePrefix)) out[normalized.slice(scopePrefix.length)] = value
      }
      return out
    },
    restore(files) {
      // validate every key before touching anything: all-or-nothing
      const writes: Array<[string, string | Uint8Array]> = []
      for (const [key, content] of Object.entries(files)) {
        if (key.startsWith('/')) {
          throw new Error(`EINVAL: restore keys are scope-relative, got '${key}'`)
        }
        const joined = vfsPath.normalize(`${scopeRoot}/${key}`)
        if (!under(scopeRoot, joined) || joined === scopeRoot) {
          throw new Error(`EINVAL: restore key escapes capability scope '${key}'`)
        }
        writes.push([joined, content])
      }
      // wipe the scope contents only — mounts and the rest of the
      // workspace are untouched (missing scope root counts as empty)
      let children: string[] = []
      try {
        children = vfs.readDir(scopeRoot)
      } catch {
        children = []
      }
      for (const name of children) vfs.delete(vfsPath.join(scopeRoot, name))
      for (const [joined, content] of writes) {
        if (typeof content === 'string') vfs.write(joined, content)
        else vfs.writeBytes(joined, content)
      }
    },
    watch(cb) {
      return vfs.watch((event) => {
        const path = scopedEvent(event.path)
        if (path === null) return
        if (event.kind === 'rename') {
          if (event.to === undefined) return
          const to = scopedEvent(event.to)
          // a rename that lands outside the grant is not representable in
          // the scoped view — drop it rather than leak the target path
          if (to === null) return
          cb({ kind: event.kind, path, to })
        } else {
          cb({ kind: event.kind, path })
        }
      })
    },
  }
}
