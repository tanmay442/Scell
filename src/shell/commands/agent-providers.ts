import { redactSecrets } from './agent-redact'
import type { ToolCall, ToolInfo } from './agent-tools'

/**
 * Model transports for the agent harness.
 *
 * META (verified live 2026-10-28 with a curl probe against the machine key):
 *   POST https://api.meta.ai/v1/responses
 *   headers: { content-type: application/json, authorization: Bearer <meta.key> }
 *   body: { model: "muse-spark-1.3-contributor",
 *           input: [{ role: "user", content: [{ type: "input_text", text }] }],
 *           tools: [{ type: "function", name, description, parameters }],
 *           tool_choice: "auto", max_output_tokens }
 *   reply: { id: "resp_…", status: "completed", output: [
 *     { type: "reasoning", … },
 *     { type: "message", role: "assistant",
 *       content: [{ type: "output_text", text }] },
 *     { type: "function_call", id: "fc_…", call_id: "call_…",
 *       name, arguments: "{…json…}" } ], usage: {…} }
 *   follow-up: { model, previous_response_id: "<last resp id>",
 *     input: [{ type: "function_call_output", call_id, output }],
 *     tools, max_output_tokens }
 *   Long multi-step runs can fail a follow-up with 400 "referenced response
 *   not found or expired" (observed live 2026-10-28: the workspace changes
 *   were real and kept, only the summary hop died). The transport re-anchors
 *   once: it drops the dead chain id and replays the flattened turns as a
 *   fresh first turn, so the run continues instead of dying.
 *   stream:true gives SSE: `event: response.output_text.delta` /
 *   `data: {"delta":"…"}` chunks, then `event: response.completed` with the
 *   full response, then a `[DONE]` terminator line.
 *
 * ANTHROPIC: POST https://api.anthropic.com/v1/messages (messages array,
 * tool_use blocks, browser-direct-access header) — unchanged from before.
 * OPENAI: POST https://api.openai.com/v1/chat/completions (chat messages,
 * function tools) — unchanged from before.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'meta' | 'compat'

/** Providers that speak the OpenAI chat-completions shape. */
export const isOpenAIShaped = (provider: ProviderKind): boolean => provider === 'openai' || provider === 'compat'

export interface AgentConfig {
  provider: ProviderKind
  apiKey: string
  model: string
  /** 'full' (default): ask-tools run ungated; 'ask': per-call approval */
  permission?: 'full' | 'ask'
  /** reasoning effort for the meta transport (minimal..xhigh) */
  thinking?: string
  maxOutputTokens?: number
  /** compat provider only: API root, e.g. https://api.x.ai/v1 */
  baseURL?: string
}

export interface ModelTurn {
  text: string
  calls: ToolCall[]
  truncated: boolean
}

export interface ProviderState {
  anthropicMessages: { role: 'user' | 'assistant'; content: unknown }[]
  openaiMessages: { role: string; content: unknown }[]
  metaResponseId: string | null
  metaFirstInput: { role: string; content: Record<string, unknown>[] } | null
  /** new user text awaiting send on the chained (previous_response_id) path */
  metaPendingUser: string | null
  /** function_call_output items awaiting send on the next chained request */
  metaPendingOutputs: { type: string; call_id: string; output: string }[] | null
}

export interface ImageAttachment {
  name: string
  mime: string
  /** raw bytes as base64 (never persisted to sessions — too big) */
  base64: string
}

/** Merge consecutive user-role messages (Anthropic rejects repeats with
 * 400). Delivery mirrors and resume appends stack them; the wire must not
 * depend on upstream turn hygiene. Exported for tests. */
export function coalesceAnthropicUsers(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const toBlocks = (content: unknown): Array<Record<string, unknown>> => {
    if (typeof content === 'string') return [{ type: 'text', text: content }]
    if (Array.isArray(content)) return content as Array<Record<string, unknown>>
    return [{ type: 'text', text: String(content ?? '') }]
  }
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const message of messages) {
    const tail = out[out.length - 1]
    if (message.role === 'user' && tail !== undefined && tail.role === 'user') {
      const blocks = [...toBlocks(tail.content), ...toBlocks(message.content)]
      tail.content = blocks.length === 1 && blocks[0]['type'] === 'text' ? String(blocks[0]['text'] ?? '') : blocks
      continue
    }
    out.push({ role: message.role, content: message.content })
  }
  return out
}

