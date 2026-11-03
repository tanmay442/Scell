export interface RateLimiterOptions {
  windowMs: number
  max: number
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number }

export type RateLimiter = (id: string, now?: number) => RateLimitResult

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max } = options
  const buckets = new Map<string, { start: number; count: number }>()
  return (id: string, now?: number): RateLimitResult => {
    const at = now ?? Date.now()
    const bucket = buckets.get(id)
    if (!bucket || at - bucket.start >= windowMs) {
      buckets.set(id, { start: at, count: 1 })
      return { ok: true }
    }
    if (bucket.count < max) {
      bucket.count += 1
      return { ok: true }
    }
    return { ok: false, retryAfterMs: bucket.start + windowMs - at }
  }
}
