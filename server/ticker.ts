import type { Vfs } from '../src/vfs/types'
import { dueJobs, markDone, noteAttempt, type JobSpec } from './jobs'

export interface JobTickerOptions {
  vfs: Vfs
  intervalMs: number
  onDue: (job: JobSpec) => Promise<void>
  onError?: (err: unknown, job: JobSpec) => void
  /** per-job ceiling: a hanging onDue rejects into the noteAttempt path
   * instead of wedging the whole queue behind it. No timeout = wait forever. */
  jobTimeoutMs?: number
}

export function startJobTicker(opts: JobTickerOptions): () => void {
  const { vfs, intervalMs, onDue, onError, jobTimeoutMs } = opts
  let stopped = false
  let chain: Promise<void> = Promise.resolve()

  // NOTE: stop() prevents future polls but never cancels an in-flight
  // onDue — its completion (or failure) still lands normally.
  async function pollOnce(): Promise<void> {
    if (stopped) return
    const due = dueJobs(vfs)
    for (const job of due) {
      if (stopped) return
      try {
        if (jobTimeoutMs === undefined) {
          await onDue(job)
        } else {
          let rejectTimeout!: (err: Error) => void
          const timeout = new Promise<never>((_, reject) => {
            rejectTimeout = reject
          })
          const timer = setTimeout(
            () => rejectTimeout(new Error(`job ${job.id} timed out after ${jobTimeoutMs}ms`)),
            jobTimeoutMs,
          )
          try {
            await Promise.race([onDue(job), timeout])
          } finally {
            clearTimeout(timer)
          }
        }
      } catch (err) {
        noteAttempt(vfs, job.id)
        try {
          onError?.(err, job)
        } catch {
          // error reporter must never break the ticker chain
        }
        continue
      }
      markDone(vfs, job.id)
    }
  }

  const timer = setInterval(() => {
    chain = chain.then(pollOnce, pollOnce)
  }, intervalMs)
  const maybeUnref = timer as unknown as { unref?: () => void }
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref()

  // stop() prevents future polls but never cancels an in-flight onDue:
  // its completion (or failure) still lands normally.
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