export function newProviderState(prompt: string, images: ImageAttachment[] = []): ProviderState {
  const anthropicContent: unknown =
    images.length === 0
      ? prompt
      : [
          { type: 'text', text: prompt },
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.base64 },
          })),
        ]
  const openaiContent: unknown =
    images.length === 0
      ? prompt
      : [
          { type: 'text', text: prompt },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mime};base64,${img.base64}` },
          })),
        ]
  return {
    anthropicMessages: [{ role: 'user', content: anthropicContent }],
    openaiMessages: [{ role: 'user', content: openaiContent }],
    metaResponseId: null,
    metaFirstInput: {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        ...images.map((img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.base64}` })),
      ],
    },
    metaPendingUser: prompt,
    metaPendingOutputs: null,
  }
}

/** Empty seed for --resume: rebuildState replays the persisted turns, so
 * seeding the prompt here would duplicate it (P0-5). */
export function emptyProviderState(): ProviderState {
  return {
    anthropicMessages: [],
    openaiMessages: [],
    metaResponseId: null,
    metaFirstInput: null,
    metaPendingUser: null,
    metaPendingOutputs: null,
  }
}

function toAnthropicTools(entries: ToolInfo[]) {
  return entries.map((entry) => ({ name: entry.name, description: entry.description, input_schema: entry.parameters }))
}

function toOpenAITools(entries: ToolInfo[]) {
  return entries.map((entry) => ({ type: 'function' as const, function: { name: entry.name, description: entry.description, parameters: entry.parameters } }))
}

function toMetaTools(entries: ToolInfo[]) {
  return entries.map((entry) => ({ type: 'function' as const, name: entry.name, description: entry.description, parameters: entry.parameters }))
}

/** Transient statuses worth a retry (429/529 rate limits, 5xx, 408/425). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** POST with jittered backoff on 429/529/5xx/timeout (P0-7). Model calls
 * happen before any tool runs, so a retried call cannot double-execute. */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init)
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === attempts) return response
      // drain nothing — the caller reads the final failure body
      await sleep(Math.min(5000, 300 * 2 ** (attempt - 1)) + Math.random() * 250)
    } catch (err) {
      lastError = err
      if (attempt === attempts) throw err
      await sleep(Math.min(5000, 300 * 2 ** (attempt - 1)) + Math.random() * 250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const META_URL = 'https://api.meta.ai/v1/responses'

/** Combine the per-call timeout with the user's stop signal. */
function mergedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  try {
    return AbortSignal.any([timeout, signal])
  } catch {
    return timeout
  }
}

function parseMetaResponse(data: {
  id?: string
  status?: string
  incomplete_details?: unknown
  output?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; id?: string; name?: string; arguments?: string }[]
}): ModelTurn & { responseId?: string } {
  const outputs = data.output ?? []
  const text = outputs
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('\n')
  const calls: ToolCall[] = []
  for (const item of outputs) {
    if (item.type !== 'function_call') continue
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
    } catch {
      input = {}
    }
    calls.push({ id: item.call_id ?? item.id ?? '', name: item.name ?? '', input })
  }
  const truncated = data.status === 'incomplete'
  return { text, calls, truncated, responseId: data.id }
}

/** Minimal SSE parser for the Meta streaming channel (event: + data: lines).
 * Tolerates CRLF, accumulates multiple data: lines per block (spec), and
 * skips the [DONE] terminator. Used by the non-streaming fallback path;
 * the live path reads incrementally via readMetaStream. */
export function parseMetaSseEvents(raw: string): { deltas: string[]; final: unknown | null } {
  const deltas: string[] = []
  let final: unknown | null = null
  const blocks = raw.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    let event = ''
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) continue
    const dataText = dataLines.filter((line) => line !== '[DONE]').join('\n').trim()
    if (dataText === '' || dataText === '[DONE]') continue
    if (event === 'response.output_text.delta') {
      try {
        const parsed = JSON.parse(dataText) as { delta?: string }
        if (typeof parsed.delta === 'string') deltas.push(parsed.delta)
      } catch {
        // partial chunk — ignore
      }
    } else if (event === 'response.completed') {
      try {
        final = (JSON.parse(dataText) as { response?: unknown }).response ?? JSON.parse(dataText)
      } catch {
        // ignore
      }
    }
  }
  return { deltas, final }
}

