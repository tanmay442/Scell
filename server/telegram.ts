import type { Vfs } from '../src/vfs/types'
import { deleteReminder as deleteStoredReminder, dueReminders, loadReminders, noteFailedDelivery } from '../src/shell/commands/agent-reminders'

/** Re-exported so server.ts routes share one reminder store entry point. */
export const deleteReminder = deleteStoredReminder

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
  command: 'new' | 'status' | 'help' | 'brief' | 'cancel' | 'reminders' | 'forget'
  arg: string
}

/** /cmd and /cmd@botname forms; unknown /commands fall through as chat text. */
export function parseTelegramCommand(text: string): TelegramCommand | null {
  const match = /^\/([A-Za-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  // commands are case-insensitive (/STATUS works like /status); unknown
  // ones (incl. /cancel — see below) fall through as plain chat text
  const command = match[1].toLowerCase()
  if (command !== 'new' && command !== 'status' && command !== 'help' && command !== 'brief' && command !== 'cancel' && command !== 'reminders' && command !== 'forget') return null
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
): { files: FreshFile[]; skippedOversize: string[] } {
  const fresh: Array<{ path: string; name: string; size: number; mtime: number }> = []
  const skippedOversize: string[] = []
  let all: string[] = []
  try {
    all = vfs.listAllFiles()
  } catch {
    return { files: [], skippedOversize }
  }
  for (const path of all) {
    if (!path.startsWith(`${threadDir}/`) || path.includes('/.cell/')) continue
    // any dot-segment hides the file, not just a dot basename: agent
    // dotfiles/dotdirs (.config/, editor backups, staged secrets) created
    // mid-run must never ship back to the chat as "deliverables"
    const rel = path.slice(threadDir.length + 1)
    if (rel.split('/').some((segment) => segment.startsWith('.'))) continue
    const name = path.split('/').pop() ?? ''
    let stat
    try {
      stat = vfs.stat(path)
    } catch {
      continue
    }
    if (stat === null || stat.type !== 'file' || stat.mtime < sinceMs) continue
    // oversize deliverables are NAMED, never silently dropped: the caller
    // tells the chat to ask for a split
    if (stat.size > maxBytes) {
      skippedOversize.push(rel)
      continue
    }
    fresh.push({ path, name, size: stat.size, mtime: stat.mtime })
  }
  fresh.sort((a, b) => b.mtime - a.mtime)
  return { files: fresh.slice(0, maxFiles), skippedOversize }
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
    voice?: unknown
    video?: unknown
    video_note?: unknown
    sticker?: unknown
  }
}

export interface TelegramReminderSummary {
  id: string
  text: string
  runAt: string
}

/** Pending reminders for one chat (the agent has no list/cancel tool,
 * so the chat surface owns both). */
export function listChatReminders(vfs: Vfs, chatId: number): TelegramReminderSummary[] {
  return loadReminders(vfs)
    .filter((r) => r.chatId === String(chatId))
    .map((r) => ({ id: r.id, text: r.text, runAt: r.runAt }))
}

export interface TelegramPollHandlers {
  /** chat text (+ downloaded photo/document bytes) → the agent's reply.
   * The signal aborts when the turn budget expires; handlers should
   * stop work promptly (the poller reports the timeout to the chat). */
  onText: (chatId: number, text: string, threadId: string, attachments: TelegramAttachmentIn[], signal: AbortSignal) => Promise<string>
  /** /new /status /help */
  onCommand: (chatId: number, command: TelegramCommand, threadId: string) => Promise<string | null>
  log?: (message: string) => void
}

export interface TelegramPoller {
  stop: () => void
  /** messages handled so far (health/debug, no content) */
  handled: () => number
}

export interface TelegramPollOptions {
  /** per-turn ceiling (default 10 min): the poller stops waiting and
   * tells the chat, instead of wedging behind one hung turn */
  turnTimeoutMs?: number
}

/** Per-chat FIFO turn queue (Grok/Hermes shape): a message arriving while
 * its thread is busy QUEUES instead of dying — the drain runs each queued
 * turn in order after the current one finishes. Same chat sequential,
 * different chats fully parallel (the router underneath serializes). */
export interface TurnQueue {
  /** immediate reply ('Queued…' or the turn's own reply). The optional
   * signal aborts a hung turn (the poller's turn budget). */
  submit(chatId: number, threadId: string, text: string, attachments: TelegramAttachmentIn[], signal?: AbortSignal): Promise<string>
  /** kick the drain after a holder finishes: queued turns never run
   * unless something starts the drain, so every run completion must
   * call this (otherwise old turns stall until the next message — and
   * a newer message would then run first, inverting the order) */
  kick(chatId: number, threadId: string): void
  /** queued-but-unrun turns for a thread (for /new handoff messaging) */
  queuedCount(threadId: string): number
}

/** Internal race signal: the router was free at check time but busy at
 * run time. A typed error (never a string match) so agent/tool error text
 * can never be confused with it. Retries are capped — see the drain loop. */
export class QueueRaceError extends Error {
  constructor() {
    super('queue race: holder slipped in')
    this.name = 'QueueRaceError'
  }
}

export function createTurnQueue(
  runTurn: (chatId: number, text: string, threadId: string, attachments: TelegramAttachmentIn[], fromQueue: boolean, signal?: AbortSignal) => Promise<string>,
  send: (chatId: number, text: string) => Promise<void>,
  isBusy: (threadId: string) => boolean,
  onError: (chatId: number, err: unknown) => void,
  maxQueued = 5,
): TurnQueue {
  const pending = new Map<string, Array<{ text: string; attachments: TelegramAttachmentIn[]; __races?: number; signal?: AbortSignal }>>()
  const draining = new Set<string>()
  const kick = (chatId: number, threadId: string): void => {
    drain(chatId, threadId)
  }
  return {
    async submit(chatId, threadId, text, attachments, signal) {
      if (!isBusy(threadId)) {
        // finally, not after: a throwing idle turn must still start the
        // drain or queued turns strand until the next message arrives
        try {
          return await runTurn(chatId, text, threadId, attachments, false, signal)
        } finally {
          drain(chatId, threadId)
        }
      }
      const queued = pending.get(threadId) ?? []
      if (queued.length >= maxQueued) return 'still catching up — hold that thought for a moment'
      queued.push({ text, attachments, ...(signal !== undefined ? { signal } : {}) })
      pending.set(threadId, queued)
      return `queued (position ${queued.length}) — still on the previous one, it runs next`
    },
    kick,
    queuedCount(threadId) {
      return pending.get(threadId)?.length ?? 0
    },
  }
  // one drain loop per thread: a drained turn completing starts nonew loop
  function drain(chatId: number, threadId: string): void {
    if (draining.has(threadId)) return
    if (!pending.get(threadId)?.length) return
    draining.add(threadId)
    void (async () => {
      try {
        for (;;) {
          // holder still running (router race): leave items queued — the
          // holder's completion starts a fresh drain that picks them up
          if (isBusy(threadId)) break
          const next = pending.get(threadId)?.shift()
          if (next === undefined) break
          if (pending.get(threadId)?.length === 0) pending.delete(threadId)
          // retries for the router race: a holder that never frees must
          // not spin forever — dead-letter through onError after the cap
          let races = (next as { __races?: number }).__races ?? 0
          try {
            const reply = await runTurn(chatId, next.text, threadId, next.attachments, true, (next as { signal?: AbortSignal }).signal)
            await send(chatId, reply)
          } catch (err) {
            // router race: holder slipped in between the isBusy check and
            // the run — back to the front, no user-visible error
            if (err instanceof QueueRaceError) {
              races++
              if (races <= 3) {
                const queue = pending.get(threadId) ?? []
                queue.unshift({ ...next, __races: races })
                pending.set(threadId, queue)
                continue
              }
              // fall through: cap hit, report loudly like any other error
            }
            try {
              await send(chatId, `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000))
            } catch {
              // delivery failed; reported below
            }
            try {
              onError(chatId, err)
            } catch {
              // the error reporter must never strand the queue: a throwing
              // onError would abort the for(;;) loop and strand everything
              // queued behind the failed turn
            }
          }
        }
      } finally {
        draining.delete(threadId)
      }
    })()
  }
}

/** Long-poll loop. Returns a stopper; the loop never throws outward. */
export function startTelegramPoller(
  vfs: Vfs,
  apiBase: string,
  config: TelegramBotConfig,
  handlers: TelegramPollHandlers,
  fetchImpl: TelegramFetch = defaultFetch,
  opts: TelegramPollOptions = {},
): TelegramPoller {
  const turnTimeoutMs = opts.turnTimeoutMs ?? 600_000
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

  /** Download with one retry on a fresh file path: Telegram paths can
   * expire between getFile and download, and the user-facing error must
   * be human, never a raw HTTP code. */
  async function downloadFresh(fileId: string, label: string): Promise<Uint8Array> {
    try {
      return await api.downloadFile(await api.getFilePath(fileId))
    } catch (first) {
      try {
        return await api.downloadFile(await api.getFilePath(fileId))
      } catch {
        throw first instanceof Error ? first : new Error(`telegram download failed: ${label}`)
      }
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
    // the message text. Voice/video get one human reply (not silence,
    // not a loop); stickers stay silent (replies would be a spam vector).
    if (message.voice !== undefined || message.video !== undefined || message.video_note !== undefined) {
      try {
        await api.sendMessage(chatId, "I can't listen to audio or watch video — send text or a photo instead")
      } catch {
        // best-effort guidance only
      }
      return
    }
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
        const tooBig = (n: number): string => `that file is too big (${(n / 1048576).toFixed(1)} MB, cap 12 MB) — try compressing or splitting it`
        if (message.photo !== undefined && message.photo.length > 0 && photo === null) {
          reply = tooBig(message.photo.reduce((a, p) => Math.max(a, p.file_size ?? 0), 0))
        }
        if (photo !== null) {
          try {
            attachments.push({ name: `photo-${photo.width}x${photo.height}.jpg`, mime: 'image/jpeg', bytes: await downloadFresh(photo.file_id, 'photo') })
          } catch {
            reply = 'could not fetch that photo — please resend it'
          }
        }
        if (document !== undefined) {
          if ((document.file_size ?? 0) > MAX_ATTACHMENT_BYTES) {
            reply = tooBig(document.file_size ?? 0)
          } else {
            try {
              const bytes = await downloadFresh(document.file_id, 'document')
              const name = sanitizeAttachmentName(document.file_name ?? 'document', `upload-${Date.now().toString(36)}`)
              attachments.push({ name, mime: document.mime_type ?? 'application/octet-stream', bytes })
            } catch {
              reply = 'could not fetch that file — please resend it'
            }
          }
        }
        // turn timeout: a hung handler must not wedge the whole poller.
        // The signal tells the run to stop; the timeout reply goes to the
        // chat either way. Late completions are dropped (never delivered
        // twice) — the next message starts fresh.
        if (reply === null) {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), turnTimeoutMs)
          try {
            reply = await Promise.race([
              handlers.onText(chatId, text, threadId, attachments, controller.signal),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`turn took longer than ${Math.max(1, Math.round(turnTimeoutMs / 1000))}s — try a smaller step`)), turnTimeoutMs + 1000),
              ),
            ])
          } catch (err) {
            reply = err instanceof Error ? err.message : String(err)
          } finally {
            clearTimeout(timeout)
          }
        }
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
      // headless/browser reminders have no chat to reach: skip silently
      // (don't count them undeliverable — there's nothing to retry)
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
