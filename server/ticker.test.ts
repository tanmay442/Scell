import { describe, expect, it, vi } from 'vitest'
import { createVfs } from '../src/vfs'
import { listJobs, scheduleJob } from './jobs'
import { startJobTicker, JobBusyError } from './ticker'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ticker busy + in-flight semantics', () => {
  it('does not count an attempt when the thread is busy', async () => {
    const vfs = createVfs()
    const job = scheduleJob(vfs, { threadId: 't-busy', prompt: 'p', runAt: Date.now() - 1000, kind: 'continue' })
    const onError = vi.fn()
    const stop = startJobTicker({
      vfs,
      intervalMs: 20,
      onDue: async () => {
        throw new JobBusyError(job.id, job.threadId)
      },
      onError,
    })
    await sleep(120)
    stop()
    const after = listJobs(vfs).find((j) => j.id === job.id)!
    expect(after.status).toBe('pending')
    expect(after.attempts ?? 0).toBe(0)
    expect(onError).toHaveBeenCalled()
  })

  it('never runs the same job concurrently; retries resume after settle', async () => {
    const vfs = createVfs()
    const job = scheduleJob(vfs, { threadId: 't-slow', prompt: 'p', runAt: Date.now() - 1000, kind: 'continue' })
    let runs = 0
    let active = 0
    let maxActive = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const stop = startJobTicker({
      vfs,
      intervalMs: 20,
      jobTimeoutMs: 60,
      onDue: async () => {
        runs++
        active++
        maxActive = Math.max(maxActive, active)
        await gate
        active--
      },
    })
    // while the first run hangs past the timeout, no parallel duplicate
    await sleep(150)
    expect(runs).toBe(1)
    expect(maxActive).toBe(1)
    release()
    await sleep(100)
    stop()
    // the retry after settle is sequential, never overlapping
    expect(maxActive).toBe(1)
    const after = listJobs(vfs).find((j) => j.id === job.id)!
    // one counted attempt (the timeout); the post-release retry runs clean
    expect(after.attempts ?? 0).toBe(1)
  })
})