/** Cap for live-streamed text before a truncation mark (P1-2). */
const META_STREAM_MAX = 20_000

/** Incremental SSE reader: parses chunks as they arrive, forwards each
 * redacted delta to onProgress live, and marks truncation instead of
 * silently slicing (P1-2). Falls back to buffered parsing when the
 * body stream is unavailable (tests, non-browser transports). */
async function readMetaStream(
  response: Response,
  onProgress: (line: string) => void,
  maxChars = META_STREAM_MAX,
): Promise<{ deltas: string[]; final: unknown | null; truncated: boolean }> {
  if (response.body === null || typeof (response.body as ReadableStream).getReader !== 'function') {
    const raw = await response.text()
    const { deltas, final } = parseMetaSseEvents(raw)
    let total = 0
    let truncated = false
    for (const delta of deltas) {
      if (delta === '') continue
      total += delta.length
      if (total > maxChars && !truncated) {
        truncated = true
        onProgress(`… [truncated ${total - maxChars} chars of streamed output]`)
        continue
      }
      if (!truncated) onProgress(redactSecrets(delta).slice(0, 500))
    }
    return { deltas, final, truncated }
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const deltas: string[] = []
  let final: unknown | null = null
  let total = 0
  let truncated = false
  const handleBlock = (block: string) => {
    const lines = block.split(/\r?\n/)
    let event = ''
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return
    const dataText = dataLines.filter((line) => line !== '[DONE]').join('\n').trim()
    if (dataText === '' || dataText === '[DONE]') return
    if (event === 'response.output_text.delta') {
      try {
        const parsed = JSON.parse(dataText) as { delta?: string }
        if (typeof parsed.delta === 'string' && parsed.delta !== '') {
          deltas.push(parsed.delta)
          total += parsed.delta.length
          if (total > maxChars) {
            if (!truncated) {
              truncated = true
              onProgress(`… [truncated ${total - maxChars} chars of streamed output]`)
            }
          } else {
            onProgress(redactSecrets(parsed.delta).slice(0, 500))
          }
        }
      } catch {
        // partial chunk — ignore
      }
    } else if (event === 'response.completed') {
      try {
        final = (JSON.parse(dataText) as { response?: unknown }).response ?? JSON.parse(dataText)
      } catch {
        // ignore
      }
    }
  }
  while (!done) {
    const chunk = await reader.read()
    done = chunk.done
    buffer += decoder.decode(chunk.value, { stream: !done })
    let sep = /\r?\n\r?\n/.exec(buffer)
    while (sep !== null) {
      handleBlock(buffer.slice(0, sep.index))
      buffer = buffer.slice(sep.index + sep[0].length)
      sep = /\r?\n\r?\n/.exec(buffer)
    }
  }
  if (buffer.trim() !== '') handleBlock(buffer)
  return { deltas, final, truncated }
}

export interface MetaHistoryTurn {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolCalls?: { id: string; name: string; input: Record<string, unknown> }[]
  toolResults?: { id: string; content: string; isError?: boolean }[]
}

export async function callModel(
  config: AgentConfig,
  state: ProviderState,
  entries: ToolInfo[],
  systemPrompt: string,
  onProgress?: (line: string) => void,
  /** full turns for the Meta re-anchor fallback (chained id expiry) */
  history?: MetaHistoryTurn[],
  /** user stop signal: aborts the in-flight fetch/stream immediately */
  signal?: AbortSignal,
): Promise<ModelTurn | { error: string }> {
  try {
    if (signal?.aborted) return { error: 'stopped by user' }
    if (config.provider === 'meta') return callMeta(config, state, entries, systemPrompt, onProgress, history, signal)
    if (config.provider === 'anthropic') return callAnthropic(config, state, entries, systemPrompt, signal)
    const url = config.provider === 'compat'
      ? `${(config.baseURL ?? '').replace(/\/+$/, '')}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions'
    return callOpenAI(config, state, entries, systemPrompt, url, signal)
  } catch (err) {
    const hint = err instanceof TypeError ? ' (network/CORS — the browser could not reach the API)' : ''
    return { error: `${err instanceof Error ? err.message : String(err)}${hint}` }
  }
}

async function callAnthropic(
  config: AgentConfig,
  state: ProviderState,
  entries: ToolInfo[],
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<ModelTurn | { error: string }> {
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: mergedSignal(120_000, signal),
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens ?? 8192,
      system: systemPrompt,
      messages: state.anthropicMessages,
      tools: toAnthropicTools(entries),
    }),
  })
  if (!response.ok) {
    return { error: `anthropic ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
  }
  const data = (await response.json()) as {
    stop_reason?: string
    content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
  }
  const text = (data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  const calls = (data.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }))
  return { text, calls, truncated: data.stop_reason === 'max_tokens' }
}

