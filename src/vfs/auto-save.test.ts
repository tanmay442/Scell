import { describe, expect, it, vi } from 'vitest'
import { createVfs } from './vfs'
import { startAutoSave } from './auto-save'
import type { VfsFileMap } from './types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function domStubs() {
  const noop = () => {}
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: noop, removeEventListener: noop })
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop })
}

function memoryBackend() {
  const store = new Map<string, string | Uint8Array>()
  return {
    store,
    async saveChanges(upserts: VfsFileMap, deletes: string[]) {
      for (const path of deletes) store.delete(path)
      for (const [path, content] of Object.entries(upserts)) store.set(path, content)
    },
    async load() {
      return null
    },
    async save(files: VfsFileMap) {
      store.clear()
      for (const [path, content] of Object.entries(files)) store.set(path, content)
    },
  }
}

describe('autosave', () => {
  it('flushes writes and never wedges on mkdir events', async () => {
    domStubs()
    const vfs = createVfs()
    const backend = memoryBackend()
    const stop = startAutoSave(vfs, backend, 5)
    try {
      vfs.mkdir('/docs')
      vfs.write('/docs/a.txt', 'a')
      await sleep(50)
      // a wedged flush (EISDIR on the dir path) would leave everything dirty
      // and this second file would never persist
      vfs.write('/b.txt', 'b')
      await sleep(50)
      expect(backend.store.get('/docs/a.txt')).toBe('a')
      expect(backend.store.get('/b.txt')).toBe('b')
    } finally {
      stop()
    }
  })

  it('a deleted directory removes its descendants from the store', async () => {
    domStubs()
    const vfs = createVfs()
    const backend = memoryBackend()
    const stop = startAutoSave(vfs, backend, 5)
    try {
      vfs.mkdir('/proj')
      vfs.write('/proj/a.txt', 'a')
      vfs.write('/proj/sub/b.txt', 'b')
      await sleep(50)
      expect(backend.store.get('/proj/sub/b.txt')).toBe('b')
      vfs.delete('/proj')
      await sleep(50)
      expect(backend.store.has('/proj/a.txt')).toBe(false)
      expect(backend.store.has('/proj/sub/b.txt')).toBe(false)
    } finally {
      stop()
    }
  })

  it('a renamed directory remaps its descendants', async () => {
    domStubs()
    const vfs = createVfs()
    const backend = memoryBackend()
    const stop = startAutoSave(vfs, backend, 5)
    try {
      vfs.write('/old/a.txt', 'a')
      await sleep(50)
      vfs.rename('/old', '/new')
      await sleep(50)
      expect(backend.store.has('/old/a.txt')).toBe(false)
      expect(backend.store.get('/new/a.txt')).toBe('a')
    } finally {
      stop()
    }
  })

  it('restore converges the store instead of resurrecting ghosts', async () => {
    domStubs()
    const vfs = createVfs()
    const backend = memoryBackend()
    const stop = startAutoSave(vfs, backend, 5)
    try {
      // the store learns the file through a real flush first
      vfs.write('/keep.txt', 'keep')
      vfs.write('/stale.txt', 'stale')
      await sleep(50)
      expect(backend.store.get('/stale.txt')).toBe('stale')
      // ...then a restore drops it: the next flush must delete it
      vfs.restore({ '/keep.txt': 'keep' })
      await sleep(50)
      expect(backend.store.has('/stale.txt')).toBe(false)
      expect(backend.store.get('/keep.txt')).toBe('keep')
    } finally {
      stop()
    }
  })
})
