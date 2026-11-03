/**
 * Gmail connector core (isolate-clean: fetch-only, no binaries, no node
 * APIs). Runs in the browser, on the server, and on Workers unchanged —
 * only the poller driver (ticker vs. alarms) differs per runtime.
 *
 * Security posture, enforced in code not prose:
 * - secrets (client id/secret, refresh/access tokens) NEVER live in the
 *   VFS: env vars or an external file outside the workspace. The agent's
 *   shell can read anything mounted, so workspace secrets are not secrets.
 * - mail content is UNTRUSTED input: system prompt outranks it, the skill
 *   says so, and tool results carry no provenance upgrade.
 * - sending is structural: gmail_send takes only a draft id created by
 *   gmail_draft. There is no send-raw-text tool, so a fooled model can at
 *   most stage a draft — delivery still needs the human + allowlist.
 * - recipients are allowlisted per connector config; drafts to anyone are
 *   fine (a draft sends nothing), sending is not.
 */
export interface GmailSecrets {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface GmailConfig {
  enabled: boolean
  /** verified account address (identity anchor, never trust chat claims) */
  account: string | null
  /** Gmail label ids to watch (default INBOX) */
  watchLabelIds: string[]
  /** Telegram chat id to nudge on new mail (null = silent) */
  notifyChatId: string | null
  /** who may receive sent mail: exact addresses or @domains */
  allowSendTo: string[]
  /** drafts-only mode (default true): gmail_send refuses unless explicitly disabled */
  draftsOnly: boolean
}

export const GMAIL_CONFIG_PATH = '/home/user/.cell/connectors/gmail.json'
export const GMAIL_STATE_PATH = '/home/user/.cell/gmail-state.json'
export const GMAIL_MAIL_DIR = '/home/user/.cell/gmail'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export function defaultGmailConfig(): GmailConfig {
  return {
    enabled: false,
    account: null,
    watchLabelIds: ['INBOX'],
    notifyChatId: null,
    allowSendTo: [],
    draftsOnly: true,
  }
}

export type GmailFetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

function defaultFetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }):
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  return (globalThis.fetch as typeof fetch)(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
}

export interface StoredMail {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  date: string
  body: string
  labels: string[]
  storedAt: string
}

/** Load + validate connector config (tolerant read, strict validation). */
export function loadGmailConfig(vfs: { read(path: string): string | null }, env: Record<string, string | undefined>): { config: GmailConfig; secrets: GmailSecrets | null } | { error: string } {
  let raw: string | null = null
  try {
    raw = vfs.read(GMAIL_CONFIG_PATH)
  } catch {
    raw = null
  }
  const config = defaultGmailConfig()
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<GmailConfig> & { clientSecret?: unknown; refreshToken?: unknown; client_secret?: unknown; refresh_token?: unknown }
      if (typeof parsed.clientSecret === 'string' || typeof parsed.refreshToken === 'string' || typeof parsed.client_secret === 'string' || typeof parsed.refresh_token === 'string') {
        return { error: `gmail: secrets do not belong in ${GMAIL_CONFIG_PATH} (persisted in IndexedDB + snapshots) — use env vars or the host secrets file` }
      }
      if (typeof parsed.enabled === 'boolean') config.enabled = parsed.enabled
      if (typeof parsed.account === 'string') config.account = parsed.account
      if (Array.isArray(parsed.watchLabelIds) && parsed.watchLabelIds.every((l) => typeof l === 'string')) {
        config.watchLabelIds = parsed.watchLabelIds as string[]
      }
      if (parsed.notifyChatId === null || typeof parsed.notifyChatId === 'string') config.notifyChatId = parsed.notifyChatId
      if (Array.isArray(parsed.allowSendTo) && parsed.allowSendTo.every((l) => typeof l === 'string')) {
        config.allowSendTo = parsed.allowSendTo as string[]
      }
      if (typeof parsed.draftsOnly === 'boolean') config.draftsOnly = parsed.draftsOnly
    } catch {
      return { error: `gmail: ${GMAIL_CONFIG_PATH} is not valid JSON` }
    }
  }
  // secrets: env first, then explicit external file. NEVER the workspace
  // VFS — the agent's shell can read anything mounted there.
  let clientId = (env.CELL_GOOGLE_CLIENT_ID ?? '').trim()
  let clientSecret = (env.CELL_GOOGLE_CLIENT_SECRET ?? '').trim()
  let refreshToken = (env.CELL_GOOGLE_REFRESH_TOKEN ?? '').trim()
  const secretsFile = (env.CELL_GOOGLE_SECRETS_FILE ?? '').trim()
  if (secretsFile !== '') {
    return { error: 'gmail: CELL_GOOGLE_SECRETS_FILE must be read by the host (server bootstrap), not the agent runtime — pass resolved secrets instead' }
  }
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    return { config, secrets: null }
  }
  void secretsFile
  return { config, secrets: { clientId, clientSecret, refreshToken } }
}

