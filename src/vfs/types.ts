/**
 * Cell VFS — the single source of truth for workspace files.
 *
 * Files are UTF-8 text or raw bytes (Uint8Array) — npm packages carry
 * binaries, and losing them is not an option. Text APIs (read/write) drive
 * the editor and typechecker; byte APIs (readBytes/writeBytes) drive the
 * shell, npm and git. All paths are absolute POSIX-style ('/src/index.ts'),
 * normalized: no '..', no '.', no trailing slash ('/' itself is the root).
 *
 * The API is synchronous in-memory; persistence is layered behind
 * VfsPersistence and flushed asynchronously by the host app.
 */

/** A whole-workspace image: text files as strings, binaries as bytes. */
export type VfsFileMap = Record<string, string | Uint8Array>

export interface VfsStat {
  type: 'file' | 'dir'
  size: number
  mtime: number
}

export type VfsEventKind = 'write' | 'mkdir' | 'delete' | 'rename'

export interface VfsEvent {
  kind: VfsEventKind
  path: string
  /** destination path, for kind === 'rename' */
  to?: string
}

export interface Vfs {
  exists(path: string): boolean
  isFile(path: string): boolean
  isDir(path: string): boolean
  isText(path: string): boolean
  stat(path: string): VfsStat | null

  /**
   * Text content of a file, or null when the path is missing or holds
   * binary data. Throws for a directory.
   */
  read(path: string): string | null
  /** Raw bytes: the stored bytes, or the text utf8-encoded. Null when missing. */
  readBytes(path: string): Uint8Array | null
  /** Immediate child names (not full paths) of a directory. [] for a file. */
  readDir(path: string): string[]

  /** Create or replace a text file; creates parent directories as needed. */
  write(path: string, content: string): void
  /** Create or replace a binary file; creates parent directories as needed. */
  writeBytes(path: string, content: Uint8Array): void
  mkdir(path: string): void
  /** Delete a file or a directory tree. No-op when missing. */
  delete(path: string): void
  /** Move/rename a file or directory (destination parents are created). */
  rename(from: string, to: string): void

  /** Every file path in the workspace, sorted. */
  listAllFiles(): string[]
  /** Full workspace: text as strings, binaries as bytes. */
  snapshot(): VfsFileMap
  /** Replace the whole workspace (files only; empties everything first). */
  restore(files: VfsFileMap): void

  /** Subscribe to mutations. Returns an unsubscribe function. */
  watch(cb: (e: VfsEvent) => void): () => void
}

/**
 * Pluggable persistence: IndexedDB today, content-addressed S3/R2 snapshots
 * in Phase 4. Implementations must tolerate being called concurrently.
 */
export interface VfsPersistence {
  load(): Promise<VfsFileMap | null>
  save(files: VfsFileMap): Promise<void>
}

/** Shared path helpers — every module must normalize through these. */
export const vfsPath = {
  normalize(p: string): string {
    const abs = p.startsWith('/') ? p : `/${p}`
    const parts: string[] = []
    for (const seg of abs.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return `/${parts.join('/')}`
  },
  join(dir: string, name: string): string {
    return this.normalize(`${dir}/${name}`)
  },
  dirname(p: string): string {
    const n = this.normalize(p)
    if (n === '/') return '/'
    const i = n.lastIndexOf('/')
    return i <= 0 ? '/' : n.slice(0, i)
  },
  basename(p: string): string {
    const n = this.normalize(p)
    if (n === '/') return '/'
    return n.slice(n.lastIndexOf('/') + 1)
  },
  ext(p: string): string {
    const b = this.basename(p)
    const i = b.lastIndexOf('.')
    return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
  },
}
