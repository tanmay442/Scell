/**
 * Paths agent-originated code must never touch directly: the whole
 * ~/.cell tree (keys, live sessions, tool/skill/command registries,
 * storage/env secrets). Every legitimate need has a sanctioned channel —
 * load_skill for skills, the panel config form, `cell agent --resume` for
 * sessions — so the model loses nothing by having the prefix closed.
 *
 * One deliberate exception: ~/.cell/jobs/ (per-job status JSON + .log
 * files) is READABLE through file tools. Job tables are in-memory per run
 * (Unix semantics: the table dies with the run), so a resumed run could
 * otherwise never see what its predecessor's jobs produced. Logs are
 * redacted on write and the transcript already carries every command, so
 * readability adds no new exposure. Writes stay refused.
 */

export const PROTECTED_PREFIX = '/home/user/.cell'

/** Job logs/status live here; readable so resumed runs can follow up. */
export const JOBS_PUBLIC_PREFIX = '/home/user/.cell/jobs'

/** True when an absolute, normalized path is a job status/log file. */
export function isJobLogPath(normalizedAbsPath: string): boolean {
  return normalizedAbsPath === JOBS_PUBLIC_PREFIX || normalizedAbsPath.startsWith(`${JOBS_PUBLIC_PREFIX}/`)
}

/** True when an absolute, normalized path is ~/.cell or under it. */
export function isProtectedPath(normalizedAbsPath: string): boolean {
  return normalizedAbsPath === PROTECTED_PREFIX || normalizedAbsPath.startsWith(`${PROTECTED_PREFIX}/`)
}

/** Readable but never writable from agent contexts: files a shell
 * auto-executes. ~/.bashrc is sourced by EVERY shell (including the
 * human's unprotected terminal), so an agent-written .bashrc is a
 * persistence + exfiltration channel even though reads are harmless. */
const WRITE_PROTECTED_PATHS = ['/home/user/.bashrc']

/** True when an absolute, normalized path may be read but not written. */
export function isWriteProtectedPath(normalizedAbsPath: string): boolean {
  return WRITE_PROTECTED_PATHS.includes(normalizedAbsPath)
}

/** True when a child name inside a directory listing must be hidden. */
export function isProtectedChild(parentNormalized: string, childName: string): boolean {
  return isProtectedPath(parentNormalized === '/' ? `/${childName}` : `${parentNormalized}/${childName}`)
}
