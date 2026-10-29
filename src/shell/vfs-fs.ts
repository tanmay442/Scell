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
const FS_META_PATH = '/home/user/.cell/fs-meta.json'

interface SharedSidecar {
  symlinks: Map<string, string>
  modes: Map<string, number>
  save(): void
  prune(path: string): void
  remap(from: string, to: string): void
}

const sidecarStores = new WeakMap<Vfs, SharedSidecar>()

const isSysPath = (p: string): boolean => SYS_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))

/**
 * One sidecar per raw Vfs, shared by every VfsBackedFs built on it,
 * persisted as an ordinary file (~/.cell/fs-meta.json) so autosave and
 * cell save carry it with no schema change. Absent/corrupt file = empty
 * sidecar = today's defaults. Only non-sys entries persist (sys zone is
 * per-boot). VFS delete/rename events prune/remap entries so editor-side
 * changes cannot leave stale modes on recreated files.
 */
function sidecarFor(metaVfs: Vfs): SharedSidecar {
  const existing = sidecarStores.get(metaVfs)
  if (existing) return existing
  const symlinks = new Map<string, string>()
  const modes = new Map<string, number>()
  try {
    const raw = metaVfs.read(FS_META_PATH)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { symlinks?: Record<string, string>; modes?: Record<string, number> }
      for (const [path, target] of Object.entries(parsed.symlinks ?? {})) symlinks.set(path, target)
      for (const [path, mode] of Object.entries(parsed.modes ?? {})) if (typeof mode === 'number') modes.set(path, mode)
    }
  } catch {
    // corrupt meta file: fail soft to an empty sidecar
  }
  const store: SharedSidecar = {
    symlinks,
    modes,
    save() {
      try {
        const keptLinks = Object.fromEntries([...symlinks].filter(([path]) => !isSysPath(path)))
        const keptModes = Object.fromEntries([...modes].filter(([path]) => !isSysPath(path)))
        metaVfs.write(FS_META_PATH, `${JSON.stringify({ symlinks: keptLinks, modes: keptModes }, null, 2)}\n`)
      } catch {
        // persistence is best-effort; in-memory state still shared
      }
    },
    prune(path: string) {
      let changed = false
      for (const key of [...symlinks.keys()]) if (key === path || key.startsWith(`${path}/`)) { symlinks.delete(key); changed = true }
      for (const key of [...modes.keys()]) if (key === path || key.startsWith(`${path}/`)) { modes.delete(key); changed = true }
      if (changed) store.save()
    },
    remap(from: string, to: string) {
      let changed = false
      for (const [key, target] of [...symlinks]) {
        if (key === from || key.startsWith(`${from}/`)) {
          symlinks.delete(key)
          symlinks.set(to + key.slice(from.length), target)
          changed = true
        }
      }
      for (const [key, mode] of [...modes]) {
        if (key === from || key.startsWith(`${from}/`)) {
          modes.delete(key)
          modes.set(to + key.slice(from.length), mode)
          changed = true
        }
      }
      if (changed) store.save()
    },
  }
  metaVfs.watch((event) => {
    if (event.path === FS_META_PATH) return
    if (event.kind === 'delete') store.prune(event.path)
    if (event.kind === 'rename' && event.to !== undefined) store.remap(event.path, event.to)
  })
  sidecarStores.set(metaVfs, store)
  return store
}

