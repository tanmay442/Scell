import type { Vfs, VfsEvent, VfsStat } from './types'
import { vfsPath } from './types'

interface FileNode {
  type: 'file'
  content: string
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

/**
 * In-memory Vfs. Paths arrive normalized through vfsPath before touching the
 * tree. Mutation methods emit watch events; write() with unchanged content
 * stays silent so listeners (typechecker, autosave) don't spin.
 */
export function createVfs(initial?: Record<string, string>): Vfs {
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

  function insertFile(path: string, content: string) {
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
    stat(path) {
      const node = nodeAt(vfsPath.normalize(path))
      if (!node) return null
      return node.type === 'file'
        ? { type: 'file' as const, size: node.content.length, mtime: node.mtime }
        : { type: 'dir' as const, size: 0, mtime: node.mtime }
    },
    read(path) {
      const p = vfsPath.normalize(path)
      const node = nodeAt(p)
      if (!node) return null
      if (node.type !== 'file') throw new Error(`EISDIR: read of directory '${p}'`)
      return node.content
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
      if (existing && existing.type === 'file' && existing.content === content) return
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
      const files: Record<string, string> = {}
      for (const path of this.listAllFiles()) files[path] = (nodeAt(path) as FileNode).content
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

export type { VfsStat }
