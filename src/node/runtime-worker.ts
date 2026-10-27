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
  files: Record<string, string>
  entry: string
  argv: string[]
  cwd: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

let files = new Map<string, string>()
const initial = new Map<string, string>()
let currentId = 0

function send(message: unknown) {
  self.postMessage(message)
}

// ---- the sandbox filesystem -------------------------------------------

function listDirs(): Set<string> {
  const dirs = new Set<string>(['/'])
  for (const path of files.keys()) {
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

const sandboxFs = {
  existsSync(path: string) {
    return files.has(path)
  },
  statSync(path: string) {
    if (files.has(path)) {
      return { isFile: () => true, isDirectory: () => false, size: files.get(path)!.length }
    }
    if (listDirs().has(path)) {
      return { isFile: () => false, isDirectory: () => true, size: 0 }
    }
    const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & { code: string }
    err.code = 'ENOENT'
    throw err
  },
  readFileSync(path: string, encoding?: string) {
    const content = files.get(path)
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }
    return encoding === 'utf8' || encoding === 'utf-8' || encoding === undefined ? content : BufferShim.from(content, 'utf8')
  },
  writeFileSync(path: string, data: string | Uint8Array) {
    files.set(path, typeof data === 'string' ? data : decoder.decode(data))
  },
  appendFileSync(path: string, data: string | Uint8Array) {
    const prev = files.get(path) ?? ''
    files.set(path, prev + (typeof data === 'string' ? data : decoder.decode(data)))
  },
  unlinkSync(path: string) {
    files.delete(path)
  },
  mkdirSync(path: string, _options?: { recursive?: boolean }) {
    // the in-memory fs is flat; directories are implied
  },
  rmdirSync(path: string) {
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${path}/`)) files.delete(key)
    }
  },
  rmSync(path: string, options?: { recursive?: boolean }) {
    if (files.has(path)) files.delete(path)
    else if (options?.recursive) {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key)
      }
    }
  },
  readdirSync(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const key of files.keys()) {
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
      const bytes = encoding === 'base64' ? base64ToBytes(input) : encoding === 'latin1' ? latin1ToBytes(input) : encoder.encode(input)
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
  toString(encoding = 'utf8'): string {
    if (encoding === 'base64') return bytesToBase64(this)
    if (encoding === 'latin1' || encoding === 'binary') {
      let out = ''
      for (const byte of this) out += String.fromCharCode(byte)
      return out
    }
    return decoder.decode(this)
  }
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
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
      else resolved = `${resolved}/${segment}`
    }
    return normalize(resolved)
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
  }
}

const resolverFs: ResolverFs = {
  isFile(path) {
    return files.has(path)
  },
  readText(path) {
    return files.get(path) ?? null
  },
}

function makeRequire(fromFile: string) {
  const cache = new Map<string, { exports: unknown }>()
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
    if (cache.has(resolved.path)) return cache.get(resolved.path)!.exports
    if (resolved.path.endsWith('.json')) {
      const text = files.get(resolved.path)!
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        throw new Error(`SyntaxError: ${resolved.path}: ${(err as Error).message}`)
      }
      cache.set(resolved.path, { exports: parsed })
      return parsed
    }
    const module = { exports: {} as unknown }
    cache.set(resolved.path, module)
    const source = files.get(resolved.path)!
    const dirname = pathShim.dirname(resolved.path)

    const fn = new Function(
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
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      (fn2: () => void) => setTimeout(fn2, 0),
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
        promisify: (fn: (...args: unknown[]) => unknown) => fn,
        callbackify: (fn: (...args: unknown[]) => unknown) => fn,
        types: { isDate: (v: unknown) => v instanceof Date, isPromise: (v: unknown) => v instanceof Promise },
        default: { format, inspect: (value: unknown) => inspect(value, 1) },
      }
    case 'buffer':
      return { Buffer: BufferShim, default: { Buffer: BufferShim } }
    case 'process':
      return processShim
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
      return { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate: (fn: () => void) => setTimeout(fn, 0), default: {} }
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

self.onmessage = async (event: MessageEvent<ExecRequest>) => {
  const msg = event.data
  if (msg.type !== 'exec') return
  currentId = msg.id
  files = new Map(Object.entries(msg.files))
  initial.clear()
  for (const [path, content] of Object.entries(msg.files)) initial.set(path, content)

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
    if (!files.has(entry)) {
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

  // report the filesystem diff so the host can apply it to the real VFS
  for (const [path, content] of files) {
    if (initial.get(path) !== content) {
      send({ type: 'vfs-write', id: msg.id, path, content })
    }
  }
  for (const path of initial.keys()) {
    if (!files.has(path)) {
      send({ type: 'vfs-delete', id: msg.id, path })
    }
  }
  send({ type: 'exit', id: msg.id, code: exitCode })
}
