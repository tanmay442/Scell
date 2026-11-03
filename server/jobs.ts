import type { Vfs } from '../src/vfs/types'
import { isValidThreadId } from './bindings'

/** 'task' = a fresh worker run (no session to resume) that reports back;
 * 'continue' = resume the thread's session; 'snapshot' = push a snapshot */
export type JobKind = 'continue' | 'snapshot' | 'task'
export type JobStatus = 'pending' | 'done' | 'cancelled' | 'dead'

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
  /** chat notification already delivered: retries after a crash must not
   * re-send "done" (set only after the send succeeds) */
  notified?: boolean
  /** Telegram chat to notify with the result + deliverables on completion.
   * Absent = silent (log only). Digits only — validated at schedule time. */
  notifyChatId?: string
  /** Thread that spawned the worker: the completion is appended to its
   * session transcript too, so the main thread sees what finished. */
  originThreadId?: string
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
  const kind: JobKind = value.kind === 'snapshot' ? 'snapshot' : value.kind === 'task' ? 'task' : 'continue'
  const notifyChatId =
    typeof value.notifyChatId === 'string' && /^\d+$/.test(value.notifyChatId) ? value.notifyChatId : undefined
  const originThreadId =
    typeof value.originThreadId === 'string' && isValidThreadId(value.originThreadId) ? value.originThreadId : undefined
  const status: JobStatus =
    value.status === 'done' || value.status === 'cancelled' || value.status === 'dead' ? value.status : 'pending'
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0
  const attempts = typeof value.attempts === 'number' && value.attempts >= 0 ? Math.floor(value.attempts) : 0
  const notified = value.notified === true
  return {
    id: value.id,
    threadId: value.threadId,
    prompt: value.prompt,
    runAt: value.runAt,
    kind,
    createdAt,
    status,
    attempts,
    ...(notifyChatId !== undefined ? { notifyChatId } : {}),
    ...(originThreadId !== undefined ? { originThreadId } : {}),
    ...(notified ? { notified: true } : {}),
  }
}

/** Exactly-once chat delivery: set only after the send succeeds, so a
 * crash between delivery and markDone never re-sends "done". */
export function markNotified(vfs: Vfs, id: string): void {
  try {
    const jobs = readJobs(vfs)
    const job = jobs.find((j) => j.id === id)
    if (job === undefined) return
    job.notified = true
    writeJobs(vfs, jobs)
  } catch {
    // advisory only — worst case is a duplicate delivery, still rare
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

/** terminal rows older than the newest 200 are dropped on write: the
 * queue file is read-modify-written on every op, so history cannot grow
 * without bound. GET /jobs stays small; dead jobs remain visible until
 * they age out of the window. */
const TERMINAL_HISTORY = 200
function writeJobs(vfs: Vfs, jobs: JobSpec[]): void {
  const pending = jobs.filter((job) => job.status === 'pending')
  const terminal = jobs
    .filter((job) => job.status !== 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TERMINAL_HISTORY)
  vfs.write(JOB_QUEUE_PATH, JSON.stringify([...pending, ...terminal]))
}

export function scheduleJob(
  vfs: Vfs,
  spec: Omit<JobSpec, 'id' | 'createdAt' | 'status'> & { id?: string },
): JobSpec {
  if (typeof spec.threadId !== 'string' || !isValidThreadId(spec.threadId)) {
    throw new Error(`refused: threadId must be a bare session/thread stem, got '${String(spec.threadId)}'`)
  }
  if (typeof spec.runAt !== 'number' || !Number.isFinite(spec.runAt) || spec.runAt <= 0) {
    throw new Error('refused: runAt must be finite epoch ms')
  }
  if (spec.kind !== 'continue' && spec.kind !== 'snapshot' && spec.kind !== 'task') {
    throw new Error(`refused: unknown job kind '${String(spec.kind)}'`)
  }
  if (spec.notifyChatId !== undefined && !/^\d+$/.test(spec.notifyChatId)) {
    throw new Error('refused: notifyChatId must be a numeric chat id')
  }
  if (spec.originThreadId !== undefined && !isValidThreadId(spec.originThreadId)) {
    throw new Error('refused: originThreadId must be a bare session/thread stem')
  }
  try {
    const jobs = readJobs(vfs)
    const now = Date.now()
    const job: JobSpec = {
      threadId: spec.threadId,
      prompt: spec.prompt,
      runAt: spec.runAt,
      kind: spec.kind,
      ...(spec.notifyChatId !== undefined ? { notifyChatId: spec.notifyChatId } : {}),
      ...(spec.originThreadId !== undefined ? { originThreadId: spec.originThreadId } : {}),
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
      kind: spec.kind,
      ...(spec.notifyChatId !== undefined ? { notifyChatId: spec.notifyChatId } : {}),
      ...(spec.originThreadId !== undefined ? { originThreadId: spec.originThreadId } : {}),
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
    if (!job || job.status !== 'pending') return
    job.attempts = (job.attempts ?? 0) + 1
    // attempts are capped, not silent: at the cap the job flips to `dead`
    // so GET /jobs shows a row that will never run instead of a healthy
    // looking `pending` job. Dead jobs are terminal (cancel/complete ignore
    // them) — reschedule explicitly if the work still matters.
    if (job.attempts >= MAX_ATTEMPTS) job.status = 'dead'
    writeJobs(vfs, jobs)
  } catch {
    // corrupt/missing file: nothing to record; stay silent
  }
}
