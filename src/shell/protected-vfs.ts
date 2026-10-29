import type { Vfs, VfsFileMap } from '../vfs/types'
import { vfsPath } from '../vfs/types'
import { PROTECTED_PREFIX, isProtectedPath, isProtectedChild, isWriteProtectedPath } from '../vfs/protected-paths'

/**
 * Capability wrapper: a Vfs that cannot see or touch ~/.cell.
 *
 * Agent shells are built on this (createShell { protected: true }); the
 * human terminal and the harness itself keep the raw Vfs. Enforcement
 * sits here — below bash, node, python, git, npm — so path spelling
 * (variables, globs, symlinks, cwd tricks, script files) no longer
 * matters: by the time any consumer resolves a path, it lands here.
 *
 * Semantics are chosen so unaware consumers keep working:
 * - Reads of protected files look exactly like "missing" (read →
 *   null, exists → false, stat → null). Snapshot iteration in the node
 *   and python runners reads every file; a throwing read would break
 *   every run, a missing-looking one just skips the file.
 * - Listings filter protected children out (including `.cell` itself
 *   in /home/user), so enumeration cannot confirm what exists.
 * - Writes/mutations on protected paths throw EACCES: a silent
 *   no-op write would let a script believe it persisted state it did
 *   not. Rename is refused when either side is protected.
 * - restore() throws: a full-tree replace from a protected context
 *   would delete the real ~/.cell on the raw side even with entries
 *   filtered out. `cell load` is additionally gated in cell-cmd.
 */
export function wrapProtectedVfs(raw: Vfs): Vfs {
  const normalized = (path: string) => vfsPath.normalize(path)
  const eacces = (path: string): Error => Object.assign(new Error(`EACCES: protected path ${path}`), { code: 'EACCES' })

  const guardWrite = (path: string): void => {
    const p = normalized(path)
    if (isProtectedPath(p) || isWriteProtectedPath(p)) throw eacces(p)
  }

  const wrapped: Vfs = {
    exists: (path) => !isProtectedPath(normalized(path)) && raw.exists(path),
    isFile: (path) => !isProtectedPath(normalized(path)) && raw.isFile(path),
    isDir: (path) => !isProtectedPath(normalized(path)) && raw.isDir(path),
    isText: (path) => !isProtectedPath(normalized(path)) && raw.isText(path),
    stat: (path) => (isProtectedPath(normalized(path)) ? null : raw.stat(path)),
    read: (path) => (isProtectedPath(normalized(path)) ? null : raw.read(path)),
    readBytes: (path) => (isProtectedPath(normalized(path)) ? null : raw.readBytes(path)),
    readDir: (path) => {
      const dir = normalized(path)
      if (isProtectedPath(dir)) return []
      return raw.readDir(path).filter((name) => !isProtectedChild(dir, name))
    },
    write: (path, content) => { guardWrite(path); raw.write(path, content) },
    writeBytes: (path, content) => { guardWrite(path); raw.writeBytes(path, content) },
    mkdir: (path) => { guardWrite(path); raw.mkdir(path) },
    delete: (path) => { guardWrite(path); raw.delete(path) },
    rename: (from, to) => { guardWrite(from); guardWrite(to); raw.rename(from, to) },
    listAllFiles: () => raw.listAllFiles().filter((path) => !isProtectedPath(normalized(path))),
    snapshot: () => {
      const all = raw.snapshot()
      const out: VfsFileMap = {}
      for (const [path, content] of Object.entries(all)) {
        if (!isProtectedPath(normalized(path))) out[path] = content
      }
      return out
    },
    restore: () => { throw eacces(PROTECTED_PREFIX) },
    watch: (cb) => raw.watch((event) => {
      if (isProtectedPath(normalized(event.path))) return
      if (event.to !== undefined && isProtectedPath(normalized(event.to))) return
      cb(event)
    }),
  }
  // marker so VfsBackedFs can find the raw Vfs (sidecar persistence)
  // and know this shell is protected, without call-site plumbing
  ;(wrapped as unknown as { __cellRawVfs: Vfs }).__cellRawVfs = raw
  return wrapped
}
