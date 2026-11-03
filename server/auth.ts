import { timingSafeEqual } from 'node:crypto'

export interface ApiToken {
  id: string
  token: string
}

export function loadTokens(raw?: string): ApiToken[] {
  const src = raw ?? process.env.CELL_API_TOKENS ?? ''
  if (src.trim() === '') return []
  return src.split(',').map((entry) => {
    const trimmed = entry.trim()
    const colon = trimmed.indexOf(':')
    if (colon <= 0 || colon >= trimmed.length - 1) {
      throw new Error(
        `invalid CELL_API_TOKENS entry ${JSON.stringify(trimmed)}: expected "id:token"`,
      )
    }
    const id = trimmed.slice(0, colon).trim()
    const token = trimmed.slice(colon + 1).trim()
    if (id === '' || token === '') {
      throw new Error(
        `invalid CELL_API_TOKENS entry ${JSON.stringify(trimmed)}: expected "id:token"`,
      )
    }
    return { id, token }
  })
}

export type AuthResult = { ok: true; id: string } | { ok: false }

export function checkAuth(tokens: ApiToken[], header: string | null | undefined): AuthResult {
  if (tokens.length === 0) return { ok: true, id: 'local' }
  if (!header) return { ok: false }
  const match = /^Bearer (.+)$/.exec(header.trim())
  if (!match) return { ok: false }
  const presented = Buffer.from(match[1], 'utf8')
  for (const entry of tokens) {
    const expected = Buffer.from(entry.token, 'utf8')
    if (expected.length !== presented.length) continue
    if (timingSafeEqual(expected, presented)) return { ok: true, id: entry.id }
  }
  return { ok: false }
}
