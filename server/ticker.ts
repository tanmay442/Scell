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

/** Raised when a job's thread is busy: retry later WITHOUT counting an
 * attempt (contention is not failure). Exported for tests. */
export class JobBusyError extends Error {
  constructor(jobId: string, threadId: string) {
    super(`job ${jobId}: thread ${threadId} busy — retrying next tick`)
    this.name = 'JobBusyError'
  }
}

export function startJobTicker(opts: JobTickerOptions): () => void {
  const { vfs, intervalMs, onDue, onError, jobTimeoutMs } = opts
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  // in-flight set: a timed-out onDue keeps running while the router slot
  // frees — refiring it immediately would run duplicates and burn all
  // attempts during healthy overrun. Skip (don't refire, don't count).
  const inFlight = new Set<string>()

  // NOTE: stop() prevents future polls but never cancels an in-flight
  // onDue — its completion (or failure) still lands normally.
  async function pollOnce(): Promise<void> {
    if (stopped) return
    const due = dueJobs(vfs).filter((job) => !inFlight.has(job.id))
    for (const job of due) {
      if (stopped) return
      // the entry leaves inFlight ONLY when onDue itself settles: a
      // timeout wins the race below but the work keeps running, and
      // deleting on race-settle would refire duplicates every tick
      inFlight.add(job.id)
      let tracked: Promise<void>
      try {
        // starts the work immediately (same as before); the delete
        // handlers below own the in-flight entry from here on
        tracked = onDue(job)
        tracked.then(
          () => inFlight.delete(job.id),
          () => inFlight.delete(job.id),
        )
      } catch (err) {
        // synchronous throw from onDue itself: not started, not in flight
        inFlight.delete(job.id)
        if (!(err instanceof JobBusyError)) {
          noteAttempt(vfs, job.id)
        }
        try {
          onError?.(err, job)
        } catch {
          // error reporter must never break the ticker chain
        }
        continue
      }
      try {
        if (jobTimeoutMs === undefined) {
          await tracked
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              tracked,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`job ${job.id} timed out after ${jobTimeoutMs}ms`)), jobTimeoutMs)
              }),
            ])
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        }
      } catch (err) {
        // a busy thread is contention, not failure: retry later without
        // burning an attempt. A timeout means the run was actually
        // killed, so it still counts (at most one wasted attempt per
        // healthy overrun, then the retry resumes and finishes).
        if (!(err instanceof JobBusyError)) {
          noteAttempt(vfs, job.id)
        }
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