async function callOpenAI(
  config: AgentConfig,
  state: ProviderState,
  entries: ToolInfo[],
  systemPrompt: string,
  url = 'https://api.openai.com/v1/chat/completions',
  signal?: AbortSignal,
): Promise<ModelTurn | { error: string }> {
  if (url.startsWith('/chat/completions') || url === 'chat/completions') {
    return { error: 'compat provider needs "baseURL" in ~/.cell/agent.json (e.g. https://api.x.ai/v1)' }
  }
  const response = await fetchWithRetry(url, {
    method: 'POST',
    signal: mergedSignal(120_000, signal),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: systemPrompt }, ...state.openaiMessages],
      tools: toOpenAITools(entries),
    }),
  })
  if (!response.ok) {
    return { error: `${config.provider} ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
  }
  const data = (await response.json()) as {
    choices: { finish_reason?: string; message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
  }
  const message = data.choices[0]?.message
  const calls = (message?.tool_calls ?? []).map((call) => {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments) as Record<string, unknown>
    } catch {
      input = {}
    }
    return { id: call.id, name: call.function.name, input }
  })
  return { text: message?.content ?? '', calls, truncated: data.choices[0]?.finish_reason === 'length' }
}

async function callMeta(
  config: AgentConfig,
  state: ProviderState,
  entries: ToolInfo[],
  systemPrompt: string,
  onProgress?: (line: string) => void,
  history?: MetaHistoryTurn[],
  signal?: AbortSignal,
): Promise<ModelTurn | { error: string }> {
  const maxOutput = config.maxOutputTokens ?? 4096
  const tools = toMetaTools(entries)
  // Streaming when the shell offers a progress line: text deltas stream
  // live through onProgress; the final response still comes from the
  // response.completed event. Non-streaming otherwise (simpler for tests).
  if (onProgress !== undefined) {
    return callMetaStream(config, state, tools, systemPrompt, maxOutput, onProgress, history, signal)
  }
  const reasoning = config.thinking !== undefined && config.thinking !== 'off' ? { reasoning: { effort: config.thinking } } : {}
  const requestBody = state.metaResponseId === null
    ? {
        model: config.model,
        input: metaInput(state, systemPrompt),
        tools,
        tool_choice: 'auto',
        max_output_tokens: maxOutput,
        ...reasoning,
      }
    : {
        model: config.model,
        previous_response_id: state.metaResponseId,
        input: metaInput(state, systemPrompt),
        tools,
        tool_choice: 'auto',
        max_output_tokens: maxOutput,
        ...reasoning,
      }
  const response = await fetchWithRetry(META_URL, {
    method: 'POST',
    signal: mergedSignal(180_000, signal),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(requestBody),
  })
  if (!response.ok) {
    const reanchored = await tryMetaReanchor(response, config, state, tools, systemPrompt, maxOutput, history)
    if (reanchored !== null) return reanchored
    return { error: `meta ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
  }
  const data = (await response.json()) as Parameters<typeof parseMetaResponse>[0]
  const parsed = parseMetaResponse(data)
  if (parsed.responseId) state.metaResponseId = parsed.responseId
  return parsed
}

