import type { Vfs, VfsFileMap, VfsPersistence } from './types'

/**
 * Flush the VFS to persistence after a quiet period — incrementally when the
 * backend supports it (changed files upserted, removed files deleted), full
 * snapshot otherwise. Also flushes on hidden/closing, the last realistic
 * save points before the user walks away.
 */
export function startAutoSave(vfs: Vfs, persistence: VfsPersistence, delayMs = 400): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const dirty = new Set<string>()
  const deleted = new Set<string>()

  function flush() {
    if (stopped) return
    if (persistence.saveChanges && (dirty.size > 0 || deleted.size > 0)) {
      const upserts: VfsFileMap = {}
      for (const path of dirty) {
        const text = vfs.read(path)
        if (text !== null) upserts[path] = text
        else {
          const bytes = vfs.readBytes(path)
          if (bytes !== null) upserts[path] = bytes
        }
      }
      const removes = [...deleted]
      dirty.clear()
      deleted.clear()
      void persistence.saveChanges(upserts, removes)
      return
    }
    if (!persistence.saveChanges) void persistence.save(vfs.snapshot())
  }

  const unwatch = vfs.watch((event) => {
    if (stopped) return
    if (event.kind === 'write' || event.kind === 'mkdir') {
      dirty.add(event.path)
      deleted.delete(event.path)
    } else if (event.kind === 'delete') {
      deleted.add(event.path)
      dirty.delete(event.path)
    } else if (event.kind === 'rename') {
      deleted.add(event.path)
      if (event.to) dirty.add(event.to)
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, delayMs)
  })

  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('beforeunload', onHidden)

  return () => {
    stopped = true
    unwatch()
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('beforeunload', onHidden)
    if (timer) clearTimeout(timer)
  }
}
