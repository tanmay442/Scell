import type { Vfs } from '../src/vfs/types'
import { dueJobs, markDone, noteAttempt, type JobSpec } from './jobs'

export interface JobTickerOptions {
  vfs: Vfs
  intervalMs: number
  onDue: (job: JobSpec) => Promise<void>
  onError?: (err: unknown, job: JobSpec) => void
}

export function startJobTicker(opts: JobTickerOptions): () => void {
  const { vfs, intervalMs, onDue, onError } = opts
  let stopped = false
  let chain: Promise<void> = Promise.resolve()

  async function pollOnce(): Promise<void> {
    if (stopped) return
    const due = dueJobs(vfs)
    for (const job of due) {
      if (stopped) return
      try {
        await onDue(job)
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

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
