import { openDB, type IDBPDatabase } from 'idb'
import type { VfsFileMap, VfsPersistence } from './types'

const STORE = 'files'

/**
 * IndexedDB-backed persistence: one object store, path -> content.
 *
 * Everything persists — node_modules included. Saves are INCREMENTAL
 * (upserts + deletes, no clear-and-rewrite), which is what makes a
 * multi-hundred-MB workspace survivable; the full-rewrite save exists only
 * as the fallback for backends without saveChanges. Load reads the whole
 * store in ONE pass (getAll + getAllKeys) so a 5000-file boot stays fast.
 *
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
    async saveChanges(upserts: VfsFileMap, deletes: string[]) {
      try {
        const conn = db()
        if (!conn) return
        const database = await conn
        if (database.objectStoreNames.contains(STORE)) {
          const tx = database.transaction(STORE, 'readwrite')
          const store = tx.objectStore(STORE)
          for (const path of deletes) void store.delete(path)
          for (const [path, content] of Object.entries(upserts)) {
            void store.put(content, path)
          }
          await tx.done
        }
      } catch {
        // storage unavailable — the in-memory VFS keeps working
      }
    },
    async load() {
      try {
        const conn = db()
        if (!conn) return null
        const database = await conn
        const [keys, values] = await Promise.all([
          database.getAllKeys(STORE),
          database.getAll(STORE),
        ])
        if (keys.length === 0) return null
        const files: Record<string, string | Uint8Array> = {}
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          const value = values[i]
          if (typeof key === 'string' && (typeof value === 'string' || value instanceof Uint8Array)) {
            files[key] = value
          }
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
