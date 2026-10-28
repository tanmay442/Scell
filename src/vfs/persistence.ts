import { openDB, type IDBPDatabase } from 'idb'
import type { VfsFileMap, VfsPersistence } from './types'

const STORE = 'files'
/** out-of-band tombstone store: survives full file wipes (P0-9) */
const META_STORE = 'meta'
const SEED_FLAG = 'seeded'

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
/**
 * Out-of-band seed tombstone (P0-9): an empty file image is ambiguous —
 * fresh browser or deliberate full wipe (autosave converges deletions, so a
 * wiped workspace loads as null exactly like a fresh one). The flag lives in
 * a separate object store the file wipe never touches. Best-effort: private
 * mode without IndexedDB simply always reports unseeded.
 */
export async function loadSeedFlag(dbName = 'cell-workspace-v2'): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false
    const database = await openDB(dbName, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      },
    })
    if (!database.objectStoreNames.contains('meta')) return false
    return (await database.get('meta', 'seeded')) === true
  } catch {
    return false
  }
}

export async function saveSeedFlag(dbName = 'cell-workspace-v2'): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return
    const database = await openDB(dbName, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      },
    })
    if (!database.objectStoreNames.contains('meta')) return
    await database.put('meta', true, 'seeded')
  } catch {
    // private mode — persistence is best-effort anyway
  }
}

export function createIdbPersistence(dbName = 'cell-workspace-v2'): VfsPersistence {
  let dbPromise: Promise<IDBPDatabase> | null = null

  function db(): Promise<IDBPDatabase> | null {
    if (typeof indexedDB === 'undefined') return null
    if (!dbPromise) {
      dbPromise = openDB(dbName, 2, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
          if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE)
        },
      })
    }
    return dbPromise
  }

  return {
    async saveChanges(upserts: VfsFileMap, deletes: string[]) {
      const conn = db()
      if (!conn) return
      const database = await conn
      if (database.objectStoreNames.contains(STORE)) {
        const tx = database.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const pending: Promise<unknown>[] = []
        for (const path of deletes) pending.push(store.delete(path))
        for (const [path, content] of Object.entries(upserts)) {
          pending.push(store.put(content, path))
        }
        await Promise.all(pending)
        await tx.done
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
      const conn = db()
      if (!conn) return
      const database = await conn
      // write-then-swap (P0-8): the old clear-then-put in one transaction
      // left a crash window where the whole workspace was gone. New keys
      // land first; stale keys are removed after, so a crash can only
      // leave ghosts (cleaned on the next save), never an empty store.
      const oldKeys = (await database.getAllKeys(STORE)) as string[]
      const tx = database.transaction(STORE, 'readwrite')
      await Promise.all(Object.entries(files).map(([path, content]) => tx.objectStore(STORE).put(content, path)))
      await tx.done
      const fresh = new Set(Object.keys(files))
      const stale = oldKeys.filter((key) => typeof key === 'string' && !fresh.has(key))
      if (stale.length > 0) {
        const sweep = database.transaction(STORE, 'readwrite')
        await Promise.all(stale.map((key) => sweep.objectStore(STORE).delete(key)))
        await sweep.done
      }
    },
  }
}
