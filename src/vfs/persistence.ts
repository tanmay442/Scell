import { openDB, type IDBPDatabase } from 'idb'
import type { VfsFileMap, VfsPersistence } from './types'

const STORE = 'files'

/**
 * node_modules never persists: browsers abort multi-hundred-MB IndexedDB
 * transactions (quota), and dependencies are reproducible with one
 * `npm install` (registry metadata is cached in memory per session). Source,
 * dotfiles and .git always persist.
 */
function persistable(path: string): boolean {
  return !path.includes('/node_modules/')
}

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
    /**
     * Incremental save: upsert changed files, delete removed ones — one
     * transaction, no full rewrite. A workspace with a 90MB installed CLI
     * cannot survive clear-and-rewrite on every keystroke.
     */
    async saveChanges(upserts: VfsFileMap, deletes: string[]) {
      try {
        const conn = db()
        if (!conn) return
        const database = await conn
        if (database.objectStoreNames.contains(STORE)) {
          const tx = database.transaction(STORE, 'readwrite')
          const store = tx.objectStore(STORE)
          for (const path of deletes) if (persistable(path)) void store.delete(path)
          for (const [path, content] of Object.entries(upserts)) {
            if (!persistable(path)) continue
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
        const keys = await database.getAllKeys(STORE)
        if (keys.length === 0) return null
        const files: Record<string, string | Uint8Array> = {}
        for (const key of keys) {
          const value = await database.get(STORE, key)
          if (typeof key === 'string' && persistable(key) && (typeof value === 'string' || value instanceof Uint8Array)) {
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
          if (!persistable(path)) continue
          void tx.objectStore(STORE).put(content, path)
        }
        await tx.done
      } catch {
        // storage full or unavailable — the in-memory VFS keeps working
      }
    },
  }
}
