import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface UsageRecord {
  at: string
  tokenId: string
  model: string
  promptChars: number
  steps: number
  exitCode: number
}

export async function logUsage(dir: string, record: UsageRecord): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'usage.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Best effort: usage logging must never break a request.
  }
}

export async function readUsage(dir: string, since?: string): Promise<Record<string, unknown>[]> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'usage.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (since !== undefined) {
        const at = (parsed as Record<string, unknown>).at
        if (typeof at !== 'string' || at < since) continue
      }
      out.push(parsed as Record<string, unknown>)
    } catch {
      continue
    }
  }
  return out
}
