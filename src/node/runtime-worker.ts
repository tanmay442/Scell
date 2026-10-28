/// <reference lib="webworker" />
import { resolveId, NODE_BUILTINS, type ResolverFs } from './resolve'

/**
 * Cell's node runtime: a V8 isolate (web worker) with a CommonJS module
 * system and Node-flavored globals over an in-memory filesystem snapshot.
 * stdout/stderr stream out as messages; file writes stay local until the
 * process exits, then the diff is reported back so the host can apply it to
 * the VFS. No imports from the app: this file is bundled standalone.
 */

interface ExecRequest {
  type: 'exec'
  id: number
  /** zero-copy workspace snapshot: one byte buffer + [path, offset, length] */
  payload: { buffer: Uint8Array; index: [string, number, number][] }
  /** user env from ~/.cell/env.json */
  env?: Record<string, string>
  entry: string
  argv: string[]
  cwd: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

// Lazy file table: contents decode from the payload buffer on first use —
// eagerly decoding a whole installed-CLI workspace (90MB+) killed renderers.
// Writes land in an overlay; deletes in a set; the exit diff uses only those.
let payloadBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
const payloadIndex = new Map<string, [number, number]>()
const decoded = new Map<string, string>()
const overlay = new Map<string, string>()
const removed = new Set<string>()
let currentId = 0

function fileList(): Set<string> {
  const set = new Set<string>([...payloadIndex.keys(), ...overlay.keys()])
  for (const path of removed) set.delete(path)
  return set
}

function fileHas(path: string): boolean {
  return overlay.has(path) || (payloadIndex.has(path) && !removed.has(path))
}

function fileRead(path: string): string | undefined {
  const written = overlay.get(path)
  if (written !== undefined) return written
  if (removed.has(path)) return undefined
  const span = payloadIndex.get(path)
  if (span === undefined) return undefined
  let text = decoded.get(path)
  if (text === undefined) {
    text = decoder.decode(payloadBuffer.subarray(span[0], span[0] + span[1]))
    decoded.set(path, text)
  }
  return text
}

function fileWrite(path: string, text: string) {
  overlay.set(path, text)
  decoded.set(path, text)
  removed.delete(path)
}

function fileDelete(path: string) {
  overlay.delete(path)
  decoded.delete(path)
  removed.add(path)
}

function send(message: unknown) {
  self.postMessage(message)
}

// ---- the sandbox filesystem -------------------------------------------

/** explicitly mkdir'd dirs have no files yet — track them so existsSync,
 * statSync and readdirSync see just-created empty dirs (implied-dir model) */
const explicitDirs = new Set<string>()
function listDirs(): Set<string> {
  const dirs = new Set<string>(['/', ...explicitDirs])
  for (const path of fileList()) {
    let dir = path
    while ((dir = dir.slice(0, dir.lastIndexOf('/')))) dirs.add(dir)
    dirs.add('/')
  }
  return dirs
}

function normalizePath(p: string, cwd: string): string {
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

/** node resolves relative fs paths against process.cwd() */
function resolveFsPath(p: string): string {
  if (p.startsWith('/') || p.startsWith('file://')) return p
  return normalizePath(p, processShim.cwd())
}

const sandboxFs = {
  existsSync(path: string) {
    const resolved = resolveFsPath(path)
    return fileHas(resolved) || listDirs().has(resolved)
  },
  statSync(rawPath: string) {
    const path = resolveFsPath(rawPath)
    if (fileHas(path)) {
      return { isFile: () => true, isDirectory: () => false, size: (fileRead(path) ?? '').length }
    }
    if (listDirs().has(path)) {
      return { isFile: () => false, isDirectory: () => true, size: 0 }
    }
    const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & { code: string }
    err.code = 'ENOENT'
    throw err
  },
  readFileSync(rawPath: string, encoding?: string) {
    const path = resolveFsPath(rawPath)
    const content = fileRead(path)
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }
    // node parity: no encoding → Buffer; string encodings → string
    if (encoding === undefined) return BufferShim.from(content, 'utf8')
    if (encoding === 'utf8' || encoding === 'utf-8') return content
    return BufferShim.from(content, 'utf8').toString(encoding as 'base64' | 'hex' | 'latin1') as unknown as string
  },
  writeFileSync(rawPath: string, data: string | Uint8Array) {
    const path = resolveFsPath(rawPath)
    fileWrite(path, typeof data === 'string' ? data : decoder.decode(data))
  },
  appendFileSync(rawPath: string, data: string | Uint8Array) {
    const path = resolveFsPath(rawPath)
    const prev = fileRead(path) ?? ''
    fileWrite(path, prev + (typeof data === 'string' ? data : decoder.decode(data)))
  },
  unlinkSync(rawPath: string) {
    const path = resolveFsPath(rawPath)
    fileDelete(path)
  },
  mkdirSync(path: string, _options?: { recursive?: boolean }) {
    explicitDirs.add(resolveFsPath(path))
  },
  rmdirSync(path: string) {
    for (const key of fileList()) {
      if (key.startsWith(`${path}/`)) fileDelete(key)
    }
  },
  rmSync(path: string, options?: { recursive?: boolean }) {
    if (fileHas(path)) fileDelete(path)
    else if (options?.recursive) {
      for (const key of fileList()) {
        if (key.startsWith(`${path}/`)) fileDelete(key)
      }
    }
  },
  readdirSync(rawPath: string): string[] {
    const path = resolveFsPath(rawPath)
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const key of fileList()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length)
        if (rest) names.add(rest.split('/')[0])
      }
    }
    if (names.size === 0 && !listDirs().has(path)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }
    return [...names].sort()
  },
}

