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

// No hardcoded default: servers live on different hosts/ports per
// setup. Empty until the user sets it (Connectors dialog or the server
// section); the UI shows a placeholder and stays inert until then.
export function serverUrl(): string {
  try {
    return (localStorage.getItem(URL_KEY) ?? '').trim()
  } catch {
    return ''
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

export async function fetchServerHealth(): Promise<{ ok: boolean; telegram: boolean } | { error: string }> {
  try {
    const url = serverUrl()
    if (url === '') return { error: 'no server URL set' }
    const res = await fetch(`${url}/health`)
    if (!res.ok) return { error: `server HTTP ${res.status}` }
    const body = (await res.json()) as { ok?: boolean; telegram?: boolean }
    return { ok: body.ok === true, telegram: body.telegram === true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchServerThreads(): Promise<{ threads: ServerThread[] } | { error: string }> {
  try {
    if (serverUrl() === '') return { error: 'no server URL set' }
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
    if (serverUrl() === '') return { error: 'no server URL set' }
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
/** Copy-paste server launch, token-file first: the token never belongs
 * in shell history on shared machines. The inline-token form is shown
 * commented out for throwaway local runs (leading space + HISTCONTROL). */
export function telegramServerCommand(workspace: string, port: number, token: string, allowFrom: string, tokenFile = '~/.cell-telegram-token'): string {
  const allow = allowFrom.trim() === '' ? '<your-chat-id>' : allowFrom.trim()
  const trimmed = token.trim()
  const lines = [
    `# 1. save the token outside the workspace (0600 file in a 0700 dir):`,
    `#    printf '%s' '${trimmed === '' ? '<botfather-token>' : trimmed}' > ${tokenFile} && chmod 600 ${tokenFile}`,
    `CELL_TELEGRAM=1 CELL_TELEGRAM_TOKEN_FILE=${tokenFile} CELL_TELEGRAM_ALLOW_FROM=${allow} ./scripts/agent-server.sh --workspace ${workspace} --port ${port}`,
  ]
  if (trimmed !== '') {
    lines.push(`# throwaway form only (leading space keeps it out of history with HISTCONTROL=ignorespace):`)
    lines.push(`#  CELL_TELEGRAM=1 CELL_TELEGRAM_TOKEN=${trimmed} CELL_TELEGRAM_ALLOW_FROM=${allow} ./scripts/agent-server.sh --workspace ${workspace} --port ${port}`)
  }
  return lines.join('\n')
}
