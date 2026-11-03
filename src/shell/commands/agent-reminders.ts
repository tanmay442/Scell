import type { Vfs } from '../../vfs/types'

/**
 * Promised follow-ups (Hermes-style): "remind me in 20m", "report back
 * tomorrow at 9". The agent stores the promise here; the server ticker
 * delivers due reminders to the bound Telegram chat, the UI lists them
 * in the status dock. One-shot by default: firing deletes the entry, so
 * a reminder can never nag twice. Repeat schedules are explicit only.
 */
export const REMINDERS_PATH = '/home/user/.cell/reminders.json'
const MAX_TEXT_CHARS = 500
const MAX_FUTURE_MS = 7 * 24 * 3600 * 1000
const MAX_REMINDERS = 50

export interface Reminder {
  id: string
  text: string
  runAt: string
  chatId: string | null
  threadId: string | null
  createdAt: string
}

function rid(): string {
  const bytes = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `rem-${Date.now().toString(36)}-${bytes}`
}

export function loadReminders(vfs: Vfs): Reminder[] {
  let raw: string | null = null
  try {
    raw = vfs.read(REMINDERS_PATH)
  } catch {
    return []
  }
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as { reminders?: unknown }
    if (!Array.isArray(parsed.reminders)) return []
    return parsed.reminders.filter(
      (r): r is Reminder =>
        typeof r === 'object' && r !== null && typeof (r as Reminder).id === 'string' && typeof (r as Reminder).text === 'string' && typeof (r as Reminder).runAt === 'string',
    )
  } catch {
    return []
  }
}

function saveAll(vfs: Vfs, reminders: Reminder[]): void {
  vfs.write(REMINDERS_PATH, JSON.stringify({ reminders }, null, 2))
}

/** minutes-from-now shorthand plus ISO; returns epoch ms or an error. */
export function parseReminderWhen(when: string, now = Date.now()): { at: number } | { error: string } {
  const clean = when.trim()
  const relative = /^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i.exec(clean)
  if (relative) {
    const n = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const mult = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000
    const at = now + Math.round(n * mult)
    if (at - now > MAX_FUTURE_MS) return { error: `remind: at most 7 days out` }
    return { at }
  }
  const at = Date.parse(clean)
  if (!Number.isFinite(at)) return { error: `remind: could not parse '${when}' — use "in 20m" / "in 2h" / "in 1d" or an ISO datetime` }
  if (at <= now) return { error: 'remind: time is in the past' }
  if (at - now > MAX_FUTURE_MS) return { error: 'remind: at most 7 days out' }
  return { at }
}

export function addReminder(
  vfs: Vfs,
  input: { text: string; when: string; chatId?: string | null; threadId?: string | null },
  now = Date.now(),
): { ok: true; reminder: Reminder } | { error: string } {
  const text = input.text.trim().replace(/\s+/g, ' ')
  if (text === '') return { error: 'remind: empty text — say what to remind about' }
  if (text.length > MAX_TEXT_CHARS) return { error: `remind: text is ${text.length} chars, cap is ${MAX_TEXT_CHARS}` }
  const parsed = parseReminderWhen(input.when, now)
  if ('error' in parsed) return parsed
  const reminders = loadReminders(vfs)
  if (reminders.length >= MAX_REMINDERS) return { error: `remind: ${MAX_REMINDERS} reminders already pending — cancel one first` }
  const reminder: Reminder = {
    id: rid(),
    text,
    runAt: new Date(parsed.at).toISOString(),
    chatId: typeof input.chatId === 'string' ? input.chatId : null,
    threadId: typeof input.threadId === 'string' ? input.threadId : null,
    createdAt: new Date(now).toISOString(),
  }
  reminders.push(reminder)
  saveAll(vfs, reminders)
  return { ok: true, reminder }
}

export function dueReminders(vfs: Vfs, now = Date.now()): Reminder[] {
  return loadReminders(vfs).filter((r) => Date.parse(r.runAt) <= now)
}

/** Firing is delete-on-delivery: a reminder can never nag twice. */
export function deleteReminder(vfs: Vfs, id: string): boolean {
  const reminders = loadReminders(vfs)
  const kept = reminders.filter((r) => r.id !== id)
  if (kept.length === reminders.length) return false
  saveAll(vfs, kept)
  return true
}