async function callMetaStream(
  config: AgentConfig,
  state: ProviderState,
  tools: ReturnType<typeof toMetaTools>,
  systemPrompt: string,
  maxOutput: number,
  onProgress: (line: string) => void,
  history?: MetaHistoryTurn[],
  signal?: AbortSignal,
): Promise<ModelTurn | { error: string }> {
  const reasoning = config.thinking !== undefined && config.thinking !== 'off' ? { reasoning: { effort: config.thinking } } : {}
  const requestBody =
    state.metaResponseId === null
      ? {
          model: config.model,
          stream: true,
          input: metaInput(state, systemPrompt),
          tools,
          tool_choice: 'auto',
          max_output_tokens: maxOutput,
          ...reasoning,
        }
      : {
          model: config.model,
          stream: true,
          previous_response_id: state.metaResponseId,
          input: metaInput(state, systemPrompt),
          tools,
          tool_choice: 'auto',
          max_output_tokens: maxOutput,
          ...reasoning,
        }
  const response = await fetchWithRetry(META_URL, {
    method: 'POST',
    signal: mergedSignal(180_000, signal),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, accept: 'text/event-stream' },
    body: JSON.stringify(requestBody),
  })
  if (!response.ok) {
    const reanchored = await tryMetaReanchorStream(response, config, state, tools, systemPrompt, maxOutput, history, onProgress)
    if (reanchored !== null) return reanchored
    return { error: `meta ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
  }
  const { final } = await readMetaStream(response, onProgress)
  if (final === null) return { error: 'meta: stream ended without response.completed' }
  const parsed = parseMetaResponse(final as Parameters<typeof parseMetaResponse>[0])
  if (parsed.responseId) state.metaResponseId = parsed.responseId
  return parsed
}

/**
 * Long runs can fail a chained follow-up with 400 "referenced response
 * not found or expired". Re-anchor once: drop the dead chain id and
 * replay the flattened conversation as a fresh first turn, so the run
 * continues instead of dying honestly with its work kept but summary lost.
 */
function isMetaChainExpiry(status: number, bodyText: string): boolean {
  return status === 400 && /referenced response|response not found|expired/i.test(bodyText)
}

function metaReanchorText(history: MetaHistoryTurn[] | undefined, pendingUser: string | null): string {
  const lines: string[] = [
    '[re-anchored: the previous chained response expired, replaying the conversation as a fresh turn \u2014 continue the task]',
  ]
  for (const turn of (history ?? []).slice(-40)) {
    if (turn.role === 'user') {
      lines.push(`user: ${turn.text.slice(0, 8000)}`)
    } else if (turn.role === 'assistant') {
      const calls = (turn.toolCalls ?? []).map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 500)}`).join('; ')
      lines.push(`assistant: ${turn.text.slice(0, 4000)}${calls ? ` [tool calls: ${calls}]` : ''}`)
    } else {
      const results = (turn.toolResults ?? []).map((r) => r.content.slice(0, 4000)).join('\n')
      lines.push(`tool: ${(results || turn.text).slice(0, 8000)}`)
    }
  }
  if (pendingUser !== null && pendingUser !== '') lines.push(`user: ${pendingUser.slice(0, 8000)}`)
  return lines.join('\n').slice(0, 60_000)
}

async function tryMetaReanchor(
  response: Response,
  config: AgentConfig,
  state: ProviderState,
  tools: ReturnType<typeof toMetaTools>,
  systemPrompt: string,
  maxOutput: number,
  history: MetaHistoryTurn[] | undefined,
): Promise<ModelTurn | null> {
  const bodyText = await response.clone().text().catch(() => '')
  if (!isMetaChainExpiry(response.status, bodyText) || state.metaResponseId === null) return null
  state.metaResponseId = null
  state.metaFirstInput = {
    role: 'user',
    content: [{ type: 'input_text', text: metaReanchorText(history, state.metaPendingUser) }],
  }
  state.metaPendingUser = null
  state.metaPendingOutputs = null
  const retry = await fetchWithRetry(META_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      input: metaInput(state, systemPrompt),
      tools,
      tool_choice: 'auto',
      max_output_tokens: maxOutput,
    }),
  })
  if (!retry.ok) return null
  const data = (await retry.json()) as Parameters<typeof parseMetaResponse>[0]
  const parsed = parseMetaResponse(data)
  if (parsed.responseId) state.metaResponseId = parsed.responseId
  return parsed
}

