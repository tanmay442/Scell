import type {
  ByteString,
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  FileContent,
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
} from 'just-bash'
import type { Vfs } from '../vfs/types'

interface ReadFileOptions {
  encoding?: BufferEncoding | null
}

interface WriteFileOptions {
  encoding?: BufferEncoding
}

const FILE_MODE = 0o644
const DIR_MODE = 0o755

/**
 * Paths that live in the volatile system zone instead of the VFS: temp
 * files and device nodes have no business surviving a reload.
 */
const SYS_PREFIXES = ['/tmp', '/dev', '/proc', '/etc', '/var', '/usr', '/bin', '/lib', '/opt', '/srv', '/mnt', '/media', '/run', '/sys', '/root']

interface Dirent {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

function normalize(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

function decode(content: FileContent): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

function toByteString(text: string): string {
  // ByteString is latin1-shaped: one char per byte.
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

type Zone = { zone: 'vfs'; vpath: string } | { zone: 'sys'; spath: string } | { zone: 'devnull' }

/**
 * just-bash IFileSystem over the Cell Vfs with identity mapping: bash paths
 * ARE VFS paths (a real user machine — /home/user is HOME and lives in the
 * VFS; /tmp & friends are volatile sidecar state). Symlinks and mode bits
 * live in sidecar maps — the Vfs itself stays content-only.
 */
export class VfsBackedFs implements IFileSystem {
  private sysDirs = new Set<string>(['/', '/tmp', '/dev', '/dev/null', '/proc', '/etc', '/home'])
  private sysFiles = new Map<string, string>()
  private symlinks = new Map<string, string>()
  private modes = new Map<string, number>()
  private mtimes = new Map<string, Date>()

  constructor(private vfs: Vfs) {}

  private locate(rawPath: string): Zone {
    const p = normalize(rawPath)
    if (p === '/dev/null') return { zone: 'devnull' }
    if (SYS_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
      return { zone: 'sys', spath: p }
    }
    return { zone: 'vfs', vpath: p }
  }

  private followSymlink(p: string, depth = 0): string {
    let cur = normalize(p)
    for (let i = 0; i < 10; i++) {
      const target = this.symlinks.get(cur)
      if (target === undefined) return cur
      cur = target.startsWith('/') ? normalize(target) : normalize(`${normalize(cur)}/../${target}`)
    }
    return cur
  }

  private sysGet(path: string): { type: 'dir' } | { type: 'file'; content: string } | null {
    const p = normalize(path)
    if (this.sysFiles.has(p)) return { type: 'file', content: this.sysFiles.get(p)! }
    if (this.sysDirs.has(p)) return { type: 'dir' }
    return null
  }

  private sysEnsureParents(path: string) {
    const parts = normalize(path).slice(1).split('/').filter(Boolean)
    let cur = ''
    for (const seg of parts.slice(0, -1)) {
      cur += `/${seg}`
      this.sysDirs.add(cur)
    }
  }

  private sysChildren(path: string): Dirent[] {
    const p = normalize(path)
    const prefix = p === '/' ? '/' : `${p}/`
    const names = new Set<string>()
    for (const dir of this.sysDirs) {
      if (dir.startsWith(prefix) && dir !== p) {
        const rest = dir.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
    }
    for (const file of this.sysFiles.keys()) {
      if (file.startsWith(prefix)) {
        const rest = file.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
    }
    for (const link of this.symlinks.keys()) {
      if (link.startsWith(prefix)) {
        const rest = link.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
    }
    return [...names].sort().map((name) => {
      const child = `${prefix}${name}`
      return {
        name,
        isFile: this.sysFiles.has(child) || this.vfsZoneFile(child),
        isDirectory: this.sysDirs.has(child) || this.vfsZoneDir(child),
        isSymbolicLink: this.symlinks.has(child),
      }
    })
  }

  private vfsZoneFile(bashPath: string): boolean {
    const z = this.locate(bashPath)
    return z.zone === 'vfs' && this.vfs.isFile(z.vpath)
  }

  private vfsZoneDir(bashPath: string): boolean {
    const z = this.locate(bashPath)
    return z.zone === 'vfs' && this.vfs.isDir(z.vpath)
  }

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'devnull') return ''
    if (z.zone === 'vfs') {
      const bytes = this.vfs.readBytes(z.vpath)
      if (bytes === null) throw new Error(`ENOENT: no such file '${path}'`)
      // `cat` on a binary prints something; lossy utf8 is the honest terminal behavior
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    }
    const entry = this.sysGet(z.spath)
    if (!entry) throw new Error(`ENOENT: no such file '${path}'`)
    if (entry.type === 'dir') throw new Error(`EISDIR: read of directory '${path}'`)
    return entry.content
  }

  async readFileBytes(path: string): Promise<ByteString> {
    return toByteString(new TextDecoder('latin1').decode(await this.readFileBuffer(path))) as unknown as ByteString
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'devnull') return new Uint8Array(0)
    if (z.zone === 'vfs') {
      const bytes = this.vfs.readBytes(z.vpath)
      if (bytes === null) throw new Error(`ENOENT: no such file '${path}'`)
      return bytes
    }
    const entry = this.sysGet(z.spath)
    if (!entry) throw new Error(`ENOENT: no such file '${path}'`)
    if (entry.type === 'dir') throw new Error(`EISDIR: read of directory '${path}'`)
    return new TextEncoder().encode(entry.content)
  }

  async writeFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const z = this.locate(path)
    if (z.zone === 'devnull') return
    if (z.zone === 'vfs') {
      // bytes go in as bytes — package tarballs must round-trip exactly
      if (typeof content === 'string') this.vfs.write(z.vpath, content)
      else this.vfs.writeBytes(z.vpath, content)
    } else {
      this.sysEnsureParents(z.spath)
      this.sysFiles.set(z.spath, typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: false }).decode(content))
      this.sysDirs.delete(z.spath)
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    let existing = ''
    try {
      existing = await this.readFile(path)
    } catch {
      // appending creates the file
    }
    await this.writeFile(path, existing + decode(content), options)
  }

  async exists(path: string): Promise<boolean> {
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'devnull') return true
    if (z.zone === 'vfs') return this.vfs.exists(z.vpath)
    return this.sysGet(z.spath) !== null
  }

