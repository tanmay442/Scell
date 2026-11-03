import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Vfs, VfsFileMap, VfsStat } from '../src/vfs/types'
import { vfsPath } from '../src/vfs/types'

/**
 * Disk-backed Vfs: VFS `/` maps to a real directory on the host.
 * Same semantics as the in-memory Vfs (text vs binary split on NUL,
 * same error strings) so the agent cannot tell the difference.
 *
 * There is no watcher here: the disk is the source of truth, so a
 * closed or crashed run loses nothing. watch() is a no-op.
 */

function hasNul(bytes: Uint8Array): boolean {
  const stop = Math.min(bytes.length, 8192)
  for (let i = 0; i < stop; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

export function createDiskVfs(root: string): Vfs {
  const base = resolve(root)
  mkdirSync(base, { recursive: true })
  // canonical base: the workspace root itself may sit under a symlinked
  // parent (/tmp -> /private/tmp on macOS), so containment is judged
  // against the resolved base, not the lexical one
  const baseReal = realpathSync(base)

  function real(path: string): string {
    const normalized = vfsPath.normalize(path)
    const full = resolve(join(base, normalized === '/' ? '' : normalized))
    // symlink-aware containment: resolve the deepest existing ancestor
    // (a `link` inside the root may point outside it) and re-attach the
    // missing tail before judging
    let existing = full
    const tail: string[] = []
    while (existing !== base && !existsSync(existing)) {
      tail.unshift(existing.slice(existing.lastIndexOf(sep) + 1))
      existing = existing.slice(0, existing.lastIndexOf(sep)) || sep
    }
    let resolved: string
    try {
      resolved = realpathSync(existing)
    } catch {
      throw new Error(`EINVAL: path escapes workspace '${path}'`)
    }
    const final = tail.length > 0 ? join(resolved, ...tail) : resolved
    if (final !== baseReal && !final.startsWith(`${baseReal}${sep}`)) {
      throw new Error(`EINVAL: path escapes workspace '${path}'`)
    }
    return full
  }

  function nodeAt(path: string): 'file' | 'dir' | null {
    try {
      const stat = statSync(real(path))
      return stat.isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  }

  function readRaw(path: string): Uint8Array | null {
    const kind = nodeAt(path)
    if (kind === null) return null
    if (kind === 'dir') throw new Error(`EISDIR: read of directory '${vfsPath.normalize(path)}'`)
    return new Uint8Array(readFileSync(real(path)))
  }

  const noop = () => {}

  return {
    exists(path) {
      return nodeAt(vfsPath.normalize(path)) !== null
    },
    isFile(path) {
      return nodeAt(vfsPath.normalize(path)) === 'file'
    },
    isDir(path) {
      return nodeAt(vfsPath.normalize(path)) === 'dir'
    },
    isText(path) {
      const raw = readRaw(path)
      return raw !== null && !hasNul(raw)
    },
    stat(path): VfsStat | null {
      const normalized = vfsPath.normalize(path)
      try {
        const stat = statSync(real(normalized))
        return stat.isDirectory()
          ? { type: 'dir', size: 0, mtime: stat.mtimeMs }
          : { type: 'file', size: stat.size, mtime: stat.mtimeMs }
      } catch {
        return null
      }
    },
    read(path) {
      const raw = readRaw(path)
      if (raw === null || hasNul(raw)) return null
      return Buffer.from(raw).toString('utf8')
    },
    readBytes(path) {
      return readRaw(path)
    },
    mkdir(path) {
      const normalized = vfsPath.normalize(path)
      mkdirSync(real(normalized), { recursive: true })
    },
    readDir(path) {
      const normalized = vfsPath.normalize(path)
      const kind = nodeAt(normalized)
      if (kind === null) throw new Error(`ENOENT: no such directory '${normalized}'`)
      if (kind !== 'dir') throw new Error(`ENOTDIR: not a directory '${normalized}'`)
      return readdirSync(real(normalized)).sort()
    },
    write(path, content) {
      const normalized = vfsPath.normalize(path)
      if (normalized === '/') throw new Error(`EISDIR: cannot write '/'`)
      if (nodeAt(normalized) === 'dir') throw new Error(`EISDIR: cannot write directory '${normalized}'`)
      const full = real(normalized)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    },
    writeBytes(path, content) {
      const normalized = vfsPath.normalize(path)
      if (normalized === '/') throw new Error(`EISDIR: cannot write '/'`)
      if (nodeAt(normalized) === 'dir') throw new Error(`EISDIR: cannot write directory '${normalized}'`)
      const full = real(normalized)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    },
    delete(path) {
      const normalized = vfsPath.normalize(path)
      if (normalized === '/') throw new Error(`EPERM: cannot delete '/'`)
      if (!existsSync(real(normalized))) return
      rmSync(real(normalized), { recursive: true, force: true })
    },
    rename(from, to) {
      const source = vfsPath.normalize(from)
      const dest = vfsPath.normalize(to)
      if (source === '/') throw new Error(`EPERM: cannot rename '/'`)
      if (nodeAt(source) === null) throw new Error(`ENOENT: no such path '${source}'`)
      if (nodeAt(dest) !== null) throw new Error(`EEXIST: destination exists '${dest}'`)
      const destFull = real(dest)
      mkdirSync(dirname(destFull), { recursive: true })
      renameSync(real(source), destFull)
    },
    listAllFiles() {
      const out: string[] = []
      const walk = (dir: string, prefix: string) => {
        let names: string[]
        try {
          names = readdirSync(dir).sort()
        } catch {
          return
        }
        for (const name of names) {
          const full = join(dir, name)
          const vpath = prefix === '/' ? `/${name}` : `${prefix}/${name}`
          try {
            if (statSync(full).isDirectory()) walk(full, vpath)
            else out.push(vpath)
          } catch {
            // raced deletion — skip
          }
        }
      }
      walk(base, '/')
      return out.sort()
    },
    snapshot() {
      const files: VfsFileMap = {}
      for (const path of this.listAllFiles()) {
        const raw = readRaw(path)
        if (raw === null) continue
        files[path] = hasNul(raw) ? raw : Buffer.from(raw).toString('utf8')
      }
      return files
    },
    restore(files) {
      for (const name of readdirSync(base)) {
        rmSync(join(base, name), { recursive: true, force: true })
      }
      for (const [path, content] of Object.entries(files)) {
        const normalized = vfsPath.normalize(path)
        const full = real(normalized)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content as string | Uint8Array)
      }
    },
    watch() {
      return noop
    },
  }
}

/** Canonical on-disk path of the workspace root itself (resolves a
 * symlinked parent such as /tmp on macOS). Falls back to the lexical
 * root when it cannot be resolved (e.g. not yet created). */
export function workspaceBaseReal(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

/** Canonical on-disk path for a VFS absolute path: the deepest existing
 * ancestor is resolved through symlinks (a planted link is followed to its
 * target) and the missing tail re-attached. Throws EINVAL when the
 * canonical location escapes the workspace root. Unlike real(), which only
 * checks, this returns the canonical path — spawn it, not the lexical one.
 * No filesystem writes happen here; callers mkdir after the check so a
 * `mkdir -p` can never create directories through an escaping link. */
export function canonicalRealPath(root: string, path: string): string {
  const normalized = vfsPath.normalize(path)
  const base = resolve(root)
  let baseReal: string
  try {
    baseReal = realpathSync(base)
  } catch {
    throw new Error(`EINVAL: path escapes workspace '${path}'`)
  }
  let existing = resolve(join(base, normalized === '/' ? '' : normalized.slice(1)))
  const tail: string[] = []
  while (existing !== base && !existsSync(existing)) {
    tail.unshift(existing.slice(existing.lastIndexOf(sep) + 1))
    existing = existing.slice(0, existing.lastIndexOf(sep)) || sep
  }
  let resolved: string
  try {
    resolved = realpathSync(existing)
  } catch {
    throw new Error(`EINVAL: path escapes workspace '${path}'`)
  }
  const final = tail.length > 0 ? join(resolved, ...tail) : resolved
  if (final !== baseReal && !final.startsWith(`${baseReal}${sep}`)) {
    throw new Error(`EINVAL: path escapes workspace '${path}'`)
  }
  return final
}

/** Resolve a VFS path to its real path under root (for shells, tools). */
export function vfsToReal(root: string, path: string): string {
  const normalized = vfsPath.normalize(path)
  return resolve(join(resolve(root), `.${normalized === '/' ? sep : normalized}`)) === resolve(root)
    ? resolve(root)
    : resolve(join(resolve(root), normalized.slice(1)))
}