function asyncFs<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn())
      } catch (err) {
        reject(err)
      }
    }, 0)
  })
}

const fsPromises = {
  readFile: (path: string, encoding?: string) => asyncFs(() => sandboxFs.readFileSync(path, encoding)),
  writeFile: (path: string, data: string | Uint8Array) => asyncFs(() => sandboxFs.writeFileSync(path, data)),
  appendFile: (path: string, data: string | Uint8Array) => asyncFs(() => sandboxFs.appendFileSync(path, data)),
  readdir: (path: string) => asyncFs(() => sandboxFs.readdirSync(path)),
  stat: (path: string) => asyncFs(() => sandboxFs.statSync(path)),
  unlink: (path: string) => asyncFs(() => sandboxFs.unlinkSync(path)),
  mkdir: (path: string) => asyncFs(() => sandboxFs.mkdirSync(path)),
  rm: (path: string, options?: { recursive?: boolean }) => asyncFs(() => sandboxFs.rmSync(path, options)),
}

// ---- Buffer ------------------------------------------------------------

class BufferShim extends Uint8Array {
  // `any` on purpose: keeps this static compatible with Uint8Array.from's
  // overloads while accepting Node's Buffer.from(input, encoding) shape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(input: any, encodingOrMapfn: string | ((v: number, k: number) => number) = 'utf8'): BufferShim {
    if (typeof input === 'string') {
      const encoding = typeof encodingOrMapfn === 'string' ? encodingOrMapfn : 'utf8'
      const bytes =
        encoding === 'base64'
          ? base64ToBytes(input)
          : encoding === 'latin1'
            ? latin1ToBytes(input)
            : encoding === 'hex'
              ? hexToBytes(input)
              : encoder.encode(input)
      return new BufferShim(bytes)
    }
    if (typeof encodingOrMapfn === 'function' && input && typeof input[Symbol.iterator] === 'function') {
      return new BufferShim(new Uint8Array(Array.from(input as Iterable<number>, encodingOrMapfn as (v: number, k: number) => number)))
    }
    if (input instanceof Uint8Array) return new BufferShim(input)
    if (input instanceof ArrayBuffer) return new BufferShim(new Uint8Array(input))
    if (Array.isArray(input)) return new BufferShim(new Uint8Array(input))
    throw new TypeError('Buffer.from: unsupported input')
  }
  static alloc(size: number, fill = 0): BufferShim {
    const arr = new Uint8Array(size)
    if (fill) arr.fill(fill)
    return new BufferShim(arr)
  }
  static isBuffer(value: unknown): value is BufferShim {
    return value instanceof BufferShim
  }
  static concat(parts: Uint8Array[]): BufferShim {
    let size = 0
    for (const part of parts) size += part.byteLength
    const out = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    return new BufferShim(out)
  }
  static byteLength(value: string): number {
    return encoder.encode(value).byteLength
  }
  static allocUnsafe(size: number): BufferShim {
    return new BufferShim(new Uint8Array(size))
  }
  static compare(a: Uint8Array, b: Uint8Array): number {
    const len = Math.min(a.byteLength, b.byteLength)
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    }
    return a.byteLength === b.byteLength ? 0 : a.byteLength < b.byteLength ? -1 : 1
  }
  toString(encoding = 'utf8'): string {
    if (encoding === 'base64') return bytesToBase64(this)
    if (encoding === 'hex') {
      let out = ''
      for (const byte of this) out += byte.toString(16).padStart(2, '0')
      return out
    }
    if (encoding === 'latin1' || encoding === 'binary') {
      let out = ''
      for (const byte of this) out += String.fromCharCode(byte)
      return out
    }
    return decoder.decode(this)
  }
  equals(other: Uint8Array): boolean {
    if (other.byteLength !== this.byteLength) return false
    for (let i = 0; i < this.byteLength; i++) if (this[i] !== other[i]) return false
    return true
  }
  compare(other: Uint8Array): number {
    return BufferShim.compare(this, other)
  }
  indexOf(value: string | number | Uint8Array, byteOffset = 0): number {
    if (typeof value === 'number') return this.indexOfByte(value & 0xff, byteOffset)
    const needle = typeof value === 'string' ? encoder.encode(value) : value
    for (let i = Math.max(0, byteOffset); i <= this.byteLength - needle.byteLength; i++) {
      let hit = true
      for (let j = 0; j < needle.byteLength; j++) {
        if (this[i + j] !== needle[j]) {
          hit = false
          break
        }
      }
      if (hit) return i
    }
    return -1
  }
  private indexOfByte(byte: number, from: number): number {
    for (let i = Math.max(0, from); i < this.byteLength; i++) {
      if (this[i] === byte) return i
    }
    return -1
  }
  readUInt32BE(offset = 0): number {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0
  }
  readUInt32LE(offset = 0): number {
    return ((this[offset + 3] << 24) | (this[offset + 2] << 16) | (this[offset + 1] << 8) | this[offset]) >>> 0
  }
  readUInt16BE(offset = 0): number {
    return (this[offset] << 8) | this[offset + 1]
  }
  readUInt8(offset = 0): number {
    return this[offset]
  }
  writeUInt32BE(value: number, offset = 0): number {
    this[offset] = (value >>> 24) & 0xff
    this[offset + 1] = (value >>> 16) & 0xff
    this[offset + 2] = (value >>> 8) & 0xff
    this[offset + 3] = value & 0xff
    return offset + 4
  }
  writeUInt32LE(value: number, offset = 0): number {
    this[offset] = value & 0xff
    this[offset + 1] = (value >>> 8) & 0xff
    this[offset + 2] = (value >>> 16) & 0xff
    this[offset + 3] = (value >>> 24) & 0xff
    return offset + 4
  }
  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) }
  }
}

function hexToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i + 1 < clean.length + 1; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16)
  }
  return out
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function base64ToBytes(text: string): Uint8Array {
  // keep padding: without it short inputs decode to empty output
  const stripped = text.replace(/[^A-Za-z0-9+/=]/g, '')
  const clean = stripped + '='.repeat((4 - (stripped.length % 4)) % 4)
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - pad)
  let offset = 0
  for (let i = 0; i + 3 < clean.length + 1; i += 4) {
    const n =
      (base64Index(clean[i]) << 18) |
      (base64Index(clean[i + 1]) << 12) |
      (base64Index(clean[i + 2]) << 6) |
      base64Index(clean[i + 3] ?? '')
    if (offset < out.length) out[offset++] = (n >> 16) & 0xff
    if (offset < out.length) out[offset++] = (n >> 8) & 0xff
    if (offset < out.length) out[offset++] = n & 0xff
  }
  return out.subarray(0, offset)
}

function base64Index(ch: string): number {
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 65
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 71
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) + 4
  if (ch === '+') return 62
  if (ch === '/') return 63
  return 0
}

/** Synchronous SHA-256 (FIPS 180-4) for crypto.createHash('sha256').
 * The sandbox digest() is synchronous, so WebCrypto (async-only) cannot
 * serve it — this blocking implementation does. */
