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

export type ThreadRunResult<T> = { status: 'ran'; value: T } | { status: 'busy' } | { status: 'timeout' }

export interface ThreadRouter {
  runExclusive<T>(
    threadId: string,
    fn: (ctx: ThreadRunContext) => Promise<T>,
    opts?: { timeoutMs?: number },
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
      opts?: { timeoutMs?: number },
    ): Promise<ThreadRunResult<T>> {
      assertValidThreadId(threadId)
      if (running.has(threadId)) return { status: 'busy' }
      running.add(threadId)
      // the controller exists so a timeout aborts cooperative work
      // (runAgent checks its signal every step); the slot is freed on
      // timeout even if fn ignores the abort and settles later — a stuck
      // fn no longer pins the thread forever, at the cost of a brief
      // overlap window if it keeps running past the abort.
      const controller = new AbortController()
      if (opts?.timeoutMs === undefined) {
        try {
          const value = await fn({ signal: controller.signal })
          return { status: 'ran', value }
        } finally {
          running.delete(threadId)
        }
      }
      let onTimeout!: (err: Error) => void
      const timeout = new Promise<never>((_, reject) => {
        onTimeout = reject
      })
      const timer = setTimeout(() => {
        controller.abort()
        onTimeout(new Error(`thread ${threadId} timed out`))
      }, opts.timeoutMs)
      try {
        const value = await Promise.race([fn({ signal: controller.signal }), timeout])
        return { status: 'ran', value }
      } catch (err) {
        if (err instanceof Error && err.message === `thread ${threadId} timed out`) {
          return { status: 'timeout' }
        }
        throw err
      } finally {
        clearTimeout(timer)
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
