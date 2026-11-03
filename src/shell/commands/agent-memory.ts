import type { Vfs } from '../../vfs/types'

/**
 * Durable cross-session memory: lasting general facts and preferences the
 * user states ("prefer concise replies", "my timezone is …"). How-to
 * procedures belong in skills, project records in project files,
 * short-lived facts stay in session history — the Hermes split.
 */
export const MEMORY_PATH = '/home/user/.cell/memory.json'
export const BOT_PATH = '/home/user/.cell/bot.json'
const MAX_FACTS = 100
const MAX_FACT_CHARS = 500
/** facts attached to every system prompt stay small enough to be free */
const PROMPT_FACT_BUDGET = 1500

export interface MemoryFact {
  text: string
  addedAt: string
}

export interface BotIdentity {
  /** display name the agent uses for itself ("Cell" unless changed) */
  name: string
  /** IANA timezone for reminders, briefs and "later today" math */
  timezone: string
}

export function defaultBotIdentity(): BotIdentity {
  return { name: 'Cell', timezone: 'UTC' }
}

/** Bot identity: tolerant read, defaults when absent or malformed. */
export function readBotIdentity(vfs: Vfs): BotIdentity {
  const fallback = defaultBotIdentity()
  let raw: string | null = null
  try {
    raw = vfs.read(BOT_PATH)
  } catch {
    return fallback
  }
  if (raw === null) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<BotIdentity>
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim().slice(0, 40) : fallback.name,
      timezone: typeof parsed.timezone === 'string' && parsed.timezone.trim() !== '' ? parsed.timezone.trim().slice(0, 60) : fallback.timezone,
    }
  } catch {
    return fallback
  }
}

export function writeBotIdentity(vfs: Vfs, identity: BotIdentity): void {
  vfs.write(BOT_PATH, JSON.stringify({ ...identity, updatedAt: new Date().toISOString() }, null, 2))
}

export function loadMemory(vfs: Vfs): MemoryFact[] {
  let raw: string | null = null
  try {
    raw = vfs.read(MEMORY_PATH)
  } catch {
    return []
  }
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as { facts?: unknown }
    if (!Array.isArray(parsed.facts)) return []
    return parsed.facts
      .filter((f): f is MemoryFact => typeof f === 'object' && f !== null && typeof (f as MemoryFact).text === 'string')
      .map((f) => ({ text: f.text.slice(0, MAX_FACT_CHARS), addedAt: typeof f.addedAt === 'string' ? f.addedAt : '' }))
      .slice(0, MAX_FACTS)
  } catch {
    return []
  }
}

/** Classic injection shapes have no business as durable facts. Narrow by
 * design: only direct instruction-override phrasing is refused — broader
 * policing would false-positive on legit preferences. */
const MEMORY_REFUSALS = [
  /ignore\s+((all|previous|prior)\s+)*instructions/i,
  /disregard\s+((all|previous|prior)\s+)*(instructions|.*system prompt)/i,
  /jailbreak/i,
]

export function saveMemoryFact(vfs: Vfs, text: string): { ok: true; total: number } | { error: string } {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean === '') return { error: 'memory_save: empty fact — nothing stored' }
  if (MEMORY_REFUSALS.some((re) => re.test(clean))) {
    return { error: 'memory_save: refusing instruction-override phrasing — memory holds user facts, not directives' }
  }
  if (clean.length > MAX_FACT_CHARS) return { error: `memory_save: fact is ${clean.length} chars, cap is ${MAX_FACT_CHARS} — shorten it` }
  const facts = loadMemory(vfs)
  if (facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) {
    return { ok: true, total: facts.length }
  }
  facts.push({ text: clean, addedAt: new Date().toISOString() })
  while (facts.length > MAX_FACTS) facts.shift()
  vfs.write(MEMORY_PATH, JSON.stringify({ facts }, null, 2))
  return { ok: true, total: facts.length }
}

/** Newest-first facts as "text (added …)" lines, for memory_list. */
export function listMemoryFacts(vfs: Vfs): MemoryFact[] {
  return loadMemory(vfs).slice().reverse()
}

/** System-prompt block: '' when empty so short sessions pay nothing. */
export function memoryPromptBlock(vfs: Vfs): string {
  const facts = loadMemory(vfs)
  if (facts.length === 0) return ''
  const lines: string[] = []
  let chars = 0
  for (const fact of facts) {
    const line = `- ${fact.text}`
    if (chars + line.length > PROMPT_FACT_BUDGET) break
    lines.push(line)
    chars += line.length + 1
  }
  const more = facts.length - lines.length
  return `Durable memory (facts the user taught you across sessions — honor them without re-asking):\n${lines.join('\n')}${more > 0 ? `\n(+${more} more — memory_list to see them)` : ''}`
}
