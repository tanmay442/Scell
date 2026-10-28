import type { Vfs, VfsFileMap, VfsPersistence } from './types'

/**
 * Flush the VFS to persistence after a quiet period — incrementally when the
 * backend supports it (changed files upserted, removed files deleted), full
 * snapshot otherwise. Also flushes on hidden/closing, the last realistic
 * save points before the user walks away.
 *
 * The VFS emits one event per subtree operation, so a `known` set tracks
 * every believed-persisted path: a single dir delete/rename expands into
 * its descendants, and a wholesale `restore()` (which emits `write '/'`)
 * reconciles the whole image. Flush never throws: a wedged save must not
 * wedge all future saves.
 */
export function startAutoSave(vfs: Vfs, persistence: VfsPersistence, delayMs = 400): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const dirty = new Set<string>()
  const deleted = new Set<string>()
  const known = new Set<string>(vfs.listAllFiles())

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, delayMs)
  }

  /** a removed subtree: forget every known path under it */
  const forget = (path: string) => {
    for (const key of [...known]) {
      if (key === path || key.startsWith(`${path}/`)) {
        known.delete(key)
        dirty.delete(key)
        deleted.add(key)
      }
    }
  }

  function flush() {
    if (stopped) return
    try {
      if (persistence.saveChanges && (dirty.size > 0 || deleted.size > 0)) {
        const upserts: VfsFileMap = {}
        for (const path of dirty) {
          if (path === '/') continue
          let content: string | Uint8Array | null = null
          try {
            content = vfs.read(path) ?? vfs.readBytes(path)
          } catch {
            continue // dir or raced deletion — drop it, keep saving the rest
          }
          if (content !== null) upserts[path] = content
        }
        const removes = [...deleted]
        dirty.clear()
        deleted.clear()
        void persistence.saveChanges(upserts, removes)
        return
      }
      if (!persistence.saveChanges) void persistence.save(vfs.snapshot())
    } catch {
      // a wedged flush must never wedge future saves — the next event
      // re-arms the timer and retries with whatever is still dirty
      schedule()
    }
  }

  const unwatch = vfs.watch((event) => {
    if (stopped) return
    if (event.path === '/' && event.kind === 'write') {
      // wholesale restore: converge the persisted image to the new tree
      const current = new Set(vfs.listAllFiles())
      dirty.clear()
      deleted.clear()
      for (const key of known) {
        if (!current.has(key)) deleted.add(key)
      }
      known.clear()
      for (const file of current) {
        known.add(file)
        dirty.add(file)
      }
    } else if (event.kind === 'write' || event.kind === 'mkdir') {
      known.add(event.path)
      dirty.add(event.path)
      deleted.delete(event.path)
    } else if (event.kind === 'delete') {
      forget(event.path)
    } else if (event.kind === 'rename' && event.to) {
      const from = event.path
      const to = event.to
      const moved: string[] = []
      for (const key of [...known]) {
        if (key === from || key.startsWith(`${from}/`)) {
          known.delete(key)
          dirty.delete(key)
          deleted.add(key)
          moved.push(to + key.slice(from.length))
        }
      }
      for (const path of moved) {
        known.add(path)
        dirty.add(path)
      }
    }
    schedule()
  })

  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  // beforeunload visibility is unreliable — flush outright on the way out
  const onLeaving = () => flush()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('beforeunload', onLeaving)

  return () => {
    unwatch()
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('beforeunload', onLeaving)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // final best-effort write — unmount/close paths must not silently
    // drop the last delayMs window of edits
    flush()
    stopped = true
  }
}
