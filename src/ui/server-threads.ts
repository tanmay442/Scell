/**
 * Web-UI bridge to the headless server: Telegram chats, background
 * workers and headless runs live on server disk, never in the browser
 * VFS. This store fetches them through GET /threads(+/:id) for the
 * sidebar's "On the server" section, and holds the Telegram setup
 * helpers (token test, chat discovery, server command generator).
 */
export interface ServerThread {
  threadId: string
  kind: 'telegram' | 'worker' | 'run'
  sessionId: string | null
  title: string | null
  updatedAt: string | null
  messages: number
  busy: boolean
}

export interface ServerThreadDetail extends ServerThread {
  transcript: string[]
  files: Array<{ name: string; size: number; mtime: number }>
  foldersTruncated: boolean
}

const URL_KEY = 'cell.serverUrl'
const TOKEN_KEY = 'cell.serverToken'

export function serverUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? 'http://localhost:8787'
  } catch {
    return 'http://localhost:8787'
  }
}

export function serverToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setServerUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url.trim().replace(/\/+$/, ''))
  } catch {
    // private mode — settings just don't persist
  }
}

export function setServerToken(token: string): void {
  try {
    if (token.trim() === '') localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, token.trim())
  } catch {
    // private mode — settings just don't persist
  }
}

async function authed(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
  const token = serverToken()
  if (token !== '') headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${serverUrl()}${path}`, { ...init, headers })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body }
}

export async function fetchServerThreads(): Promise<{ threads: ServerThread[] } | { error: string }> {
  try {
    const { ok, status, body } = await authed('/threads')
    if (!ok) return { error: `server ${status}: ${typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : 'request failed'}` }
    const threads = (body as { threads?: unknown }).threads
    if (!Array.isArray(threads)) return { error: 'bad /threads response' }
    return { threads: threads as ServerThread[] }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchThreadDetail(threadId: string): Promise<{ detail: ServerThreadDetail } | { error: string }> {
  try {
    const { ok, status, body } = await authed(`/threads/${encodeURIComponent(threadId)}`)
    if (!ok) return { error: `server ${status}: ${typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : 'request failed'}` }
    return { detail: body as ServerThreadDetail }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Live token check straight from the browser (Bot API allows CORS). */
export async function testTelegramToken(token: string): Promise<{ username: string } | { error: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getMe`, { method: 'POST' })
    if (!res.ok) return { error: `Telegram HTTP ${res.status} — token rejected` }
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } }
    if (body.ok !== true) return { error: 'Telegram refused the token' }
    return { username: typeof body.result?.username === 'string' ? body.result.username : '(no username)' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Recent chats that messaged the bot (user messages it, clicks refresh,
 * picks the id) — the allowlist bootstrap without reading server logs. */
export async function discoverTelegramChats(token: string): Promise<{ chats: Array<{ id: number; kind: string; text: string }> } | { error: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }),
    })
    if (!res.ok) return { error: `Telegram HTTP ${res.status}` }
    const body = (await res.json()) as { ok?: boolean; result?: Array<{ message?: { chat?: { id?: number; type?: string }; text?: string; caption?: string } }> }
    if (body.ok !== true || !Array.isArray(body.result)) return { error: 'bad getUpdates response' }
    const chats: Array<{ id: number; kind: string; text: string }> = []
    for (const update of body.result) {
      const chat = update.message?.chat
      if (typeof chat?.id !== 'number') continue
      if (chats.some((c) => c.id === chat.id)) continue
      chats.push({ id: chat.id, kind: chat.type ?? '?', text: (update.message?.text ?? update.message?.caption ?? '').slice(0, 60) })
    }
    return { chats }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Copy-paste server launch with the token + allowlist baked in. */
export function telegramServerCommand(workspace: string, port: number, token: string, allowFrom: string): string {
  const allow = allowFrom.trim() === '' ? '<your-chat-id>' : allowFrom.trim()
  return `CELL_TELEGRAM=1 CELL_TELEGRAM_TOKEN=${token.trim() === '' ? '<botfather-token>' : token.trim()} CELL_TELEGRAM_ALLOW_FROM=${allow} ./scripts/agent-server.sh --workspace ${workspace} --port ${port}`
}
