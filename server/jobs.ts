import type { Vfs } from '../src/vfs/types'

export type JobKind = 'continue' | 'snapshot'
export type JobStatus = 'pending' | 'done' | 'cancelled'

export interface JobSpec {
  id: string
  threadId: string
  prompt: string
  /** epoch ms when the job becomes eligible to run */
  runAt: number
  kind: JobKind
  createdAt: number
  status: JobStatus
  /** failed attempts so far; jobs with attempts >= MAX_ATTEMPTS stop being due */
  attempts?: number
}

export const JOB_QUEUE_PATH = '/home/user/.cell/job-queue.json'
export const MAX_ATTEMPTS = 5

function makeId(now: number): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `job-${now.toString(36)}-${rand}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeJob(value: unknown): JobSpec | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id === '') return null
  if (typeof value.threadId !== 'string') return null
  if (typeof value.prompt !== 'string') return null
  if (typeof value.runAt !== 'number' || Number.isNaN(value.runAt)) return null
  const kind: JobKind = value.kind === 'snapshot' ? 'snapshot' : 'continue'
  const status: JobStatus =
    value.status === 'done' || value.status === 'cancelled' ? value.status : 'pending'
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0
  const attempts =
    typeof value.attempts === 'number' && value.attempts >= 0 ? Math.floor(value.attempts) : 0
  return {
    id: value.id,
    threadId: value.threadId,
    prompt: value.prompt,
    runAt: value.runAt,
    kind,
    createdAt,
    status,
    attempts,
  }
}

function readJobs(vfs: Vfs): JobSpec[] {
  try {
    const raw = vfs.read(JOB_QUEUE_PATH)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const jobs: JobSpec[] = []
    for (const entry of parsed) {
      const job = normalizeJob(entry)
      if (job !== null) jobs.push(job)
    }
    return jobs
  } catch {
    return []
  }
}

function writeJobs(vfs: Vfs, jobs: JobSpec[]): void {
  vfs.write(JOB_QUEUE_PATH, JSON.stringify(jobs))
}

export function scheduleJob(
  vfs: Vfs,
  spec: Omit<JobSpec, 'id' | 'createdAt' | 'status'> & { id?: string },
): JobSpec {
  try {
    const jobs = readJobs(vfs)
    const now = Date.now()
    const job: JobSpec = {
      threadId: spec.threadId,
      prompt: spec.prompt,
      runAt: spec.runAt,
      kind: spec.kind === 'snapshot' ? 'snapshot' : 'continue',
      id: spec.id ?? makeId(now),
      createdAt: now,
      status: 'pending',
      attempts: typeof spec.attempts === 'number' && spec.attempts >= 0 ? Math.floor(spec.attempts) : 0,
    }
    jobs.push(job)
    writeJobs(vfs, jobs)
    return job
  } catch {
    const now = Date.now()
    return {
      threadId: spec.threadId,
      prompt: spec.prompt,
      runAt: spec.runAt,
      kind: spec.kind === 'snapshot' ? 'snapshot' : 'continue',
      id: spec.id ?? makeId(now),
      createdAt: now,
      status: 'pending',
      attempts: 0,
    }
  }
}

export function cancelJob(vfs: Vfs, id: string): boolean {
  try {
    const jobs = readJobs(vfs)
    const job = jobs.find((entry) => entry.id === id)
    if (!job || job.status !== 'pending') return false
    job.status = 'cancelled'
    writeJobs(vfs, jobs)
    return true
  } catch {
    return false
  }
}

export function listJobs(vfs: Vfs): JobSpec[] {
  return readJobs(vfs)
}

export function dueJobs(vfs: Vfs, now: number = Date.now()): JobSpec[] {
  return readJobs(vfs).filter(
    (job) => job.status === 'pending' && job.runAt <= now && (job.attempts ?? 0) < MAX_ATTEMPTS,
  )
}

export function markDone(vfs: Vfs, id: string): void {
  try {
    const jobs = readJobs(vfs)
    const job = jobs.find((entry) => entry.id === id)
    if (!job || job.status !== 'pending') return
    job.status = 'done'
    writeJobs(vfs, jobs)
  } catch {
    // corrupt/missing file: nothing to mark; stay silent
  }
}

export function noteAttempt(vfs: Vfs, id: string): void {
  try {
    const jobs = readJobs(vfs)
    const job = jobs.find((entry) => entry.id === id)
    if (!job) return
    job.attempts = (job.attempts ?? 0) + 1
    writeJobs(vfs, jobs)
  } catch {
    // corrupt/missing file: nothing to record; stay silent
  }
}
