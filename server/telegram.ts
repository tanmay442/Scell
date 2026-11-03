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
/** attachments (and generated files back) cap: the Bot API allows 50MB,
 * staying far under keeps memory and model context sane */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
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
  command: 'new' | 'status' | 'help' | 'brief'
  arg: string
}

/** /cmd and /cmd@botname forms; unknown /commands fall through as chat text. */
export function parseTelegramCommand(text: string): TelegramCommand | null {
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const command = match[1]
  if (command !== 'new' && command !== 'status' && command !== 'help' && command !== 'brief') return null
  return { command: command as TelegramCommand['command'], arg: (match[2] ?? '').trim() }
}

export type TelegramFetch = (url: string, init?: { method?: string; body?: string | FormData; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
}>

/** Files created or updated during a run: the deliverables sent back to
 * the chat (newest first, capped). Skips dotfiles, registries and logs. */
export interface FreshFile {
  path: string
  name: string
  size: number
}

export function collectFreshFiles(
  vfs: Vfs,
  threadDir: string,
  sinceMs: number,
  maxFiles = 5,
  maxBytes = 45 * 1024 * 1024,
): FreshFile[] {
  const fresh: Array<{ path: string; name: string; size: number; mtime: number }> = []
  let all: string[] = []
  try {
    all = vfs.listAllFiles()
  } catch {
    return []
  }
  for (const path of all) {
    if (!path.startsWith(`${threadDir}/`) || path.includes('/.cell/')) continue
    const name = path.split('/').pop() ?? ''
    if (name.startsWith('.')) continue
    let stat
    try {
      stat = vfs.stat(path)
    } catch {
      continue
    }
    if (stat === null || stat.type !== 'file' || stat.mtime < sinceMs) continue
    if (stat.size > maxBytes) continue
    fresh.push({ path, name, size: stat.size, mtime: stat.mtime })
  }
  fresh.sort((a, b) => b.mtime - a.mtime)
  return fresh.slice(0, maxFiles)
}

/** Filenames from chat input: basename only, safe charset, capped. */
export function sanitizeAttachmentName(name: string, fallback: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? ''
  const clean = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
  if (clean === '' || clean === '.' || clean === '..') return fallback
  return clean
}

function defaultFetch(url: string, init?: { method?: string; body?: string | FormData; headers?: Record<string, string>; signal?: AbortSignal }):
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> {
  return (globalThis.fetch as typeof fetch)(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>
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

export interface TelegramAttachmentIn {
  name: string
  mime: string
  bytes: Uint8Array
}

export interface TelegramApi {
  sendMessage(chatId: number, text: string): Promise<void>
  /** generated files go back as photos (images) or documents (the rest) */
  sendFile(chatId: number, name: string, bytes: Uint8Array, mime: string): Promise<void>
  sendTyping(chatId: number): Promise<void>
  getMe(): Promise<{ ok: boolean; username?: string }>
  getFilePath(fileId: string): Promise<string>
  /** raw bytes of an uploaded photo/document, size-capped */
  downloadFile(filePath: string, maxBytes?: number): Promise<Uint8Array>
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
    async sendFile(chatId, name, bytes, mime) {
      const photo = /\.(jpe?g|png|webp|gif)$/i.test(name)
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append(photo ? 'photo' : 'document', new Blob([bytes as unknown as BlobPart], { type: mime }), name)
      if (!photo) form.append('caption', name.slice(0, 200))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 3)
      try {
        const res = await fetchImpl(`${apiBase}/${photo ? 'sendPhoto' : 'sendDocument'}`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`telegram sendFile: HTTP ${res.status}`)
        await res.json().catch(() => null)
      } finally {
        clearTimeout(timer)
      }
    },
    async getFilePath(fileId) {
      const info = await call<{ ok: boolean; result?: { file_path?: string } }>('getFile', { file_id: fileId })
      const path = info.result?.file_path
      if (typeof path !== 'string' || path === '') throw new Error('telegram getFile: no file_path')
      return path
    },
    async downloadFile(filePath, maxBytes = 12 * 1024 * 1024) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 3)
      try {
        const token = apiBase.split('/bot')[1] ?? ''
        const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`, {
          signal: controller.signal,
        })
        if (!res.ok || typeof res.arrayBuffer !== 'function') throw new Error(`telegram download: HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (buf.byteLength > maxBytes) throw new Error(`telegram download: file is ${buf.byteLength} bytes (cap ${maxBytes})`)
        return new Uint8Array(buf)
      } finally {
        clearTimeout(timer)
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

export interface TelegramPhotoSize {
  file_id: string
  file_size?: number
  width: number
  height: number
}

export interface TelegramDocument {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramUpdate {
  update_id: number
  message?: {
    chat: { id: number; type: string }
    from?: { id: number }
    text?: string
    caption?: string
    photo?: TelegramPhotoSize[]
    document?: TelegramDocument
  }
}

export interface TelegramPollHandlers {
  /** chat text (+ downloaded photo/document bytes) → the agent's reply */
  onText: (chatId: number, text: string, threadId: string, attachments: TelegramAttachmentIn[]) => Promise<string>
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

  /** biggest photo size under the byte cap (Telegram sends several) */
  function pickPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | null {
    const sorted = [...sizes].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
    let fallback: TelegramPhotoSize | null = null
    for (const size of sorted) {
      if ((size.file_size ?? 0) > MAX_ATTACHMENT_BYTES) continue
      fallback = size
    }
    return fallback
  }

  /** `typing…` expires after ~10s: re-arm it through long model turns so
   * the chat sees the bot is still working instead of silence */
  function startTypingHeartbeat(chatId: number): () => void {
    let stopped = false
    void (async () => {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 8000))
        if (stopped) return
        try {
          await api.sendTyping(chatId)
        } catch {
          return
        }
      }
    })()
    return () => {
      stopped = true
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (!message || message.chat.type !== 'private') return
    const chatId = message.chat.id
    if (!allowed.has(chatId)) {
      // fail closed and stay silent: no model call, no reply, no oracle
      log(`telegram: ignoring message from non-allowlisted chat ${chatId}`)
      return
    }
    // photos, documents (PDFs, files), or plain text — captions count as
    // the message text; anything else (stickers, voice, video) is ignored
    const photo = message.photo !== undefined && message.photo.length > 0 ? pickPhoto(message.photo) : null
    const document = message.document
    const text = (message.text ?? message.caption ?? '').trim()
    if (photo === null && document === undefined && text === '') return
    const threadId = telegramThreadFor(chatId, state.chats)
    let stopTyping: (() => void) | null = null
    try {
      await api.sendTyping(chatId)
      stopTyping = startTypingHeartbeat(chatId)
      const command = parseTelegramCommand(text)
      let reply: string | null = null
      if (command !== null && command.command === 'new') {
        const fresh = `tg-${chatId}-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
        state.chats[String(chatId)] = fresh
        saveState(vfs, state)
        reply = await handlers.onCommand(chatId, command, fresh)
      } else if (command !== null) {
        reply = await handlers.onCommand(chatId, command, threadId)
      } else {
        // download attachments BEFORE the model turn: the handler stages
        // them into the thread workspace next to the prompt
        const attachments: TelegramAttachmentIn[] = []
        if (message.photo !== undefined && message.photo.length > 0 && photo === null) {
          reply = `that photo is too big (cap ${MAX_ATTACHMENT_BYTES} bytes) — send a smaller one`
        }
        if (photo !== null) {
          const path = await api.getFilePath(photo.file_id)
          const bytes = await api.downloadFile(path)
          attachments.push({ name: `photo-${photo.width}x${photo.height}.jpg`, mime: 'image/jpeg', bytes })
        }
        if (document !== undefined) {
          if ((document.file_size ?? 0) > MAX_ATTACHMENT_BYTES) {
            reply = `that file is too big (${document.file_size} bytes, cap ${MAX_ATTACHMENT_BYTES}) — send a smaller one`
          } else {
            const path = await api.getFilePath(document.file_id)
            const bytes = await api.downloadFile(path)
            const name = sanitizeAttachmentName(document.file_name ?? 'document', `upload-${Date.now().toString(36)}`)
            attachments.push({ name, mime: document.mime_type ?? 'application/octet-stream', bytes })
          }
        }
        reply = reply ?? (await handlers.onText(chatId, text, threadId, attachments))
      }
      stopTyping?.()
      if (reply !== null) {
        await api.sendMessage(chatId, reply)
        handledCount++
      }
    } catch (err) {
      stopTyping?.()
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