function sha256Hex(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const bitLen = bytes.length * 8
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 4, bitLen >>> 0)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000))
  const w = new Array<number>(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + s1 + ch + k[i] + w[i]) | 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += chars[b0 >> 2]
    out += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : chars[b2 & 63]
  }
  return out
}

// ---- path / os / util / events ----------------------------------------

function normalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

const pathShim = {
  sep: '/',
  delimiter: ':',
  posix: null as unknown,
  resolve(...segments: string[]) {
    let resolved = ''
    for (const segment of segments) {
      if (segment.startsWith('/')) resolved = segment
      else if (resolved === '') resolved = `${processShim.cwd()}/${segment}`
      else resolved = `${resolved}/${segment}`
    }
    return normalize(resolved === '' ? processShim.cwd() : resolved)
  },
  normalize(p: string) {
    return normalize(p)
  },
  isAbsolute(p: string) {
    return p.startsWith('/')
  },
  join(...parts: string[]) {
    return normalize(parts.join('/'))
  },
  dirname(p: string) {
    const n = normalize(p)
    const i = n.lastIndexOf('/')
    return i <= 0 ? '/' : n.slice(0, i)
  },
  basename(p: string, ext?: string) {
    const n = normalize(p)
    const base = n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1)
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  },
  extname(p: string) {
    const base = pathShim.basename(p)
    const i = base.lastIndexOf('.')
    return i <= 0 ? '' : base.slice(i)
  },
  relative(from: string, to: string) {
    const a = normalize(from).split('/').filter(Boolean)
    const b = normalize(to).split('/').filter(Boolean)
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    const up = '../'.repeat(Math.max(0, a.length - i))
    return `${up}${b.slice(i).join('/')}` || '.'
  },
  parse(p: string) {
    const base = pathShim.basename(p)
    const ext = pathShim.extname(p)
    return {
      root: '/',
      dir: pathShim.dirname(p),
      base,
      ext,
      name: base.slice(0, base.length - ext.length),
    }
  },
}
pathShim.posix = pathShim

const osShim = {
  EOL: '\n',
  platform: () => 'linux',
  homedir: () => '/home/user',
  tmpdir: () => '/tmp',
  cpus: () => [{ model: 'cell-isolate' }],
  totalmem: () => 512 * 1024 * 1024,
  freemem: () => 256 * 1024 * 1024,
}

class EventEmitterShim {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  on(event: string, fn: (...args: unknown[]) => void) {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return this
  }
  addListener(event: string, fn: (...args: unknown[]) => void) {
    return this.on(event, fn)
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped)
      fn(...args)
    }
    return this.on(event, wrapped)
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(fn)
    return this
  }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
    return this.off(event, fn)
  }
  emit(event: string, ...args: unknown[]) {
    const set = this.listeners.get(event)
    if (!set) return false
    for (const fn of [...set]) fn(...args)
    return set.size > 0
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0
  }
}

// ---- console + inspect -------------------------------------------------

function inspect(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const type = typeof value
  if (type === 'string') return depth === 0 ? (value as string) : `'${value as string}'`
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
  if (type === 'symbol') return String(value)
  if (type === 'function') {
    const name = (value as { name?: string }).name || '(anonymous)'
    return (value as () => Promise<unknown>).constructor?.name === 'AsyncFunction' ? `[AsyncFunction: ${name}]` : `[Function: ${name}]`
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  if (seen.has(value)) return '[Circular]'
  if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => inspect(item, depth + 1, seen)).join(', ')
      return `[${items.length > 60 ? `${items.slice(0, 60)}… ${value.length} items` : items}]`
    }
    if (value instanceof Map) {
      const items = [...value.entries()].map(([k, v]) => `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`).join(', ')
      return `Map(${value.size}) {${items}}`
    }
    if (value instanceof Set) {
      const items = [...value].map((v) => inspect(v, depth + 1, seen)).join(', ')
      return `Set(${value.size}) {${items}}`
    }
    if (value instanceof Date) return value.toISOString()
    const entries = Object.entries(value as Record<string, unknown>)
    const body = entries
      .map(([key, v]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`}: ${inspect(v, depth + 1, seen)}`)
      .join(', ')
    const name = (value as object).constructor?.name
    const prefix = name && name !== 'Object' ? `${name} ` : ''
    return `${prefix}{ ${body} }`
  } finally {
    seen.delete(value)
  }
}

