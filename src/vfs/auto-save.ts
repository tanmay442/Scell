import type { Vfs, VfsPersistence } from './types'

/**
 * Flush the VFS snapshot to persistence after a quiet period. Also flushes
 * when the tab is hidden or closing, the last realistic save points before
 * the user walks away for a week.
 */
export function startAutoSave(vfs: Vfs, persistence: VfsPersistence, delayMs = 400): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function flush() {
    if (!stopped) void persistence.save(vfs.snapshot())
  }

  const unwatch = vfs.watch(() => {
    if (stopped) return
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
