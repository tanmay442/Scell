import { isValidThreadId } from './bindings'

/**
 * Per-thread actor router for the headless agent server.
 *
 * `server/server.ts` runs `runAgent` per `POST /run` with no serialization —
 * two concurrent POSTs for the same thread would both write the same session
 * file. This router serializes runs per thread id: at most one `fn` per
 * threadId runs at a time, and a second caller gets `{ status: 'busy' }`
 * immediately (no queueing — HTTP maps it to 409). Different threadIds run
 * concurrently.
 *
 * Abort scope (v1): each run gets a fresh `AbortController` whose signal is
 * passed to `fn` as `ctx.signal`. The router never aborts it — there is no
 * cross-run abort. Stop-during-run (one request cancelling another run on the
 * same thread) is out of scope; the caller wires client disconnect to its own
 * abort and passes that signal to `runAgent` instead.
 *
 * No timers: v1 holds no timeouts, so there is nothing to clean up.
 */

export interface ThreadRunContext {
  signal: AbortSignal
}

export type ThreadRunResult<T> = { status: 'ran'; value: T } | { status: 'busy' }

export interface ThreadRouter {
  runExclusive<T>(
    threadId: string,
    fn: (ctx: ThreadRunContext) => Promise<T>,
  ): Promise<ThreadRunResult<T>>
  isBusy(threadId: string): boolean
  busyIds(): string[]
}

function assertValidThreadId(threadId: string): void {
  if (typeof threadId !== 'string' || !isValidThreadId(threadId)) {
    throw new Error(`bad thread id '${threadId}' — use the bare session/thread stem`)
  }
}

export function createThreadRouter(): ThreadRouter {
  const running = new Set<string>()

  return {
    async runExclusive<T>(
      threadId: string,
      fn: (ctx: ThreadRunContext) => Promise<T>,
    ): Promise<ThreadRunResult<T>> {
      assertValidThreadId(threadId)
      if (running.has(threadId)) return { status: 'busy' }
      running.add(threadId)
      const controller = new AbortController()
      try {
        const value = await fn({ signal: controller.signal })
        return { status: 'ran', value }
      } finally {
        running.delete(threadId)
      }
    },

    isBusy(threadId: string): boolean {
      assertValidThreadId(threadId)
      return running.has(threadId)
    },

    busyIds(): string[] {
      return [...running]
    },
  }
}
