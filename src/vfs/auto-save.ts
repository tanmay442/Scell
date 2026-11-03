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
 *
 * Saves are awaited with bounded retry (P0-8): the dirty sets are snapshotted
 * before the await so edits landing mid-save are not lost, and a failed save
 * re-queues its paths and reports through `onError` (wired to the status bus
 * in main.tsx) instead of vanishing silently.
 */

export interface AutoSaveOpts {
  /** status-bus signal on persistent failure (default: silent, tests) */
  onError?: (message: string) => void
  /** attempts per flush before reporting (default 3) */
  maxAttempts?: number
}

const RETRY_DELAYS = [200, 800]

export function startAutoSave(
  vfs: Vfs,
  persistence: VfsPersistence,
  delayMs = 400,
  opts: AutoSaveOpts = {},
): () => void {
  // DOM-gated: tab-close/tab-hide flush is browser-only. A Workers caller
  // gets timer persistence only (no crash — feature-detect, don't assume).
  const doc = typeof document === 'undefined' ? null : document
  const win = typeof window === 'undefined' ? null : window
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let flushing = false
  let reflush = false
  const dirty = new Set<string>()
  const deleted = new Set<string>()
  const known = new Set<string>(vfs.listAllFiles())
  const maxAttempts = opts.maxAttempts ?? 3

  const schedule = (ms = delayMs) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flushAsync(), ms)
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

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  async function flushAsync(): Promise<void> {
    if (stopped || flushing) {
      // a flush is already awaiting the backend — run again after it so
      // edits landing mid-save are not left dirty forever
      if (flushing) reflush = true
      return
    }
    if (persistence.saveChanges && dirty.size === 0 && deleted.size === 0) return
    flushing = true
    try {
      if (persistence.saveChanges) {
        // snapshot before the await: edits landing mid-save stay dirty
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
        const attemptPaths = [...dirty]
        const attemptDeletes = [...deleted]
        dirty.clear()
        deleted.clear()
        let lastError: unknown = null
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await persistence.saveChanges(upserts, removes)
            lastError = null
            break
          } catch (err) {
            lastError = err
            if (attempt < maxAttempts) await sleep(RETRY_DELAYS[attempt - 1] ?? 800)
          }
        }
        if (lastError !== null) {
          // re-queue so the next event (or the delayed retry) picks it up
          for (const path of attemptPaths) dirty.add(path)
          for (const path of attemptDeletes) deleted.add(path)
          opts.onError?.(
            `autosave failed after ${maxAttempts} attempts — ${attemptPaths.length + attemptDeletes.length} change(s) still dirty (${lastError instanceof Error ? lastError.message : String(lastError)})`,
          )
          schedule(2000)
        }
      } else {
        const snapshot = vfs.snapshot()
        let lastError: unknown = null
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await persistence.save(snapshot)
            lastError = null
            break
          } catch (err) {
            lastError = err
            if (attempt < maxAttempts) await sleep(RETRY_DELAYS[attempt - 1] ?? 800)
          }
        }
        if (lastError !== null) {
          opts.onError?.(
            `autosave failed after ${maxAttempts} attempts (${lastError instanceof Error ? lastError.message : String(lastError)})`,
          )
          schedule(2000)
        }
      }
    } finally {
      flushing = false
      if (reflush) {
        reflush = false
        schedule()
      }
    }
  }

  // legacy sync entry: page-hide/leave handlers cannot await — one attempt,
  // best effort, never throws
  function flush() {
    if (stopped || flushing) return
    try {
      if (persistence.saveChanges && (dirty.size > 0 || deleted.size > 0)) {
        const upserts: VfsFileMap = {}
        for (const path of dirty) {
          if (path === '/') continue
          let content: string | Uint8Array | null = null
          try {
            content = vfs.read(path) ?? vfs.readBytes(path)
          } catch {
            continue
          }
          if (content !== null) upserts[path] = content
        }
        const removes = [...deleted]
        dirty.clear()
        deleted.clear()
        void persistence.saveChanges(upserts, removes).catch((err: unknown) => {
          for (const path of Object.keys(upserts)) dirty.add(path)
          for (const path of removes) deleted.add(path)
          opts.onError?.(
            `autosave failed (${err instanceof Error ? err.message : String(err)}) — will retry`,
          )
        })
        return
      }
      if (!persistence.saveChanges) void persistence.save(vfs.snapshot()).catch(() => {})
    } catch {
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
    if (doc !== null && doc.visibilityState === 'hidden') flush()
  }
  // beforeunload visibility is unreliable — flush outright on the way out
  const onLeaving = () => flush()
  if (doc !== null) doc.addEventListener('visibilitychange', onHidden)
  if (win !== null) win.addEventListener('beforeunload', onLeaving)

  return () => {
    unwatch()
    if (doc !== null) doc.removeEventListener('visibilitychange', onHidden)
    if (win !== null) win.removeEventListener('beforeunload', onLeaving)
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
