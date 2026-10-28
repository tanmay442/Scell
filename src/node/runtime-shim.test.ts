import { it, expect, beforeAll } from 'vitest'
import { createVfs } from '../vfs'
import { buildRunPayload } from './run'

/**
 * Sandbox standard-library correctness: real SHA-256 (not a lookalike),
 * base64 padding, promisify/callbackify, timer cancellation, builtin
 * subpaths (fs/promises), and exports-map subpaths.
 */
let outbox: { type: string; stream?: string; text?: string; code?: number }[] = []
const selfMock: { postMessage: (message: unknown) => void; onmessage: ((event: unknown) => Promise<void>) | null } = {
  postMessage: (message) => outbox.push(message as never),
  onmessage: null,
}
;(globalThis as unknown as { self: unknown }).self = selfMock
beforeAll(async () => {
  await import('./runtime-worker')
})

async function runJs(vfs: ReturnType<typeof createVfs>, entry: string, source: string, cwd = '/home/user') {
  vfs.write(entry, source)
  const payload = buildRunPayload(vfs)
  outbox = []
  const handler = selfMock.onmessage
  if (typeof handler !== 'function') throw new Error('worker handler not attached')
  await handler({ data: { type: 'exec', id: 1, payload, entry, argv: [], cwd } })
  const stdout = outbox.filter((m) => m.type === 'out' && m.stream === 'stdout').map((m) => m.text ?? '').join('')
  const stderr = outbox.filter((m) => m.type === 'out' && m.stream === 'stderr').map((m) => m.text ?? '').join('')
  const exit = outbox.find((m) => m.type === 'exit')
  return { stdout, stderr, exitCode: exit?.code ?? -1 }
}

it('crypto.createHash sha256 matches NIST vectors; others throw', async () => {
  const vfs = createVfs()
  const vectors = await runJs(
    vfs,
    '/t.js',
    `const c = require('crypto')
console.log(c.createHash('sha256').update('abc').digest('hex'))
console.log(c.createHash('sha256').update('').digest('hex'))
try { c.createHash('md5').update('x').digest('hex'); console.log('no-throw') } catch (e) { console.log('threw:' + e.code) }`,
  )
  expect(vectors.exitCode).toBe(0)
  const lines = vectors.stdout.trim().split('\n')
  expect(lines[0]).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(lines[1]).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(lines[2]).toBe('threw:ERR_CRYPTO_UNKNOWN_DIGEST')
}, 60000)

it('base64 decodes padded input; promisify/callbackify work; cleared timers never fire', async () => {
  const vfs = createVfs()
  const result = await runJs(
    vfs,
    '/t.js',
    `console.log(Buffer.from('YQ==', 'base64').toString())
const { promisify, callbackify } = require('util')
const read = promisify((p, cb) => cb(null, 'v:' + p))
read('x').then((v) => console.log(v))
callbackify(async () => 42)((e, v) => console.log('cb:' + v))
const t = setTimeout(() => console.log('FIRED'), 5)
clearTimeout(t)
setTimeout(() => console.log('done'), 30)`,
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('a\n')
  expect(result.stdout).toContain('v:x')
  expect(result.stdout).toContain('cb:42')
  expect(result.stdout).not.toContain('FIRED')
  expect(result.stdout).toContain('done')
}, 60000)

it('builtin subpaths resolve (fs/promises) and exports-map subpaths load', async () => {
  const vfs = createVfs()
  vfs.write('/home/user/package.json', JSON.stringify({ name: 't', version: '1.0.0' }))
  vfs.write(
    '/home/user/node_modules/leftpad/package.json',
    JSON.stringify({ name: 'leftpad', version: '1.0.0', exports: { '.': './index.js', './pad': './pad.js' } }),
  )
  vfs.write('/home/user/node_modules/leftpad/index.js', 'module.exports = () => "root";\n')
  vfs.write('/home/user/node_modules/leftpad/pad.js', 'module.exports = (s) => "[" + s + "]";\n')
  const result = await runJs(
    vfs,
    '/home/user/main.js',
    `const { readFile } = require('fs/promises')
console.log(typeof readFile)
console.log(require('leftpad/pad')('ok'))`,
    '/home/user',
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('function')
  expect(result.stdout).toContain('[ok]')
}, 60000)

it('mkdirSync dirs exist; path.resolve honors cwd', async () => {
  const vfs = createVfs()
  const result = await runJs(
    vfs,
    '/home/user/main.js',
    `const fs = require('fs')
const path = require('path')
fs.mkdirSync('emptydir')
console.log('exists:' + fs.existsSync('emptydir'))
console.log('isdir:' + fs.statSync('emptydir').isDirectory())
console.log('readdir:' + JSON.stringify(fs.readdirSync('emptydir')))
console.log('resolve:' + path.resolve('a'))
console.log('resolve2:' + path.resolve('/x', 'y', '../z'))`,
    '/home/user/proj',
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('exists:true')
  expect(result.stdout).toContain('isdir:true')
  expect(result.stdout).toContain('readdir:[]')
  expect(result.stdout).toContain('resolve:/home/user/proj/a')
  expect(result.stdout).toContain('resolve2:/x/z')
}, 60000)
