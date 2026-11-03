import type { Vfs } from '../src/vfs/types'
import { deleteReminder, dueReminders, noteFailedDelivery } from '../src/shell/commands/agent-reminders'

/**
 * Telegram connector: the one global bot on a second surface. Long-poll
 * getUpdates → one stable thread per chat (`tg-<chatId>`) → runAgent →
 * chunked sendMessage replies. DMs only, allowlist enforced BEFORE any
 * model call (strangers get silence, not an oracle).
 *
 * Secrets: token from CELL_TELEGRAM_TOKEN or ~/.cell/telegram.json
 * {botToken} (never logged, never committed, never visible to the agent —
 * the agent's scoped VFS plus the .cell deny rules refuse reads of it).
 * An empty allowlist fails closed: the poller refuses to start.
 */
export const TELEGRAM_CONFIG_PATH = '/home/user/.cell/telegram.json'
export const TELEGRAM_STATE_PATH = '/home/user/.cell/telegram-state.json'
const MESSAGE_CHUNK = 4000
const POLL_TIMEOUT_S = 25
const FETCH_TIMEOUT_MS = 40_000
const ERROR_BACKOFF_MS = 5_000

export interface TelegramBotConfig {
  token: string
  allowFrom: number[]
}

export function loadTelegramConfig(
  vfs: Vfs,
  env: Record<string, string | undefined>,
  /** token file content read by the host (server.ts) from OUTSIDE the
   * workspace — the agent's bash can read anything mounted in its shell
   * (`F=…; cat $F` spells around the text scanner), so the token must
   * never live in a workspace file */
  tokenFromFile?: string,
): { config: TelegramBotConfig } | { error: string } | null {
  let token = (env.CELL_TELEGRAM_TOKEN ?? '').trim()
  if (token === '' && typeof tokenFromFile === 'string') token = tokenFromFile.trim()
  let allowFrom: number[] = []
  let fileAllow: number[] | null = null
  let raw: string | null = null
  try {
    raw = vfs.read(TELEGRAM_CONFIG_PATH)
  } catch {
    raw = null
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { botToken?: unknown; allowFrom?: unknown }
      if (typeof parsed.botToken === 'string' && parsed.botToken.trim() !== '') {
        return { error: `telegram: botToken in ${TELEGRAM_CONFIG_PATH} is agent-visible (bash reads it) — move it to CELL_TELEGRAM_TOKEN or CELL_TELEGRAM_TOKEN_FILE outside the workspace` }
      }
      if (Array.isArray(parsed.allowFrom)) {
        fileAllow = parsed.allowFrom.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.trunc(n))
      }
    } catch {
      return { error: `telegram: ${TELEGRAM_CONFIG_PATH} is not valid JSON` }
    }
  }
  const envAllow = (env.CELL_TELEGRAM_ALLOW_FROM ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.trunc(n))
  allowFrom = envAllow.length > 0 ? envAllow : (fileAllow ?? [])
  if (token === '') return null
  if (allowFrom.length === 0) {
    return { error: 'telegram: refusing to start with an empty allowlist — set CELL_TELEGRAM_ALLOW_FROM or allowFrom in ~/.cell/telegram.json' }
  }
  return { config: { token, allowFrom } }
}

/** Stable thread per chat; rotation suffix after /new. */
export function telegramThreadFor(chatId: number, chats: Record<string, string>): string {
  const mapped = chats[String(chatId)]
  if (mapped !== undefined && mapped !== '') return mapped
  return `tg-${chatId}`
}

export interface TelegramCommand {
  command: 'new' | 'status' | 'help'
  arg: string
}

/** /cmd and /cmd@botname forms; unknown /commands fall through as chat text. */
export function parseTelegramCommand(text: string): TelegramCommand | null {
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const command = match[1]
  if (command !== 'new' && command !== 'status' && command !== 'help') return null
  return { command, arg: (match[2] ?? '').trim() }
}

export type TelegramFetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

function defaultFetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }):
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return (globalThis.fetch as typeof fetch)(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

/** Split on newline boundaries so code blocks stay readable. */
export function chunkTelegramMessage(text: string, max = MESSAGE_CHUNK): string[] {
  const clean = text.trim()
  if (clean === '') return ['(no output)']
  if (clean.length <= max) return [clean]
  const chunks: string[] = []
  const lines = clean.split('\n')
  let current = ''
  for (const line of lines) {
    // slice on code points, not UTF-16 units: an odd max must not split
    // a surrogate pair into lone surrogates (renders as U+FFFD)
    const points = Array.from(line)
    if (points.length > max) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < points.length; i += max) chunks.push(points.slice(i, i + max).join(''))
      continue
    }
    if ((current + '\n' + line).length > max && current !== '') {
      chunks.push(current)
      current = line
    } else {
      current = current === '' ? line : `${current}\n${line}`
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

export interface TelegramApi {
  sendMessage(chatId: number, text: string): Promise<void>
  sendTyping(chatId: number): Promise<void>
  getMe(): Promise<{ ok: boolean; username?: string }>
}

export function createTelegramApi(apiBase: string, fetchImpl: TelegramFetch = defaultFetch): TelegramApi {
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`telegram ${method}: HTTP ${res.status}`)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    async sendMessage(chatId, text) {
      for (const chunk of chunkTelegramMessage(text)) {
        await call('sendMessage', { chat_id: chatId, text: chunk })
      }
    },
    async sendTyping(chatId) {
      try {
        await call('sendChatAction', { chat_id: chatId, action: 'typing' })
      } catch {
        // typing is cosmetic — a failure must never break the reply
      }
    },
    async getMe() {
      const res = await call<{ ok: boolean; result?: { username?: string } }>('getMe', {})
      return { ok: res.ok === true, username: res.result?.username }
    },
  }
}