  async stat(path: string): Promise<FsStat> {
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'devnull') {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o666, size: 0, mtime: new Date() }
    }
    if (z.zone === 'vfs') {
      const s = this.vfs.stat(z.vpath)
      if (!s) throw new Error(`ENOENT: no such file or directory '${path}'`)
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'dir',
        isSymbolicLink: false,
        mode: this.modes.get(normalize(path)) ?? (s.type === 'file' ? FILE_MODE : DIR_MODE),
        size: s.size,
        mtime: this.mtimes.get(normalize(path)) ?? new Date(s.mtime),
      }
    }
    const entry = this.sysGet(z.spath)
    if (!entry) throw new Error(`ENOENT: no such file or directory '${path}'`)
    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'dir',
      isSymbolicLink: false,
      mode: this.modes.get(z.spath) ?? (entry.type === 'file' ? FILE_MODE : DIR_MODE),
      size: entry.type === 'file' ? entry.content.length : 0,
      mtime: this.mtimes.get(z.spath) ?? new Date(),
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const z = this.locate(path)
    if (z.zone === 'vfs') {
      if (!options?.recursive && !this.vfs.isDir(this.parentOf(z.vpath))) {
        throw new Error(`ENOENT: no such directory '${path}'`)
      }
      this.vfs.mkdir(z.vpath)
      return
    }
    if (z.zone === 'devnull') throw new Error(`EEXIST: '${path}'`)
    const parent = this.parentOf(z.spath)
    if (!options?.recursive && !this.sysDirs.has(parent)) {
      throw new Error(`ENOENT: no such directory '${path}'`)
    }
    this.sysEnsureParents(z.spath)
    this.sysDirs.add(z.spath)
  }

  private parentOf(path: string): string {
    const p = normalize(path)
    const i = p.lastIndexOf('/')
    return i <= 0 ? '/' : p.slice(0, i)
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    if (await this.exists(path)) throw new Error(`EEXIST: '${path}' already exists`)
    if (options.directory) {
      await this.mkdir(path, { recursive: true })
    } else {
      await this.writeFile(path, '')
    }
    this.modes.set(normalize(path), options.mode)
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name)
  }

  async readdirWithFileTypes(path: string): Promise<Dirent[]> {
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'vfs') {
      if (!this.vfs.isDir(z.vpath)) throw new Error(`ENOTDIR: not a directory '${path}'`)
      const names = this.vfs.readDir(z.vpath)
      return names.map((name) => ({
        name,
        isFile: this.vfs.isFile(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
        isDirectory: this.vfs.isDir(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
        isSymbolicLink: this.symlinks.has(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
      }))
    }
    if (z.zone === 'devnull') throw new Error(`ENOTDIR: not a directory '${path}'`)
    if (!this.sysDirs.has(z.spath)) throw new Error(`ENOTDIR: not a directory '${path}'`)
    return this.sysChildren(z.spath)
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const z = this.locate(path)
    if (z.zone === 'devnull') return
    if (!(await this.exists(path))) {
      if (options?.force) return
      throw new Error(`ENOENT: no such file or directory '${path}'`)
    }
    if (z.zone === 'vfs') {
      const stat = this.vfs.stat(z.vpath)
      if (stat?.type === 'dir' && this.vfs.readDir(z.vpath).length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty '${path}'`)
      }
      this.vfs.delete(z.vpath)
      return
    }
    const p = normalize(z.spath)
    this.sysFiles.delete(p)
    this.sysDirs.delete(p)
    if (options?.recursive) {
      const prefix = p === '/' ? '/' : `${p}/`
      for (const path2 of [...this.sysDirs]) if (path2.startsWith(prefix)) this.sysDirs.delete(path2)
      for (const path2 of [...this.sysFiles.keys()]) if (path2.startsWith(prefix)) this.sysFiles.delete(path2)
      for (const path2 of [...this.symlinks.keys()]) if (path2.startsWith(prefix)) this.symlinks.delete(path2)
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcStat = await this.stat(src)
    if (srcStat.isFile) {
      await this.writeFile(dest, await this.readFileBuffer(src))
      return
    }
    if (!options?.recursive) throw new Error(`EISDIR: cannot copy directory '${src}' without -r`)
    await this.mkdir(dest, { recursive: true })
    for (const entry of await this.readdirWithFileTypes(src)) {
      await this.cp(`${src}/${entry.name}`, `${dest}/${entry.name}`, { recursive: true })
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    if (!(await this.exists(src))) throw new Error(`ENOENT: no such file or directory '${src}'`)
    if (await this.exists(dest)) await this.rm(dest, { recursive: true })
    const zSrc = this.locate(src)
    const zDest = this.locate(dest)
    if (zSrc.zone === 'vfs' && zDest.zone === 'vfs') {
      this.vfs.rename(zSrc.vpath, zDest.vpath)
      return
    }
    await this.cp(src, dest, { recursive: true })
    await this.rm(src, { recursive: true })
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalize(path)
    if (path.startsWith('~')) return normalize(path.slice(1))
    return normalize(`${base}/${path}`)
  }

  getAllPaths(): string[] {
    const paths = this.vfs.listAllFiles()
    paths.push(...this.sysFiles.keys())
    paths.push(...this.symlinks.keys())
    return paths
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!(await this.exists(path))) throw new Error(`ENOENT: no such file or directory '${path}'`)
    this.modes.set(normalize(path), mode)
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (await this.exists(linkPath)) throw new Error(`EEXIST: '${linkPath}' already exists`)
    this.sysEnsureParents(linkPath)
    this.symlinks.set(normalize(linkPath), target)
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    if (!(await this.exists(existingPath))) throw new Error(`ENOENT: no such file '${existingPath}'`)
    if (await this.exists(newPath)) throw new Error(`EEXIST: '${newPath}' already exists`)
    // On a text VFS a hard link is a copy; content stays identical on write
    // through the copy-on-write semantics of the shell's own conventions.
    await this.writeFile(newPath, await this.readFileBuffer(existingPath))
  }

  async readlink(path: string): Promise<string> {
    const target = this.symlinks.get(normalize(path))
    if (target === undefined) throw new Error(`EINVAL: not a symlink '${path}'`)
    return target
  }

  async lstat(path: string): Promise<FsStat> {
    const p = normalize(path)
    const target = this.symlinks.get(p)
    if (target !== undefined) {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: 0o777,
        size: target.length,
        mtime: this.mtimes.get(p) ?? new Date(),
      }
    }
    return this.stat(path)
  }

  async realpath(path: string): Promise<string> {
    const resolved = this.followSymlink(path)
    if (!(await this.exists(resolved))) throw new Error(`ENOENT: broken symlink in '${path}'`)
    return resolved
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    if (!(await this.exists(path))) throw new Error(`ENOENT: no such file or directory '${path}'`)
    this.mtimes.set(normalize(path), mtime)
  }
}
