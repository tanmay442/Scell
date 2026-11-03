import { describe, expect, it, vi } from 'vitest'
import { createVfs } from '../src/vfs'
import {
  JOB_QUEUE_PATH,
  cancelJob,
  dueJobs,
  listJobs,
  markDone,
  noteAttempt,
  scheduleJob,
} from './jobs'
import { startJobTicker } from './ticker'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('jobs', () => {
  it('schedule/list/cancel roundtrip', () => {
    const vfs = createVfs()
    const job = scheduleJob(vfs, {
      threadId: 'thread-1',
      prompt: 'continue working',
      runAt: Date.now(),
      kind: 'continue',
    })
    expect(job.id).toMatch(/^job-[0-9a-z]+-[0-9a-z]{6}$/)
    expect(job.status).toBe('pending')

    const listed = listJobs(vfs)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: job.id, threadId: 'thread-1', kind: 'continue' })

    expect(cancelJob(vfs, job.id)).toBe(true)
    expect(listJobs(vfs)[0]?.status).toBe('cancelled')
    expect(cancelJob(vfs, 'job-does-not-exist')).toBe(false)
  })

  it('tolerates a corrupt queue file and overwrites it on next write', () => {
    const vfs = createVfs()
    vfs.write(JOB_QUEUE_PATH, 'not json {{{')
    expect(listJobs(vfs)).toEqual([])
    expect(dueJobs(vfs)).toEqual([])
    expect(cancelJob(vfs, 'job-anything')).toBe(false)

    scheduleJob(vfs, { threadId: 't', prompt: 'p', runAt: Date.now(), kind: 'snapshot' })
    expect(listJobs(vfs)).toHaveLength(1)
  })

  it('dueJobs boundary: past is due, future is not, done/cancelled are not', () => {
    const vfs = createVfs()
    const now = Date.now()
    const past = scheduleJob(vfs, { threadId: 't', prompt: 'past', runAt: now - 1000, kind: 'continue' })
    const future = scheduleJob(vfs, {
      threadId: 't',
      prompt: 'future',
      runAt: now + 60_000,
      kind: 'continue',
    })
    const finished = scheduleJob(vfs, {
      threadId: 't',
      prompt: 'finished',
      runAt: now - 1000,
      kind: 'continue',
    })
    markDone(vfs, finished.id)

    const due = dueJobs(vfs, now)
    expect(due.map((job) => job.id)).toEqual([past.id])
    expect(dueJobs(vfs, now).some((job) => job.id === future.id)).toBe(false)
  })

  it('flips jobs to dead at the attempts cap instead of hiding them', () => {
    const vfs = createVfs()
    const job = scheduleJob(vfs, {
      threadId: 't',
      prompt: 'flaky',
      runAt: Date.now() - 1000,
      kind: 'continue',
    })
    expect(dueJobs(vfs)).toHaveLength(1)
    for (let i = 0; i < 4; i++) noteAttempt(vfs, job.id)
    expect(listJobs(vfs)[0]?.status).toBe('pending')
    noteAttempt(vfs, job.id)
    expect(dueJobs(vfs)).toEqual([])
    expect(listJobs(vfs)[0]).toMatchObject({ status: 'dead', attempts: 5 })
  })

  it('refuses poison job specs', () => {
    const vfs = createVfs()
    expect(() => scheduleJob(vfs, { threadId: '..', prompt: 'x', runAt: 1, kind: 'continue' })).toThrow()
    expect(() => scheduleJob(vfs, { threadId: 't', prompt: 'x', runAt: Infinity, kind: 'continue' })).toThrow()
    expect(() => scheduleJob(vfs, { threadId: 't', prompt: 'x', runAt: 1, kind: 'delete-everything' as 'continue' })).toThrow()
    expect(listJobs(vfs)).toEqual([])
  })

  it('ticker fires a due job exactly once and stop() halts it', async () => {
    const vfs = createVfs()
    const seen: string[] = []
    scheduleJob(vfs, { threadId: 't1', prompt: 'now', runAt: Date.now(), kind: 'continue' })

    const stop = startJobTicker({
      vfs,
      intervalMs: 10,
      onDue: async (job) => {
        seen.push(job.id)
      },
    })
    await sleep(100)
    expect(seen).toHaveLength(1)
    expect(listJobs(vfs)[0]?.status).toBe('done')
    stop()

    const countAfterStop = seen.length
    scheduleJob(vfs, { threadId: 't2', prompt: 'later', runAt: Date.now(), kind: 'snapshot' })
    await sleep(60)
    expect(seen).toHaveLength(countAfterStop)
  })

  it('ticker leaves a failed job pending, reports via onError, and retries', async () => {
    const vfs = createVfs()
    const onError = vi.fn()
    let calls = 0
    scheduleJob(vfs, { threadId: 't', prompt: 'retry me', runAt: Date.now(), kind: 'continue' })

    const stop = startJobTicker({
      vfs,
      intervalMs: 10,
      onDue: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
      },
      onError,
    })
    await sleep(100)
    stop()

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(listJobs(vfs)[0]).toMatchObject({ status: 'done', attempts: 1 })
  })
})

describe('ticker timeouts', () => {
  it('a hanging job does not wedge the queue when jobTimeoutMs is set', async () => {
    const { createVfs } = await import('../src/vfs/vfs')
    const { startJobTicker } = await import('./ticker')
    const vfs = createVfs()
    const { scheduleJob, listJobs } = await import('./jobs')
    const order: string[] = []
    scheduleJob(vfs, { threadId: 'hang', prompt: 'hang', runAt: Date.now(), kind: 'continue' })
    scheduleJob(vfs, { threadId: 'quick', prompt: 'quick', runAt: Date.now(), kind: 'continue' })
    const stop = startJobTicker({
      vfs,
      intervalMs: 10,
      jobTimeoutMs: 30,
      onDue: async (job) => {
        if (job.threadId === 'hang') await new Promise(() => {})
        order.push(job.threadId)
      },
    })
    await sleep(300)
    stop()
    // the hanging job timed out (attempt recorded) and the other ran
    expect(order).toContain('quick')
    expect(listJobs(vfs).find((job) => job.threadId === 'hang')?.attempts ?? 0).toBeGreaterThan(0)
  })
})
