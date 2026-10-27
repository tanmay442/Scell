import type { EventBus } from './events'
import type { Vfs } from './vfs/types'

/**
 * Process-wide service locator, initialized once at boot in main.tsx:
 *
 *   persistence.load() -> vfs.restore(saved) or seedStarterProject(vfs)
 *   -> initPlatform({ vfs, bus }) -> render(<App />)
 *
 * Deliberately tiny so the exact same code runs on any single JS isolate
 * (browser tab today, Cloudflare Worker-shaped runtime later).
 */
export interface Platform {
  vfs: Vfs
  bus: EventBus
}

let instance: Platform | null = null

export function initPlatform(p: Platform): void {
  if (instance) throw new Error('platform already initialized')
  instance = p
}

export function platform(): Platform {
  if (!instance) throw new Error('platform not initialized — call initPlatform() in main.tsx first')
  return instance
}