function format(args: unknown[]): string {
  if (args.length === 0) return ''
  const first = args[0]
  if (typeof first === 'string' && /%[sdifjoO%]/.test(first)) {
    let out = ''
    let argIndex = 1
    let i = 0
    while (i < first.length) {
      if (first[i] === '%' && i + 1 < first.length) {
        const spec = first[i + 1]
        if (spec === '%') {
          out += '%'
          i += 2
          continue
        }
        const arg = args[argIndex++]
        if (spec === 's') out += inspect(arg, arg === undefined ? 0 : 0) === 'undefined' ? 'undefined' : String(arg)
        else if (spec === 'd' || spec === 'i') out += String(parseInt(String(arg), 10))
        else if (spec === 'f') out += String(parseFloat(String(arg)))
        else if (spec === 'j') out += JSON.stringify(arg)
        else if (spec === 'o' || spec === 'O') out += inspect(arg, 1)
        else {
          out += first[i] + spec
        }
        i += 2
        continue
      }
      out += first[i]
      i += 1
    }
    return out + (argIndex < args.length ? ` ${args.slice(argIndex).map((a) => inspect(a, 1)).join(' ')}` : '')
  }
  return args.map((arg) => inspect(arg, 0)).join(' ')
}

let currentStdout = (text: string) => {}
let currentStderr = (text: string) => {}

const consoleShim = {
  log: (...args: unknown[]) => currentStdout(`${format(args)}\n`),
  info: (...args: unknown[]) => currentStdout(`${format(args)}\n`),
  debug: (...args: unknown[]) => currentStdout(`${format(args)}\n`),
  warn: (...args: unknown[]) => currentStderr(`${format(args)}\n`),
  error: (...args: unknown[]) => currentStderr(`${format(args)}\n`),
  trace: (...args: unknown[]) => currentStderr(`Trace: ${format(args)}\n`),
}

// ---- module system ------------------------------------------------------

interface NodeError extends Error {
  code?: string
}

function nodeError(code: string, message: string): NodeError {
  const err = new Error(message) as NodeError
  err.code = code
  return err
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    exitRequested = code
  }
}

const resolverFs: ResolverFs = {
  isFile(path) {
    return fileHas(path)
  },
  readText(path) {
    return fileRead(path) ?? null
  },
}

// ONE cache per process, like node's require.cache — a per-closure cache
// made circular imports (semver, yargs, …) recurse until stack overflow
const moduleCache = new Map<string, { exports: unknown }>()

