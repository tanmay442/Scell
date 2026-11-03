import type { Vfs } from '../../vfs/types'
import { SKILL_CONTENT } from '../../vfs/skill-content'

/**
 * skill_install: the bot teaches itself a new skill at the user's explicit
 * request — from a URL (fetch) or pasted markdown. Installed skills land
 * as ~/.cell/skills/<name>/SKILL.md, so load_skill picks them up on the
 * next run with zero restarts.
 *
 * Network reach is exactly the agent's bash reach (no new capability):
 * only http(s) URLs, 30s timeout, 64KB cap. Names are slugified into a
 * safe charset; nothing outside the skills dir is ever touched.
 */
export const SKILLS_DIR = '/home/user/.cell/skills'
const MAX_SKILL_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 30_000
const NAME_RE = /^[a-z0-9-]{2,40}$/

export type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** github.com/.../blob/.../SKILL.md → raw.githubusercontent.com/... */
export function skillUrlToRaw(url: string): string {
  const blob = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url.trim())
  if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`
  return url.trim()
}

/** Hosts a skill fetch must never touch: loopback, private nets, link-local
 * (cloud metadata lives at 169.254.169.254) and opaque local names.
 * DNS rebinding (evil.com resolving to 127.0.0.1) is NOT covered — the
 * explicit user request plus ask-approval remain the gate for those. */
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
]

function blockedSkillHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTS.some((re) => re.test(clean))) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (v4.slice(1).some((n) => Number(n) > 255)) return false
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
    return false
  }
  if (/^\[.*\]$/.test(clean)) {
    const inner = clean.slice(1, -1).toLowerCase()
    return inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc00:') || inner.startsWith('fd00:')
  }
  return false
}

function slugify(name: string): string {
  // no length cap here: over-long names must ERROR (never silently
  // truncate onto a colliding prefix) — length is checked at install
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function nameFromFrontmatter(body: string): string | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(body)
  if (!front) return null
  const name = /^name:\s*(.+)$/m.exec(front[1])
  return name ? slugify(name[1].replace(/['"]/g, '')) : null
}

function nameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname
    const parts = path.split('/').filter((p) => p !== '')
    // .../skills/<name>/SKILL.md → <name>; otherwise last non-file segment
    const file = parts[parts.length - 1] ?? ''
    if (/^skill\.md$/i.test(file) && parts.length >= 2) {
      const slug = slugify(parts[parts.length - 2])
      return NAME_RE.test(slug) ? slug : null
    }
    const slug = slugify(file.replace(/\.[a-z0-9]+$/i, ''))
    return NAME_RE.test(slug) ? slug : null
  } catch {
    return null
  }
}

export interface InstallSkillInput {
  name?: string
  url?: string
  markdown?: string
  overwrite?: boolean
}

export async function installSkill(
  vfs: Vfs,
  input: InstallSkillInput,
  fetchImpl?: FetchImpl,
): Promise<{ ok: true; name: string; bytes: number } | { error: string }> {
  let body = typeof input.markdown === 'string' ? input.markdown : ''
  const rawUrl = typeof input.url === 'string' && input.url.trim() !== '' ? skillUrlToRaw(input.url) : null
  if (rawUrl !== null) {
    // https-only (no MITM-rewritable plaintext) + no internal hosts: the
    // fetched body is fed straight to the model, so the transport and
    // the host must both be trustworthy — beyond the user's own request
    if (!/^https:\/\//i.test(rawUrl)) return { error: 'skill_install: refusing non-https URL (paste the markdown directly for local files)' }
    try {
      if (blockedSkillHost(new URL(rawUrl).hostname)) {
        return { error: 'skill_install: refusing internal/local host (paste the markdown directly instead)' }
      }
    } catch {
      return { error: 'skill_install: malformed URL' }
    }
    const fetchFn: FetchImpl =
      fetchImpl ?? ((url, init) => (globalThis.fetch as typeof fetch)(url, init) as unknown as Promise<{ ok: boolean; status: number; text(): Promise<string> }>)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchFn(rawUrl, { signal: controller.signal })
      if (!res.ok) return { error: `skill_install: ${rawUrl} returned HTTP ${res.status}` }
      body = await res.text()
    } catch (err) {
      return { error: `skill_install: fetch failed for ${rawUrl}: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      clearTimeout(timer)
    }
  }
  if (body.length === 0) return { error: 'skill_install: empty body — pass url or markdown' }
  if (body.length > MAX_SKILL_BYTES) {
    return { error: `skill_install: body is ${body.length} bytes, cap is ${MAX_SKILL_BYTES} — skills must be focused` }
  }
  if (body.trim().length < 20) return { error: 'skill_install: body too short to be a skill' }
  const explicitRaw = typeof input.name === 'string' && input.name.trim() !== '' ? input.name : null
  if (explicitRaw !== null) {
    const slug = slugify(explicitRaw)
    if (slug.length > 40) return { error: `skill_install: derived name '${slug}' is ${slug.length} chars (max 40) — pass a shorter name` }
    if (!NAME_RE.test(slug)) {
      return { error: `skill_install: derived name '${slug}' is unusable (use 2-40 lowercase letters/digits/dashes)` }
    }
  }
  const explicit = explicitRaw !== null ? slugify(explicitRaw) : ''
  const name = (explicit !== '' && NAME_RE.test(explicit) ? explicit : null) ?? nameFromFrontmatter(body) ?? (rawUrl !== null ? nameFromUrl(rawUrl) : null)
  if (name === null || !NAME_RE.test(name)) {
    return { error: 'skill_install: could not derive a skill name (use 2-40 lowercase letters/digits/dashes, or pass name explicitly)' }
  }
  // load_skill requires frontmatter: add it when the source has none,
  // deriving the description from the first heading or content line
  if (!/^---\s*\n[\s\S]*?\n---\s*\n/.test(body)) {
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'Custom skill'
    const description = firstLine.replace(/^#+\s*/, '').slice(0, 140)
    body = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
  }
  // builtins are the trusted instruction set: user-installed skills may
  // not shadow them (a project dir can still override per-project, loudly)
  if (SKILL_CONTENT.some((builtin) => builtin.name === name)) {
    return { error: `skill_install: '${name}' is a built-in skill — pick another name` }
  }
  const dest = `${SKILLS_DIR}/${name}/SKILL.md`
  let exists = false
  try {
    exists = vfs.isFile(dest)
  } catch {
    exists = false
  }
  if (exists && input.overwrite !== true) {
    return { error: `skill_install: skill '${name}' already exists — pass overwrite:true to replace it` }
  }
  vfs.write(dest, body)
  return { ok: true, name, bytes: body.length }
}
