import { describe, expect, it } from 'vitest'
import { resolveId, NODE_BUILTINS } from './resolve'

function fsFromFiles(files: Record<string, string>) {
  return {
    isFile: (path: string) => Object.hasOwn(files, path),
    readText: (path: string) => files[path] ?? null,
  }
}

describe('CJS resolver', () => {
  const files = {
    '/index.js': "require('./lib/a')",
    '/lib/a.js': "require('left-pad')",
    '/lib/b.json': '{"x":1}',
    '/node_modules/left-pad/package.json': '{"main":"index.js"}',
    '/node_modules/left-pad/index.js': 'module.exports = 1',
    '/node_modules/@scope/util/package.json': '{"exports":{".":{"require":"./cjs.js","import":"./esm.mjs"}}}',
    '/node_modules/@scope/util/cjs.js': 'module.exports = 2',
  }
  const fs = fsFromFiles(files)

  it('resolves builtins', () => {
    expect(resolveId(fs, '/index.js', 'fs')).toEqual({ kind: 'builtin', name: 'fs' })
    expect(resolveId(fs, '/index.js', 'node:path')).toEqual({ kind: 'builtin', name: 'path' })
    expect(NODE_BUILTINS.has('zlib')).toBe(true)
  })

  it('resolves relative paths with extension probing', () => {
    expect(resolveId(fs, '/index.js', './lib/a')).toEqual({ kind: 'file', path: '/lib/a.js' })
    expect(resolveId(fs, '/lib/a.js', './b')).toEqual({ kind: 'file', path: '/lib/b.json' })
  })

  it('walks up to find node_modules', () => {
    expect(resolveId(fs, '/lib/a.js', 'left-pad')).toEqual({ kind: 'file', path: '/node_modules/left-pad/index.js' })
  })

  it('honors package.json main', () => {
    expect(resolveId(fs, '/index.js', 'left-pad').kind).toBe('file')
  })

  it('supports scoped packages with exports condition', () => {
    expect(resolveId(fs, '/index.js', '@scope/util')).toEqual({ kind: 'file', path: '/node_modules/@scope/util/cjs.js' })
  })

  it('reports not-found with context', () => {
    const result = resolveId(fs, '/index.js', './missing')
    expect(result).toEqual({ kind: 'not-found', id: './missing', from: '/index.js' })
  })
})
