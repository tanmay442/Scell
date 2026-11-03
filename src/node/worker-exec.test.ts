import { it, expect, beforeAll } from 'vitest'
import { createVfs } from '../vfs'
import { installPackages } from '../shell/commands/install'
import { buildRunPayload } from './run'

/**
 * The runtime worker runs for real under vitest: `self` is mocked and the
 * onmessage handler invoked directly — so real registry packages (semver,
 * cowsay/yargs) execute through the actual sandbox.
 */

// one shared self-mock: the worker module is imported once (module cache),
// its handler stays attached across tests
let outbox: { type: string; stream?: string; text?: string; code?: number }[] = []
const selfMock: { postMessage: (message: unknown) => void; onmessage: ((event: unknown) => Promise<void>) | null } = {
  postMessage: (message: unknown) => outbox.push(message as never),
  onmessage: null,
}
;(globalThis as unknown as { self: unknown }).self = selfMock
beforeAll(async () => {
  await import('./runtime-worker')
})

async function runInWorker(vfs: ReturnType<typeof createVfs>, entry: string, argv: string[], cwd: string) {
  const payload = buildRunPayload(vfs)
  outbox = []
  const handler = selfMock.onmessage
  if (typeof handler !== 'function') throw new Error('worker handler not attached')
  await handler({ data: { type: 'exec', id: 1, payload, entry, argv, cwd } })
  const stdout = outbox.filter((m) => m.type === 'out' && m.stream === 'stdout').map((m) => m.text ?? '').join('')
  const stderr = outbox.filter((m) => m.type === 'out' && m.stream === 'stderr').map((m) => m.text ?? '').join('')
  const exit = outbox.find((m) => m.type === 'exit')
  return { stdout, stderr, exitCode: exit?.code ?? -1 }
}

it('semver bin runs (shebang strip + shared module cache + circular deps)', async () => {
  const vfs = createVfs()
  vfs.write('/home/user/.gitconfig', '[user]\n')
  await installPackages(vfs, [{ name: 'semver' }], '/home/user')
  const result = await runInWorker(vfs, '/home/user/node_modules/semver/bin/semver.js', ['1.2.3'], '/home/user')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('1.2.3')
}, 120000)

it('cowsay bin runs (yargs: deep require graphs, ESM-ish builds)', async () => {
  const vfs = createVfs()
  vfs.write('/home/user/.gitconfig', '[user]\n')
  await installPackages(vfs, [{ name: 'cowsay' }], '/home/user')
  const result = await runInWorker(vfs, '/home/user/node_modules/cowsay/cli.js', ['e2e-moo'], '/home/user')
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('< e2e-moo >')
  expect(result.stdout).toContain('---')
}, 180000)

it('empty dirs from the payload are visible to node fs', async () => {
  const vfs2 = createVfs()
  vfs2.mkdir('/home/user/emptydir')
  vfs2.write(
    '/home/user/check.js',
    'const fs = require("fs");\n' +
      'console.log("empty-exists=" + fs.existsSync("/home/user/emptydir"));\n' +
      'console.log("is-dir=" + fs.statSync("/home/user/emptydir").isDirectory());\n' +
      'fs.writeFileSync("/home/user/emptydir/made.js", "1");\n' +
      'console.log("readdir=" + JSON.stringify(fs.readdirSync("/home/user/emptydir")));',
  )
  const result2 = await runInWorker(vfs2, '/home/user/check.js', [], '/home/user')
  expect(result2.exitCode).toBe(0)
  expect(result2.stdout).toContain('empty-exists=true')
  expect(result2.stdout).toContain('is-dir=true')
  expect(result2.stdout).toContain('readdir=["made.js"]')
})