function makeRequire(fromFile: string) {
  return require

  function require(id: string): unknown {
    const resolved = resolveId(resolverFs, fromFile, id)
    if (resolved.kind === 'builtin') {
      return builtinModule(resolved.name, fromFile)
    }
    if (resolved.kind === 'not-found') {
      throw nodeError(
        'MODULE_NOT_FOUND',
        `Cannot find module '${id}'. Required from '${fromFile}'`,
      )
    }
    if (moduleCache.has(resolved.path)) return moduleCache.get(resolved.path)!.exports
    if (resolved.path.endsWith('.json')) {
      const text = fileRead(resolved.path)!
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        throw new Error(`SyntaxError: ${resolved.path}: ${(err as Error).message}`)
      }
      moduleCache.set(resolved.path, { exports: parsed })
      return parsed
    }
    const module = { exports: {} as unknown }
    moduleCache.set(resolved.path, module)
    // node strips a leading hashbang before parsing; a bare "#!" is a
    // SyntaxError anywhere else in the file. Keep the newline so stack
    // traces keep their line numbers.
    const source = (fileRead(resolved.path) ?? '').replace(/^#![^\n]*\n/, '\n')
    const dirname = pathShim.dirname(resolved.path)

    let fn: (...args: unknown[]) => void
    try {
      fn = new Function(
        'require',
        'module',
        'exports',
        '__filename',
        '__dirname',
        'process',
        'console',
        'Buffer',
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'setImmediate',
        'queueMicrotask',
        'fetch',
        'TextEncoder',
        'TextDecoder',
        'URL',
        'URLSearchParams',
        'crypto',
        'performance',
        'globalThis',
        `"use strict";\n${source}\n//# sourceURL=cell-${resolved.path}`,
      ) as unknown as (...args: unknown[]) => void
    } catch (err) {
      if (err instanceof SyntaxError && /import statement|export statement|import\.meta/.test(err.message)) {
        throw nodeError(
          'ERR_REQUIRE_ESM',
          `${resolved.path} is an ES module and cannot be require()d in Cell's CommonJS runtime.\n` +
            `Use a dual-mode/older version of the package (most offer one), or run it through the preview bundler.`,
        )
      }
      throw err
    }

    // the arguments must line up with the parameter list above, positionally
    fn(
      makeRequire(resolved.path),
      module,
      module.exports,
      resolved.path,
      dirname,
      processShim,
      consoleShim,
      BufferShim,
      trackedSetTimeout,
      trackedSetInterval,
      trackedClearTimeout,
      trackedClearInterval,
      (fn2: () => void) => trackedSetTimeout(fn2, 0),
      queueMicrotask,
      fetch,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      crypto,
      performance,
      globalThis,
    )
    return module.exports
  }
}

