/**
 * Secret redaction for agent transcripts and persisted sessions.
 *
 * Anything that looks like a credential is replaced before it reaches the
 * terminal transcript or ~/.cell/sessions/*.json: Meta LLM_ keys, Anthropic
 * sk-ant- keys, generic sk- keys, Bearer headers, and apiKey/key fields in
 * JSON blobs. Tool output can echo the environment (env dumps, curl -v),
 * so every tool result and every model message passes through here.
 */

const PATTERNS: { re: RegExp; replace: string }[] = [
  // Meta provisioning keys: LLM_<alphanumerics>
  { re: /LLM_[A-Za-z0-9_-]{8,}/g, replace: 'LLM_…[redacted]' },
  // Anthropic + OpenAI secret keys
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: 'sk-ant-…[redacted]' },
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replace: 'sk-…[redacted]' },
  // Authorization: Bearer <token>
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: 'Bearer …[redacted]' },
  // JSON fields: "apiKey": "...", "key": "LLM_...", 'secretAccessKey' etc.
  { re: /("(?:apiKey|api_key|secretAccessKey|secret|token)"\s*:\s*")[^"]{4,}(")/g, replace: '$1…[redacted]$2' },
  { re: /(x-api-key["'\s:]+)[A-Za-z0-9_.-]{8,}/gi, replace: '$1…[redacted]' },
]

export function redactSecrets(text: string): string {
  let out = text
  for (const { re, replace } of PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, replace)
  }
  return out
}

/** Redact every string value in a JSON-serializable structure (for sessions). */
export function redactJson<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactJson(item)
    }
    return out as T
  }
  return value
}
