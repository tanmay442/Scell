import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createIdbPersistence } from './persistence'

/** the headline persistence claim, without a browser: incremental saves,
// single-pass load, binary-safe, and silent no-op degradation. */
describe('idb persistence', () => {
  let serial = 0
  const fresh = () => createIdbPersistence(`cell-test-${Date.now()}-${serial++}`)

  it('save then load round-trips text and binary files', async () => {
    const persistence = fresh()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await persistence.save({ '/a.txt': 'hello', '/img.png': bytes })
    const loaded = await persistence.load()
    expect(loaded?.['/a.txt']).toBe('hello')
    expect(loaded?.['/img.png']).toEqual(bytes)
  })

  it('saveChanges is incremental: untouched files survive, deletes apply', async () => {
    const persistence = fresh()
    await persistence.save({ '/keep.txt': 'keep', '/old.txt': 'old', '/edit.txt': 'v1' })
    await persistence.saveChanges?.({ '/edit.txt': 'v2', '/new.txt': 'new' }, ['/old.txt'])
    const loaded = await persistence.load()
    expect(loaded?.['/keep.txt']).toBe('keep')
    expect(loaded?.['/edit.txt']).toBe('v2')
    expect(loaded?.['/new.txt']).toBe('new')
    expect(loaded?.['/old.txt']).toBeUndefined()
  })

  it('load on an empty store returns null', async () => {
    expect(await fresh().load()).toBeNull()
  })

  it('degrades to a silent no-op without indexedDB', async () => {
    const holder = globalThis as unknown as { indexedDB?: unknown }
    const real = holder.indexedDB
    delete holder.indexedDB
    try {
      const persistence = fresh()
      await persistence.save({ '/a.txt': 'x' })
      await persistence.saveChanges?.({ '/b.txt': 'y' }, [])
      expect(await persistence.load()).toBeNull()
    } finally {
      holder.indexedDB = real
    }
  })
})

describe('persistence write-then-swap (P0-8) + seed flag (P0-9)', () => {
  it('full save removes stale keys without a clear window', async () => {
    const persistence = fresh()
    await persistence.save({ '/keep.txt': 'keep', '/old.txt': 'old' })
    await persistence.save({ '/keep.txt': 'keep' })
    const loaded = await persistence.load()
    expect(loaded?.['/keep.txt']).toBe('keep')
    expect(loaded?.['/old.txt']).toBeUndefined()
  })

  it('seed flag round-trips out of band', async () => {
    const { loadSeedFlag, saveSeedFlag } = await import('./persistence')
    const name = `cell-test-flag-${Date.now()}`
    expect(await loadSeedFlag(name)).toBe(false)
    await saveSeedFlag(name)
    expect(await loadSeedFlag(name)).toBe(true)
  })
})