function builtinModule(name: string, fromFile: string): unknown {
  // subpath imports: resolve the root, then take a provided member —
  // require('fs/promises') is the promises API, not a node_modules lookup
  const slash = name.indexOf('/')
  if (slash !== -1) {
    const rootMod = builtinModule(name.slice(0, slash), fromFile) as Record<string, unknown> | null
    const rest = name.slice(slash + 1)
    if (rootMod !== null && typeof rootMod === 'object' && rest in rootMod) {
      return rootMod[rest]
    }
    throw nodeError(
      'ERR_MODULE_NOT_FOUND',
      `Cannot find module '${name}' (required from ${fromFile})`,
    )
  }
  switch (name) {
    case 'fs':
      return { ...sandboxFs, promises: fsPromises, default: sandboxFs }
    case 'path':
      return { ...pathShim, default: pathShim }
    case 'os':
      return { ...osShim, default: osShim }
    case 'events':
      return { EventEmitter: EventEmitterShim, default: EventEmitterShim }
    case 'util':
      return {
        format,
        inspect: (value: unknown) => inspect(value, 1),
        promisify: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            ;(fn as (...a: unknown[]) => unknown)(...args, (err: unknown, ...values: unknown[]) => {
              if (err !== null && err !== undefined) reject(err)
              else resolve(values[0])
            })
          }),
        callbackify: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
          const callback = args.pop() as (err: unknown, value?: unknown) => void
          Promise.resolve()
            .then(() => (fn as (...a: unknown[]) => unknown)(...args))
            .then(
              (value) => callback(null, value),
              (err) => callback(err ?? new Error('callbackified function rejected')),
            )
        },
        types: { isDate: (v: unknown) => v instanceof Date, isPromise: (v: unknown) => v instanceof Promise },
        default: { format, inspect: (value: unknown) => inspect(value, 1) },
      }
    case 'buffer':
      return { Buffer: BufferShim, default: { Buffer: BufferShim } }
    case 'process':
      return processShim
    case 'crypto': {
      const webcrypto = globalThis.crypto
      const randomBytes = (size: number) => {
        const out = new BufferShim(new Uint8Array(size))
        webcrypto.getRandomValues(out)
        return out
      }
      const toHex = (bytes: Uint8Array) => {
        let out = ''
        for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
        return out
      }
      const createHash = (algorithm: string) => {
        const algo = algorithm.toLowerCase().replace(/-/g, '')
        // the sandbox has no async boundary for digest(), so only sha256
        // ships (real, blocking, FIPS 180-4 below). Anything else fails
        // loudly — a lookalike hex digest would corrupt integrity checks.
        if (algo !== 'sha256') {
          throw nodeError(
            'ERR_CRYPTO_UNKNOWN_DIGEST',
            `Digest method not supported in the Cell sandbox: ${algorithm} (sha256 is available)`,
          )
        }
        let data = ''
        return {
          update(input: string | Uint8Array) {
            data += typeof input === 'string' ? input : new TextDecoder().decode(input)
            return this
          },
          digest(encoding?: string) {
            const hex = sha256Hex(encoder.encode(data))
            return encoding === 'hex' ? hex : BufferShim.from(hex, 'hex')
          },
        }
      }
      return {
        webcrypto,
        randomBytes,
        randomUUID: () => webcrypto.randomUUID(),
        createHash,
        default: { webcrypto, randomBytes, randomUUID: () => webcrypto.randomUUID(), createHash },
      }
    }
    case 'tty':
      return {
        isatty: () => false,
        WriteStream: class { isTTY = false },
        ReadStream: class { isTTY = false },
        default: { isatty: () => false },
      }
    case 'assert':
      return {
        ok: (value: unknown, message?: string) => {
          if (!value) throw new Error(`AssertionError: ${message ?? 'ok() failed'}`)
        },
        equal: (a: unknown, b: unknown, message?: string) => {
          if (a !== b) throw new Error(`AssertionError: ${message ?? `${inspect(a, 1)} == ${inspect(b, 1)}`}`)
        },
        strictEqual: (a: unknown, b: unknown, message?: string) => {
          if (a !== b) throw new Error(`AssertionError: ${message ?? `${inspect(a, 1)} === ${inspect(b, 1)}`}`)
        },
        default: { ok: (value: unknown, m?: string) => { if (!value) throw new Error(m ?? 'assert') } },
      }
    case 'url':
      return { URL, URLSearchParams, default: { URL, URLSearchParams } }
    case 'querystring':
      return {
        parse: (qs: string) => Object.fromEntries(new URLSearchParams(qs)),
        stringify: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
        default: {},
      }
    case 'timers':
      return { setTimeout: trackedSetTimeout, setInterval: trackedSetInterval, clearTimeout: trackedClearTimeout, clearInterval: trackedClearInterval, setImmediate: (fn: () => void) => trackedSetTimeout(fn, 0), default: {} }
    case 'string_decoder':
      return { StringDecoder: class StringDecoder { decode(bytes: Uint8Array) { return decoder.decode(bytes) } }, default: {} }
    default:
      throw nodeError(
        'MODULE_NOT_FOUND',
        `Module '${name}' is a Node builtin that the Cell sandbox does not implement yet (required from ${fromFile}). Browser-safe packages may offer a /browser entry — install that instead.`,
      )
  }
}

// ---- process ------------------------------------------------------------

const argv0 = '/usr/local/bin/node'

const processShim = {
  argv: [argv0, '/index.js'] as string[],
  argv0,
  execPath: argv0,
  env: { NODE_ENV: 'development', HOME: '/home/user', PATH: '/usr/local/bin:/usr/bin:/bin' } as Record<string, string>,
  pid: Math.floor(Math.random() * 30000) + 1000,
  platform: 'linux',
  version: 'v24.20.0 (cell)',
  versions: { node: '24.20.0', v8: 'cell-isolate' },
  cwd: () => '/',
  chdir: (_dir?: string) => {},
  exit: (code = 0) => {
    throw new ExitError(code)
  },
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => fn(...(args as [])))
  },
  on: () => {},
  stdout: { write: (text: string) => { currentStdout(typeof text === 'string' ? text : decoder.decode(text)) ; return true } },
  stderr: { write: (text: string) => { currentStderr(typeof text === 'string' ? text : decoder.decode(text)); return true } },
}

// ---- exec ---------------------------------------------------------------

/** Bounded event-loop drain: wait until no timer fires within a quiet
 * window (or the hard cap hits). process.exit() short-circuits it. */
let exitRequested: number | null = null
async function drainEventLoop(quietMs = 120, capMs = 240_000): Promise<void> {
  const deadline = Date.now() + capMs
  for (;;) {
    if (exitRequested !== null) return
    if (pendingTimers === 0) return
    const before = pendingTimerEpoch
    await new Promise((resolve) => setTimeout(resolve, quietMs))
    if (pendingTimerEpoch === before && pendingTimers === 0) return
    if (Date.now() > deadline) return
  }
}

