import type { Vfs } from '../src/vfs/types'
import { createDiskVfs } from './disk-vfs'
import { threadVfsPath } from './bindings'
import { scheduleJob } from './jobs'

/**
 * Background worker spawner (Telegram triage -> worker threads). Pure
 * function of vfs + ids: own thread dir, 'task' job, notifyChatId +
 * originThreadId so the worker reports back to the chat AND the origin
 * thread transcript. Kept out of server.ts so tests can import it
 * without booting the HTTP listener.
 */
export interface BackgroundSchedule {
  ok: true
  jobId: string
  threadId: string
}

/** Spawn a background worker thread for a chat: own thread dir, 'task'
 * job, result + deliverables reported back via notifyChatId. Exported
 * for tests (uses only the vfs + job queue). */
export async function scheduleBackgroundTask(
  vfs: Vfs,
  threadId: string,
  chatId: string,
  task: string,
): Promise<BackgroundSchedule | { error: string }> {
  try {
    const worker = `${threadId}-w${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
    vfs.mkdir(threadVfsPath(worker))
    const job = scheduleJob(vfs, {
      threadId: worker,
      prompt: `Background task for chat ${chatId} (origin thread ${threadId}). Brief from the main agent — do exactly this, then report back concisely with the deliverable named:\n\n${task}`,
      runAt: Date.now(),
      kind: 'task',
      notifyChatId: String(chatId),
      originThreadId: threadId,
    })
    return { ok: true, jobId: job.id, threadId: worker }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
