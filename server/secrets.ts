import { readFileSync } from 'node:fs'

/**
 * Headless-server secrets: a small string map for values the agent loop may
 * need (provider keys, webhook tokens) without baking them into the VFS or
 * the workspace. Two sources, first set wins:
 *   CELL_SECRETS_JSON — a JSON object string, e.g. '{"META_KEY":"…"}'
 *   CELL_SECRETS_FILE — path to a JSON file with the same shape
 * Neither set means no secrets (empty map), which is the normal local case.
 *
 * Values are never logged here — this module has no logging at all. Callers
 * that interpolate secrets into prompts or transcripts must redact them
 * (see src/shell/commands/agent-redact.ts) before they reach any output.
 */

function parseSecretsJson(raw: string, source: string): Map<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object of string values`)
  }
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`${source} must be a JSON object of string values (key '${key}' is not a string)`)
    }
    out.set(key, value)
  }
  return out
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const fromJson = env.CELL_SECRETS_JSON
  if (fromJson !== undefined && fromJson.trim() !== '') {
    return parseSecretsJson(fromJson, 'CELL_SECRETS_JSON')
  }
  const file = env.CELL_SECRETS_FILE
  if (file !== undefined && file.trim() !== '') {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(`CELL_SECRETS_FILE: cannot read '${file}': ${err instanceof Error ? err.message : String(err)}`)
    }
    return parseSecretsJson(raw, `CELL_SECRETS_FILE '${file}'`)
  }
  return new Map()
}