/** every setTimeout/setInterval bumps this epoch */
let pendingTimerEpoch = 0
let pendingTimers = 0
const pendingTimerHandles = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>()
function trackedSetTimeout(fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): ReturnType<typeof setTimeout> {
  pendingTimerEpoch++
  pendingTimers++
  const handle = setTimeout(() => {
    pendingTimers--
    pendingTimerHandles.delete(handle)
    try {
      fn(...rest)
    } catch (err) {
      currentStderr(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    }
  }, ms)
  pendingTimerHandles.add(handle)
  return handle
}
function trackedSetInterval(fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): ReturnType<typeof setInterval> {
  pendingTimerEpoch++
  const handle = setInterval(() => {
    try {
      fn(...rest)
    } catch (err) {
      currentStderr(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    }
  }, ms)
  pendingTimerHandles.add(handle)
  return handle
}
/** clears must release the tracked handle — otherwise a cleared timer
 * makes the event-loop drain spin until the host timeout kills the run */
function trackedClearTimeout(handle: unknown): void {
  if (pendingTimerHandles.delete(handle as ReturnType<typeof setTimeout>)) pendingTimers--
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}
function trackedClearInterval(handle: unknown): void {
  pendingTimerHandles.delete(handle as ReturnType<typeof setInterval>)
  clearInterval(handle as ReturnType<typeof setInterval>)
}

self.onmessage = async (event: MessageEvent<ExecRequest>) => {
  const msg = event.data
  if (msg.type !== 'exec') return
  currentId = msg.id
  moduleCache.clear()
  pendingTimerHandles.clear()
  pendingTimers = 0
  explicitDirs.clear()
  if (msg.env) Object.assign(processShim.env, msg.env)
  // the sandbox speaks strings; binaries decode lossily on load — same
  // semantics as always, just off the main thread now
  payloadBuffer = msg.payload.buffer
  payloadIndex.clear()
  decoded.clear()
  overlay.clear()
  removed.clear()
  for (const [path, offset, length] of msg.payload.index) {
    payloadIndex.set(path, [offset, length])
  }

  processShim.argv = [argv0, msg.entry, ...msg.argv]
  processShim.cwd = () => msg.cwd
  processShim.chdir = (dir?: string) => {
    msg.cwd = normalizePath(dir ?? '/', msg.cwd)
  }

  let exitCode = 0
  currentStdout = (text) => send({ type: 'out', id: msg.id, stream: 'stdout', text })
  currentStderr = (text) => send({ type: 'out', id: msg.id, stream: 'stderr', text })

  try {
    const entry = msg.entry
    if (!fileHas(entry)) {
      throw nodeError('MODULE_NOT_FOUND', `Cannot find module '${entry}'`)
    }
    const entryBase = entry.slice(entry.lastIndexOf('/') + 1)
    makeRequire(entry)(`./${entryBase}`)
  } catch (err) {
    if (err instanceof ExitError) {
      exitCode = err.code
    } else {
      exitCode = 1
      const text = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : inspect(err, 1)
      currentStderr(`${text}\n`)
    }
  }

  // DRAIN THE EVENT LOOP: node keeps the process alive while timers/IO are
  // pending. Yield until a quiet window (bounded by the host's run timeout):
  // this is what lets setTimeout callbacks, fs.promises and in-flight fetch
  // results land before exit.
  await drainEventLoop()

  // report the filesystem diff so the host can apply it to the real VFS —
  // only what this process actually touched
  for (const [path, content] of overlay) {
    const span = payloadIndex.get(path)
    const original = span === undefined ? undefined : decoder.decode(payloadBuffer.subarray(span[0], span[0] + span[1]))
    if (original !== content) {
      send({ type: 'vfs-write', id: msg.id, path, content })
    }
  }
  for (const path of removed) {
    if (payloadIndex.has(path)) {
      send({ type: 'vfs-delete', id: msg.id, path })
    }
  }
  send({ type: 'exit', id: msg.id, code: exitCode })
}