async function tryMetaReanchorStream(
  response: Response,
  config: AgentConfig,
  state: ProviderState,
  tools: ReturnType<typeof toMetaTools>,
  systemPrompt: string,
  maxOutput: number,
  history: MetaHistoryTurn[] | undefined,
  onProgress: (line: string) => void,
): Promise<ModelTurn | { error: string } | null> {
  const bodyText = await response.clone().text().catch(() => '')
  if (!isMetaChainExpiry(response.status, bodyText) || state.metaResponseId === null) return null
  state.metaResponseId = null
  state.metaFirstInput = {
    role: 'user',
    content: [{ type: 'input_text', text: metaReanchorText(history, state.metaPendingUser) }],
  }
  state.metaPendingUser = null
  state.metaPendingOutputs = null
  const retry = await fetchWithRetry(META_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, accept: 'text/event-stream' },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      input: metaInput(state, systemPrompt),
      tools,
      tool_choice: 'auto',
      max_output_tokens: maxOutput,
    }),
  })
  if (!retry.ok) return null
  const { final } = await readMetaStream(retry, onProgress)
  if (final === null) return { error: 'meta: stream ended without response.completed' }
  const parsed = parseMetaResponse(final as Parameters<typeof parseMetaResponse>[0])
  if (parsed.responseId) state.metaResponseId = parsed.responseId
  return parsed
}

/** Stash function_call_output items for the next Meta request (chained via previous_response_id). */
export function setMetaOutputs(state: ProviderState, outputs: { type: string; call_id: string; output: string }[]): void {
  state.metaPendingOutputs = outputs
  state.metaPendingUser = null
}

/** Stash new user text for the next chained Meta request (e.g. after --resume). */
export function setMetaPendingUser(state: ProviderState, text: string): void {
  state.metaPendingUser = text
  state.metaPendingOutputs = null
}

/** Resume flush (P0-6): tool outputs recorded in the saved session but
 * never sent on the chain go out together with the new user message —
 * outputs first, then the user turn, in one chained request. */
export function setMetaResumeFlush(
  state: ProviderState,
  outputs: { type: string; call_id: string; output: string }[],
  text: string,
): void {
  state.metaPendingOutputs = outputs
  state.metaPendingUser = text
}

/**
 * Input for the next Meta request. First turn: system + user prompt.
 * Later turns chain through previous_response_id: queued tool results go
 * first as function_call_output items, then a fresh user message — so a
 * resumed run flushes unsent outputs before the new prompt (P0-6).
 */
function metaInput(state: ProviderState, systemPrompt: string): Record<string, unknown>[] {
  if (state.metaResponseId === null) {
    return [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      state.metaFirstInput ?? { role: 'user', content: [{ type: 'input_text', text: state.metaPendingUser ?? '' }] },
    ]
  }
  const items: Record<string, unknown>[] = [...(state.metaPendingOutputs ?? [])]
  state.metaPendingOutputs = null
  if (state.metaPendingUser !== null) {
    const text = state.metaPendingUser
    state.metaPendingUser = null
    items.push({ role: 'user', content: [{ type: 'input_text', text }] })
  }
  return items
}

/** Cap for live provider message logs (P1-4). Meta needs none — it chains
 * through previous_response_id instead of a local log. */
const MAX_LIVE_MESSAGES = 100

/** Drop a prefix of the log, then repair the new head: the tail must not
 * start with a continuation (tool_result/tool message) whose opener was
 * dropped, and must not break user/assistant alternation. The prompt
 * (index 0) is always kept. */
function capLog<T>(messages: T[], roleOf: (message: T) => string, isContinuation: (message: T) => boolean): void {
  while (messages.length > MAX_LIVE_MESSAGES) {
    let cut = 1 + (messages.length - MAX_LIVE_MESSAGES)
    while (cut < messages.length && (isContinuation(messages[cut]) || roleOf(messages[cut]) === roleOf(messages[0]))) cut++
    if (cut >= messages.length) cut = messages.length - 1
    messages.splice(1, Math.max(1, cut - 1))
  }
}

/** Drop oldest whole exchanges, newest kept, never orphaning a tool_use
 * from its tool_result (P1-4). Keeps the first message (the prompt). */
export function capLiveState(state: ProviderState): void {
  // anthropic: skip tool_result replies (their assistant was dropped) and any
  // user turn (parity with the kept prompt) — the tail starts at an
  // assistant whose pairs follow it intact. openai: skip orphan tool msgs.
  capLog(state.anthropicMessages, (message) => message.role, (message) => message.role === 'user')
  capLog(
    state.openaiMessages,
    (message) => message.role,
    (message) => message.role === 'tool',
  )
}

