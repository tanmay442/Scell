import { openDB, type IDBPDatabase } from 'idb'
import type { VfsPersistence } from './types'

const STORE = 'files'

/**
 * IndexedDB-backed persistence: one object store, path -> content string.
 * Degrades to a no-op when IndexedDB is unavailable (private mode, odd
 * embeds) — losing persistence is sad, crashing the app is worse.
 */
export function createIdbPersistence(dbName = 'cell-workspace-v2'): VfsPersistence {
  let dbPromise: Promise<IDBPDatabase> | null = null

  function db(): Promise<IDBPDatabase> | null {
    if (typeof indexedDB === 'undefined') return null
    if (!dbPromise) {
      dbPromise = openDB(dbName, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
        },
      })
    }
    return dbPromise
  }

  return {
    async load() {
      try {
        const conn = db()
        if (!conn) return null
        const database = await conn
        const keys = await database.getAllKeys(STORE)
        if (keys.length === 0) return null
        const files: Record<string, string> = {}
        for (const key of keys) {
          const value = await database.get(STORE, key)
          if (typeof key === 'string' && typeof value === 'string') files[key] = value
        }
        return Object.keys(files).length ? files : null
      } catch {
        return null
      }
    },
    async save(files) {
      try {
        const conn = db()
        if (!conn) return
        const database = await conn
        const tx = database.transaction(STORE, 'readwrite')
        await tx.objectStore(STORE).clear()
        for (const [path, content] of Object.entries(files)) {
          void tx.objectStore(STORE).put(content, path)
        }
        await tx.done
      } catch {
        // storage full or unavailable — the in-memory VFS keeps working
      }
    },
  }
}