export class VfsBackedFs implements IFileSystem {
  private sysDirs = new Set<string>(['/', '/tmp', '/dev', '/dev/null', '/proc', '/etc', '/home'])
  private sysFiles = new Map<string, string>([
    // system identity: agents (and packages) read these to place themselves
    ['/etc/os-release', [
      'PRETTY_NAME="Cell Linux 1.0 (x86_64)"',
      'NAME="Cell Linux"',
      'VERSION_ID="1.0"',
      'VERSION="1.0 (x86_64)"',
      'VERSION_CODENAME=cell',
      'ID=cell',
      'ID_LIKE=debian',
      'HOME_URL="https://cell.local"',
      'SUPPORT_URL="https://cell.local/support"',
      'BUG_REPORT_URL="https://cell.local/bugs"',
      '',
    ].join('\n')],
    ['/etc/hostname', 'cell\n'],
    ['/etc/hosts', '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost\n'],
    ['/etc/passwd', 'root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:user:/home/user:/bin/bash\n'],
    ['/etc/group', 'root:x:0:\nuser:x:1000:\nsudo:x:27:user\ndocker:x:999:user\n'],
    ['/etc/resolv.conf', 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n'],
    ['/proc/version', 'Linux version 6.8.0-cell (cell@cell) (gcc 13.2.0) #1 SMP PREEMPT_DYNAMIC\n'],
    ['/proc/loadavg', '0.31 0.24 0.19 1/412 8301\n'],
    ['/proc/self/cmdline', '/bin/bash\n'],
    ['/proc/1/cmdline', '/bin/bash\n'],
    ['/proc/mounts', '/dev/sda1 / ext4 rw,relatime 0 0\nproc /proc proc rw,nosuid,nodev,noexec 0 0\ntmpfs /run tmpfs rw,nosuid 0 0\n'],
    ['/proc/1/cgroup', '0::/init\n'],
    ['/sys/fs/cgroup/memory.max', '17179869184\n'],
    ['/etc/debian_version', '12.7\n'],
    ['/etc/issue', 'Cell Linux 1.0 \\n \\l\n\n'],

    ['/proc/uptime', '8640.00 31200.00\n'],
    ['/proc/meminfo', [
      'MemTotal:       16254912 kB',
      'MemFree:         4202496 kB',
      'MemAvailable:    9433088 kB',
      'Buffers:          512000 kB',
      'Cached:          5690368 kB',
      'SwapTotal:       2097152 kB',
      'SwapFree:        2097152 kB',
      '',
    ].join('\n')],
    ['/proc/cpuinfo', [
      'processor\t: 0',
      'vendor_id\t: CellV8',
      'model name\t: Virtual V8 Isolate @ 3.2GHz',
      'flags\t\t: fpu sse sse2 avx2',
      '',
      'processor\t: 1',
      'vendor_id\t: CellV8',
      'model name\t: Virtual V8 Isolate @ 3.2GHz',
      'flags\t\t: fpu sse sse2 avx2',
      '',
    ].join('\n')],
  ])
  private mtimes = new Map<string, Date>()
  private sidecar: SharedSidecar

  constructor(private vfs: Vfs, metaVfs?: Vfs) {
    // symlink/mode state is shared by every shell on the same Vfs and
    // persisted to ~/.cell/fs-meta.json (see sidecarFor) — a chmod in
    // the terminal is visible to an agent-panel run, and both survive
    // reload. metaVfs is the raw Vfs for that persistence file (a
    // protected shell's wrapped Vfs cannot write under ~/.cell).
    this.sidecar = sidecarFor(metaVfs ?? vfs)
  }

  private get symlinks(): Map<string, string> {
    return this.sidecar.symlinks
  }

  private get modes(): Map<string, number> {
    return this.sidecar.modes
  }

  private locate(rawPath: string): Zone {
    const p = normalize(rawPath)
    if (p === '/dev/null') return { zone: 'devnull' }
    if (SYS_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
      return { zone: 'sys', spath: p }
    }
    return { zone: 'vfs', vpath: p }
  }

  private followSymlink(p: string, depth = 0): string {
    void depth
    let cur = normalize(p)
    for (let i = 0; i < 10; i++) {
      const target = this.symlinks.get(cur)
      if (target !== undefined) {
        cur = target.startsWith('/') ? normalize(target) : normalize(`${normalize(cur)}/../${target}`)
        continue
      }
      // resolve through a parent link: /link/sub/file sees /link -> target
      const slash = cur.lastIndexOf('/')
      if (slash <= 0) return cur
      const parent = cur.slice(0, slash)
      const parentTarget = this.symlinks.get(parent)
      if (parentTarget === undefined) return cur
      const rest = cur.slice(slash)
      cur = parentTarget.startsWith('/')
        ? normalize(parentTarget + rest)
        : normalize(`${parent}/../${parentTarget}${rest}`)
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
    // writes follow links (like real fs): otherwise a write through a link
    // creates a shadowing real file while reads keep hitting the target
    const z = this.locate(this.followSymlink(path))
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
    // buffer-level append (P1-4): the old read-as-text + string-concat
    // corrupted binaries through lossy UTF-8. Bytes append to bytes; text
    // appends to text so read() keeps working on text files.
    const z = this.locate(this.followSymlink(path))
    if (z.zone === 'vfs') {
      const existing = this.vfs.readBytes(z.vpath)
      if (existing === null) {
        await this.writeFile(path, content, options)
        return
      }
      if (typeof content === 'string' && this.vfs.isText(z.vpath)) {
        await this.writeFile(path, new TextDecoder().decode(existing) + content, options)
        return
      }
      const add = typeof content === 'string' ? new TextEncoder().encode(content) : (content as Uint8Array)
      const merged = new Uint8Array(existing.length + add.length)
      merged.set(existing, 0)
      merged.set(add, existing.length)
      await this.writeFile(path, merged, options)
      return
    }
    let prev = ''
    try {
      prev = await this.readFile(path)
    } catch {
      // appending creates the file
    }
    await this.writeFile(path, prev + decode(content), options)
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
    const z = this.locate(this.followSymlink(path))
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
      const entries: Dirent[] = names.map((name) => ({
        name,
        isFile: this.vfs.isFile(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
        isDirectory: this.vfs.isDir(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
        isSymbolicLink: this.symlinks.has(`${z.vpath === '/' ? '' : z.vpath}/${name}`),
      }))
      // the root lists BOTH zones: the workspace and the system dirs
      if (z.vpath === '/') {
        const seen = new Set(entries.map((entry) => entry.name))
        for (const dir of this.sysDirs) {
          if (dir !== '/' && !dir.slice(1).includes('/') && !seen.has(dir.slice(1))) {
            entries.push({ name: dir.slice(1), isFile: false, isDirectory: true, isSymbolicLink: false })
            seen.add(dir.slice(1))
          }
        }
        for (const file of this.sysFiles.keys()) {
          const top = file.slice(1, file.indexOf('/', 1) === -1 ? undefined : file.indexOf('/', 1))
          if (top !== '' && !top.includes('/') && !seen.has(top)) {
            entries.push({ name: top, isFile: true, isDirectory: false, isSymbolicLink: false })
            seen.add(top)
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
      }
      return entries
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
      // sidecar entries at/under the deleted path die with it (leak fix)
      this.sidecar.prune(normalize(z.vpath))
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
      this.sidecar.save()
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
      // a symlink has no VFS file to rename — move its sidecar entry
      if (this.symlinks.has(normalize(src))) {
        this.sidecar.remap(normalize(zSrc.vpath), normalize(zDest.vpath))
        return
      }
      this.vfs.rename(zSrc.vpath, zDest.vpath)
      this.sidecar.remap(normalize(zSrc.vpath), normalize(zDest.vpath))
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
    this.sidecar.save()
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (await this.exists(linkPath)) throw new Error(`EEXIST: '${linkPath}' already exists`)
    this.sysEnsureParents(linkPath)
    this.symlinks.set(normalize(linkPath), target)
    this.sidecar.save()
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
