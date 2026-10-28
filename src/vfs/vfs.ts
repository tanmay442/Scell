import type { Vfs, VfsEvent, VfsFileMap } from './types'
import { vfsPath } from './types'

interface FileNode {
  type: 'file'
  content: string | Uint8Array
  mtime: number
}

interface DirNode {
  type: 'dir'
  mtime: number
  children: Map<string, Node>
}

type Node = FileNode | DirNode

function newDir(): DirNode {
  return { type: 'dir', mtime: Date.now(), children: new Map() }
}

function sizeOf(content: string | Uint8Array): number {
  return typeof content === 'string' ? content.length : content.byteLength
}

/** byte-exact compare: reference equality lies for Uint8Array (P1-3) */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameContent(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b
  if (a instanceof Uint8Array && b instanceof Uint8Array) return bytesEqual(a, b)
  return false
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * In-memory Vfs. Paths arrive normalized through vfsPath before touching the
 * tree. Mutation methods emit watch events; write() with unchanged content
 * stays silent so listeners (typechecker, autosave) don't spin.
 */
export function createVfs(initial?: VfsFileMap): Vfs {
  const root: DirNode = newDir()
  const watchers = new Set<(e: VfsEvent) => void>()

  if (initial) for (const [path, content] of Object.entries(initial)) {
    insertFile(vfsPath.normalize(path), content)
  }

  function emit(e: VfsEvent) {
    for (const w of watchers) w(e)
  }

  function nodeAt(path: string): Node | null {
    if (path === '/') return root
    let cur: Node = root
    for (const seg of path.slice(1).split('/')) {
      if (cur.type !== 'dir') return null
      const next: Node | undefined = cur.children.get(seg)
      if (!next) return null
      cur = next
    }
    return cur
  }

  function parentOf(path: string): DirNode | null {
    const parent = nodeAt(vfsPath.dirname(path))
    return parent && parent.type === 'dir' ? parent : null
  }

  function insertFile(path: string, content: string | Uint8Array) {
    const parent = ensureDir(vfsPath.dirname(path))
    parent.children.set(vfsPath.basename(path), { type: 'file', content, mtime: Date.now() })
  }

  function ensureDir(path: string): DirNode {
    let cur: DirNode = root
    if (path === '/') return cur
    for (const seg of path.slice(1).split('/')) {
      let next: Node | undefined = cur.children.get(seg)
      if (!next) {
        next = newDir()
        cur.children.set(seg, next)
      }
      if (next.type !== 'dir') {
        throw new Error(`not a directory: ${seg} under ${path}`)
      }
      cur = next
    }
    return cur
  }

  function collectFiles(node: Node, prefix: string, out: string[]) {
    if (node.type === 'file') {
      out.push(prefix)
      return
    }
    const names = [...node.children.keys()].sort()
    for (const name of names) {
      collectFiles(node.children.get(name)!, prefix === '/' ? `/${name}` : `${prefix}/${name}`, out)
    }
  }

  return {
    exists(path) {
      return nodeAt(vfsPath.normalize(path)) !== null
    },
    isFile(path) {
      return nodeAt(vfsPath.normalize(path))?.type === 'file'
    },
    isDir(path) {
      return nodeAt(vfsPath.normalize(path))?.type === 'dir'
    },
    isText(path) {
      const node = nodeAt(vfsPath.normalize(path))
      return node !== null && node.type === 'file' && typeof node.content === 'string'
    },
    stat(path) {
      const node = nodeAt(vfsPath.normalize(path))
      if (!node) return null
      return node.type === 'file'
        ? { type: 'file' as const, size: sizeOf(node.content), mtime: node.mtime }
        : { type: 'dir' as const, size: 0, mtime: node.mtime }
    },
    read(path) {
      const p = vfsPath.normalize(path)
      const node = nodeAt(p)
      if (!node) return null
      if (node.type !== 'file') throw new Error(`EISDIR: read of directory '${p}'`)
      // binary files read as null: callers decide (editor shows a placeholder,
      // the typechecker skips them, the shell uses readBytes)
      return typeof node.content === 'string' ? node.content : null
    },
    readBytes(path) {
      const p = vfsPath.normalize(path)
      const node = nodeAt(p)
      if (!node) return null
      if (node.type !== 'file') throw new Error(`EISDIR: read of directory '${p}'`)
      return typeof node.content === 'string' ? encoder.encode(node.content) : node.content
    },
    readDir(path) {
      const p = vfsPath.normalize(path)
      const node = nodeAt(p)
      if (!node) throw new Error(`ENOENT: no such directory '${p}'`)
      if (node.type !== 'dir') throw new Error(`ENOTDIR: not a directory '${p}'`)
      return [...node.children.keys()].sort()
    },
    write(path, content) {
      const p = vfsPath.normalize(path)
      if (p === '/') throw new Error(`EISDIR: cannot write '/'`)
      const existing = nodeAt(p)
      if (existing && existing.type === 'dir') throw new Error(`EISDIR: cannot write directory '${p}'`)
      if (existing && existing.type === 'file' && sameContent(existing.content, content)) return
      const parent = ensureDir(vfsPath.dirname(p))
      parent.children.set(vfsPath.basename(p), { type: 'file', content, mtime: Date.now() })
      emit({ kind: 'write', path: p })
    },
    writeBytes(path, content) {
      const p = vfsPath.normalize(path)
      if (p === '/') throw new Error(`EISDIR: cannot write '/'`)
      const existing = nodeAt(p)
      if (existing && existing.type === 'dir') throw new Error(`EISDIR: cannot write directory '${p}'`)
      if (existing && existing.type === 'file' && sameContent(existing.content, content)) return
      const parent = ensureDir(vfsPath.dirname(p))
      parent.children.set(vfsPath.basename(p), { type: 'file', content, mtime: Date.now() })
      emit({ kind: 'write', path: p })
    },
    mkdir(path) {
      const p = vfsPath.normalize(path)
      if (nodeAt(p)) return
      ensureDir(p)
      emit({ kind: 'mkdir', path: p })
    },
    delete(path) {
      const p = vfsPath.normalize(path)
      if (p === '/') throw new Error(`EPERM: cannot delete '/'`)
      const node = nodeAt(p)
      if (!node) return
      const parent = parentOf(p)
      if (!parent) throw new Error(`ENOENT: parent of '${p}'`)
      parent.children.delete(vfsPath.basename(p))
      emit({ kind: 'delete', path: p })
    },
    rename(from, to) {
      const f = vfsPath.normalize(from)
      const t = vfsPath.normalize(to)
      if (f === '/') throw new Error(`EPERM: cannot rename '/'`)
      if (!nodeAt(f)) throw new Error(`ENOENT: no such path '${f}'`)
      if (nodeAt(t)) throw new Error(`EEXIST: destination exists '${t}'`)
      if (t === f) return
      if (t.startsWith(`${f}/`)) throw new Error(`EINVAL: cannot move '${f}' into itself`)
      const srcParent = parentOf(f)
      if (!srcParent) throw new Error(`ENOENT: parent of '${f}'`)
      const node = srcParent.children.get(vfsPath.basename(f))!
      srcParent.children.delete(vfsPath.basename(f))
      const dstParent = ensureDir(vfsPath.dirname(t))
      dstParent.children.set(vfsPath.basename(t), node)
      node.mtime = Date.now()
      emit({ kind: 'rename', path: f, to: t })
    },
    listAllFiles() {
      const out: string[] = []
      collectFiles(root, '/', out)
      return out
    },
    snapshot() {
      const files: VfsFileMap = {}
      for (const path of this.listAllFiles()) {
        const node = nodeAt(path) as FileNode
        files[path] = node.content
      }
      return files
    },
    restore(files) {
      root.children.clear()
      for (const [path, content] of Object.entries(files)) {
        insertFile(vfsPath.normalize(path), content)
      }
      emit({ kind: 'write', path: '/' })
    },
    watch(cb) {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
  } satisfies Vfs
}

export { decoder as utf8Decoder }