/** Exchange an OAuth code for tokens (one-time setup, host-driven). */
export async function exchangeOAuthCode(
  secrets: Pick<GmailSecrets, 'clientId' | 'clientSecret'>,
  code: string,
  redirectUri: string,
  fetchImpl: GmailFetch = defaultFetch,
): Promise<{ refreshToken: string; accessToken: string; email: string } | { error: string }> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(secrets.clientId)}&client_secret=${encodeURIComponent(secrets.clientSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_type=authorization_code`,
  })
  if (!res.ok) return { error: `oauth exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}` }
  const body = (await res.json()) as { refresh_token?: string; access_token?: string; id_token?: string; error?: string }
  if (typeof body.refresh_token !== 'string' || typeof body.access_token !== 'string') {
    return { error: `oauth exchange failed: ${typeof body.error === 'string' ? body.error : 'no refresh token (use access_type=offline&prompt=consent)'}` }
  }
  let email = ''
  try {
    const payload = JSON.parse(BufferCompat.from(body.id_token?.split('.')[1] ?? '', 'base64').toString()) as { email?: string; email_verified?: boolean }
    if (typeof payload.email === 'string' && payload.email_verified !== false) email = payload.email
  } catch {
    email = ''
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, email }
}

const BufferCompat = {
  from(s: string, enc: string): { toString(): string } {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, enc as BufferEncoding)
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { toString: () => new TextDecoder().decode(bytes) }
  },
};

export class GmailApi {
  constructor(
    private secrets: GmailSecrets,
    private fetchImpl: GmailFetch = defaultFetch,
    private onAccessToken?: (token: string) => void,
  ) {}

  private accessToken: string | null = null;

  private async token(): Promise<string> {
    if (this.accessToken !== null) return this.accessToken
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(this.secrets.clientId)}&client_secret=${encodeURIComponent(this.secrets.clientSecret)}&refresh_token=${encodeURIComponent(this.secrets.refreshToken)}&grant_type=refresh_token`,
    })
    if (!res.ok) {
      const text = await res.text()
      const err: Error & { invalidGrant?: boolean } = new Error(`gmail token refresh failed: HTTP ${res.status} (invalid_grant check: ${/invalid_grant/.test(text) ? 'invalid_grant' : 'other'})`)
      // invalid_grant = revoked/expired/rotated: caller flips the
      // connector to needs_reauth instead of retrying forever
      if (/invalid_grant/.test(text)) err.invalidGrant = true
      throw err
    }
    const body = (await res.json()) as { access_token?: string }
    if (typeof body.access_token !== 'string') throw new Error('gmail token refresh: no access_token')
    this.accessToken = body.access_token
    try {
      this.onAccessToken?.(body.access_token)
    } catch {
      // observer must never break auth
    }
    return this.accessToken
  }

  invalidate(): void {
    this.accessToken = null
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = async (token: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> =>
      this.fetchImpl(`${GMAIL_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    let token = await this.token()
    let res = await send(token)
    if (res.status === 401) {
      // single retry on a fresh token before surfacing auth failure
      this.invalidate()
      token = await this.token()
      res = await send(token)
    }
    if (!res.ok) throw new Error(`gmail ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    return (await res.json()) as T
  }

  async profile(): Promise<{ emailAddress?: string }> {
    return this.call('GET', '/profile')
  }

  async historyList(startHistoryId: string, labelIds: string[]): Promise<{ history?: Array<{ messages?: Array<{ id: string }> }>; historyId?: string }> {
    const params = new URLSearchParams({ startHistoryId, historyIdOnly: 'false' })
    for (const label of labelIds) params.append('labelIds', label)
    return this.call('GET', `/history?${params.toString()}`)
  }

  async listMessages(query: string, maxResults: number): Promise<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
    return this.call('GET', `/messages?${params.toString()}`)
  }

  async getMessage(id: string): Promise<{
    id: string
    threadId: string
    labelIds?: string[]
    snippet?: string
    payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: unknown[] }
  }> {
    return this.call('GET', `/messages/${encodeURIComponent(id)}?format=full`)
  }

  async getDraft(draftId: string): Promise<{ id?: string; message?: { payload?: { headers?: Array<{ name: string; value: string }> } } }> {
    return this.call('GET', `/drafts/${encodeURIComponent(draftId)}`)
  }

  async createDraft(to: string, subject: string, bodyText: string): Promise<{ id?: string; message?: { id?: string } }> {
    if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) throw new Error('gmail createDraft: to/subject must not contain CRLF')
    const raw = BufferCompatB64(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${bodyText}`)
    return this.call('POST', '/drafts', { message: { raw } })
  }

  async sendDraft(draftId: string): Promise<{ id?: string }> {
    return this.call('POST', '/drafts/send', { id: draftId })
  }
}

function BufferCompatB64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64url')
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Extract readable text from a Gmail payload (plain part preferred). */
export function extractMailBody(payload: {
  headers?: Array<{ name: string; value: string }>
  body?: { data?: string }
  parts?: unknown[]
} | undefined, depth = 0): string {
  if (!payload || depth > 4) return ''
  const decode = (data: string | undefined): string => {
    if (!data) return ''
    try {
      const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder().decode(bytes)
    } catch {
      return ''
    }
  }
  const parts = Array.isArray(payload.parts) ? (payload.parts as typeof payload[]) : []
  const textPart = parts.find((p) => {
    const h = Array.isArray(p.headers) ? p.headers : []
    return h.some((x) => x.name.toLowerCase() === 'content-type' && x.value.toLowerCase().includes('text/plain'))
  })
  if (textPart) {
    const direct = decode(textPart.body?.data)
    if (direct.trim() !== '') return direct
  }
  for (const part of parts) {
    const text = extractMailBody(part as typeof payload, depth + 1)
    if (text.trim() !== '') return text
  }
  return decode(payload.body?.data)
}

export function mailHeader(payload: { headers?: Array<{ name: string; value: string }> } | undefined, name: string): string {
  const found = (payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

/** Split a header address list into individual emails (handles Name <a@b>, comma lists). */
export function parseEmailAddresses(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const trimmed = part.trim().toLowerCase()
      if (trimmed === '') return ''
      const angled = trimmed.match(/<([^>]+)>/)?.[1]?.trim() ?? trimmed
      return angled
    })
    .filter((addr) => addr !== '' && addr.includes('@'))
}

/** Every recipient across To+Cc+Bcc must be allowlisted; empty set refuses. */
export function allRecipientsAllowed(to: string, cc: string, bcc: string, allowList: string[]): { ok: true; recipients: string[] } | { ok: false; offending: string[]; recipients: string[] } {
  const recipients = [...parseEmailAddresses(to), ...parseEmailAddresses(cc), ...parseEmailAddresses(bcc)]
  if (recipients.length === 0) return { ok: false, offending: ['(no recipients)'], recipients }
  const offending = recipients.filter((addr) => !isAllowedRecipient(addr, allowList))
  if (offending.length > 0) return { ok: false, offending, recipients }
  return { ok: true, recipients }
}

/** Recipient allowlist: exact address or @domain suffix match. */
export function isAllowedRecipient(to: string, allowList: string[]): boolean {
  const addr = to.trim().toLowerCase()
  const email = addr.includes('<') ? (addr.match(/<([^>]+)>/)?.[1] ?? addr) : addr
  for (const rule of allowList) {
    const clean = rule.trim().toLowerCase()
    if (clean === '') continue
    if (clean.startsWith('@')) {
      if (email.endsWith(clean)) return true
    } else if (email === clean) {
      return true
    }
  }
  return false
}
