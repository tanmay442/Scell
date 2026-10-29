/**
 * Paths agent-originated code must never touch directly: the whole
 * ~/.cell tree (keys, live sessions, tool/skill/command registries, job
 * logs, storage/env secrets). Every legitimate need has a sanctioned
 * channel — load_skill for skills, job_poll for job logs, the panel
 * config form, `cell agent --resume` for sessions — so the model loses
 * nothing by having the whole prefix closed.
 */

export const PROTECTED_PREFIX = '/home/user/.cell'

/** True when an absolute, normalized path is ~/.cell or under it. */
export function isProtectedPath(normalizedAbsPath: string): boolean {
  return normalizedAbsPath === PROTECTED_PREFIX || normalizedAbsPath.startsWith(`${PROTECTED_PREFIX}/`)
}

/** True when a child name inside a directory listing must be hidden. */
export function isProtectedChild(parentNormalized: string, childName: string): boolean {
  return isProtectedPath(parentNormalized === '/' ? `/${childName}` : `${parentNormalized}/${childName}`)
}