interface TelegramState {
  offset: number
  chats: Record<string, string>
}

function loadState(vfs: Vfs): TelegramState {
  const fallback: TelegramState = { offset: 0, chats: {} }
  let raw: string | null = null
  try {
    raw = vfs.read(TELEGRAM_STATE_PATH)
  } catch {
    return fallback
  }
  if (raw === null) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramState>
    return {
      offset: typeof parsed.offset === 'number' ? parsed.offset : 0,
      chats: typeof parsed.chats === 'object' && parsed.chats !== null ? (parsed.chats as Record<string, string>) : {},
    }
  } catch {
    return fallback
  }
}

function saveState(vfs: Vfs, state: TelegramState): void {
  try {
    vfs.write(TELEGRAM_STATE_PATH, JSON.stringify(state))
  } catch {
    // offset persistence is best-effort; worst case an update redelivers
  }
}

interface TelegramUpdate {
  update_id: number
  message?: {
    chat: { id: number; type: string }
    from?: { id: number }
    text?: string
  }
}

export interface TelegramPollHandlers {
  /** plain chat text → the agent's reply text */
  onText: (chatId: number, text: string, threadId: string) => Promise<string>
  /** /new /status /help */
  onCommand: (chatId: number, command: TelegramCommand, threadId: string) => Promise<string | null>
  log?: (message: string) => void
}

export interface TelegramPoller {
  stop: () => void
  /** messages handled so far (health/debug, no content) */
  handled: () => number
}

/** Long-poll loop. Returns a stopper; the loop never throws outward. */
export function startTelegramPoller(
  vfs: Vfs,
  apiBase: string,
  config: TelegramBotConfig,
  handlers: TelegramPollHandlers,
  fetchImpl: TelegramFetch = defaultFetch,
): TelegramPoller {
  const allowed = new Set(config.allowFrom)
  const state = loadState(vfs)
  const api = createTelegramApi(apiBase, fetchImpl)
  let stopped = false
  let handledCount = 0
  const log = handlers.log ?? (() => {})

  async function pollOnce(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 10) * 1000)
    try {
      const res = await fetchImpl(`${apiBase}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset: state.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`getUpdates: HTTP ${res.status}`)
      const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] }
      if (body.ok !== true || !Array.isArray(body.result)) throw new Error('getUpdates: bad response')
      for (const update of body.result) {
        // one poisoned update must not abort its batch: handle each in
        // isolation, and only advance the offset past well-formed ones
        try {
          await handleUpdate(update)
          if (typeof update.update_id === 'number' && Number.isFinite(update.update_id)) {
            state.offset = Math.max(state.offset, update.update_id + 1)
          }
        } catch (err) {
          log(`telegram: skipping malformed update: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      saveState(vfs, state)
    } finally {
      clearTimeout(timer)
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (!message || message.chat.type !== 'private' || typeof message.text !== 'string') return
    const chatId = message.chat.id
    if (!allowed.has(chatId)) {
      // fail closed and stay silent: no model call, no reply, no oracle
      log(`telegram: ignoring message from non-allowlisted chat ${chatId}`)
      return
    }
    const text = message.text.trim()
    if (text === '') return
    const threadId = telegramThreadFor(chatId, state.chats)
    try {
      await api.sendTyping(chatId)
      const command = parseTelegramCommand(text)
      let reply: string | null
      if (command !== null && command.command === 'new') {
        const fresh = `tg-${chatId}-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
        state.chats[String(chatId)] = fresh
        saveState(vfs, state)
        reply = await handlers.onCommand(chatId, command, fresh)
      } else if (command !== null) {
        reply = await handlers.onCommand(chatId, command, threadId)
      } else {
        reply = await handlers.onText(chatId, text, threadId)
      }
      if (reply !== null) {
        await api.sendMessage(chatId, reply)
        handledCount++
      }
    } catch (err) {
      try {
        await api.sendMessage(chatId, `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000))
      } catch {
        // delivery itself failed — logged below, loop continues
      }
      log(`telegram: handler failed for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  void (async () => {
    while (!stopped) {
      try {
        await pollOnce()
      } catch (err) {
        log(`telegram: poll error: ${err instanceof Error ? err.message : String(err)} — retrying`)
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS))
      }
      // yield to the event loop every iteration: real long-polls block in
      // getUpdates, but a fast/failed poll must never busy-spin microtasks
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()

  return {
    stop: () => {
      stopped = true
    },
    handled: () => handledCount,
  }
}

/** Fire due reminders through Telegram (delete-on-delivery: never nags twice). */
export async function deliverDueReminders(
  vfs: Vfs,
  api: TelegramApi,
  now = Date.now(),
): Promise<{ delivered: number; undeliverable: number }> {
  let delivered = 0
  let undeliverable = 0
  for (const reminder of dueReminders(vfs, now)) {
    if (reminder.chatId === null) {
      undeliverable++
      continue
    }
    try {
      await api.sendMessage(Number(reminder.chatId), `reminder: ${reminder.text}`)
      delivered++
    } catch {
      // retained for retry, but dropped past the cap so one bad chat
      // cannot clog the table (or nag) forever
      undeliverable++
      noteFailedDelivery(vfs, reminder.id)
      continue
    }
    deleteReminder(vfs, reminder.id)
  }
  return { delivered, undeliverable }
}
