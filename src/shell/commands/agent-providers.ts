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
 *   stream:true gives SSE: `event: response.output_text.delta` /
 *   `data: {"delta":"…"}` chunks, then `event: response.completed` with the
 *   full response, then a `[DONE]` terminator line.
 *
 * ANTHROPIC: POST https://api.anthropic.com/v1/messages (messages array,
 * tool_use blocks, browser-direct-access header) — unchanged from before.
 * OPENAI: POST https://api.openai.com/v1/chat/completions (chat messages,
 * function tools) — unchanged from before.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'meta'

export interface AgentConfig {
  provider: ProviderKind
  apiKey: string
  model: string
  maxOutputTokens?: number
}

export interface ModelTurn {
  text: string
  calls: ToolCall[]
  truncated: boolean
}

export interface ProviderState {
  anthropicMessages: { role: 'user' | 'assistant'; content: unknown }[]
  openaiMessages: { role: string; content: string | null }[]
  metaResponseId: string | null
  metaFirstInput: { role: string; content: { type: string; text: string }[] } | null
}

export function newProviderState(prompt: string): ProviderState {
  return {
    anthropicMessages: [{ role: 'user', content: prompt }],
    openaiMessages: [{ role: 'user', content: prompt }],
    metaResponseId: null,
    metaFirstInput: { role: 'user', content: [{ type: 'input_text', text: prompt }] },
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

const META_URL = 'https://api.meta.ai/v1/responses'

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

/** Minimal SSE parser for the Meta streaming channel (event: + data: lines). */
export function parseMetaSseEvents(raw: string): { deltas: string[]; final: unknown | null } {
  const deltas: string[] = []
  let final: unknown | null = null
  const blocks = raw.split('\n\n')
  for (const block of blocks) {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1].trim()
    const dataMatch = /^data:\s*([\s\S]+)$/m.exec(block)
    if (!dataMatch) continue
    const dataText = dataMatch[1].trim()
    if (dataText === '[DONE]') continue
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

export async function callModel(
  config: AgentConfig,
  state: ProviderState,
  entries: ToolInfo[],
  systemPrompt: string,
  onProgress?: (line: string) => void,
): Promise<ModelTurn | { error: string }> {
  try {
    if (config.provider === 'meta') return callMeta(config, state, entries, systemPrompt, onProgress)
    if (config.provider === 'anthropic') return callAnthropic(config, state, entries, systemPrompt)
    return callOpenAI(config, state, entries, systemPrompt)
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
): Promise<ModelTurn | { error: string }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
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
): Promise<ModelTurn | { error: string }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: systemPrompt }, ...state.openaiMessages],
      tools: toOpenAITools(entries),
    }),
  })
  if (!response.ok) {
    return { error: `openai ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
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
): Promise<ModelTurn | { error: string }> {
  const maxOutput = config.maxOutputTokens ?? 4096
  const tools = toMetaTools(entries)
  // First turn carries the system prompt + user prompt; later turns chain
  // through previous_response_id with function_call_output inputs.
  const body: Record<string, unknown> = state.metaResponseId === null
    ? {
        model: config.model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          state.metaFirstInput,
        ],
        tools,
        tool_choice: 'auto',
        max_output_tokens: maxOutput,
      }
    : null as unknown as Record<string, unknown>
  void body

  // Streaming when the shell offers a progress line: text deltas stream
  // live through onProgress; the final response still comes from the
  // response.completed event. Non-streaming otherwise (simpler for tests).
  if (onProgress !== undefined) {
    return callMetaStream(config, state, tools, systemPrompt, maxOutput, onProgress)
  }
  const requestBody = state.metaResponseId === null
    ? {
        model: config.model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          state.metaFirstInput,
        ],
        tools,
        tool_choice: 'auto',
        max_output_tokens: maxOutput,
      }
    : {
        model: config.model,
        previous_response_id: state.metaResponseId,
        input: (state as { pendingOutputs?: unknown }).pendingOutputs ?? [],
        tools,
        tool_choice: 'auto',
        max_output_tokens: maxOutput,
      }
  const response = await fetch(META_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(requestBody),
  })
  if (!response.ok) {
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
): Promise<ModelTurn | { error: string }> {
  const requestBody =
    state.metaResponseId === null
      ? {
          model: config.model,
          stream: true,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
            state.metaFirstInput,
          ],
          tools,
          tool_choice: 'auto',
          max_output_tokens: maxOutput,
        }
      : {
          model: config.model,
          stream: true,
          previous_response_id: state.metaResponseId,
          input: (state as { pendingOutputs?: unknown }).pendingOutputs ?? [],
          tools,
          tool_choice: 'auto',
          max_output_tokens: maxOutput,
        }
  const response = await fetch(META_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, accept: 'text/event-stream' },
    body: JSON.stringify(requestBody),
  })
  if (!response.ok) {
    return { error: `meta ${response.status}: ${redactSecrets((await response.text()).slice(0, 300))}` }
  }
  const raw = await response.text()
  const { deltas, final } = parseMetaSseEvents(raw)
  for (const delta of deltas) {
    if (delta !== '') onProgress(delta.slice(0, 500))
  }
  if (final === null) return { error: 'meta: stream ended without response.completed' }
  const parsed = parseMetaResponse(final as Parameters<typeof parseMetaResponse>[0])
  if (parsed.responseId) state.metaResponseId = parsed.responseId
  return parsed
}

/** Stash function_call_output items for the next Meta request (chained via previous_response_id). */
export function setMetaOutputs(state: ProviderState, outputs: { type: string; call_id: string; output: string }[]): void {
  (state as { pendingOutputs?: unknown }).pendingOutputs = outputs;
}

export { META_URL }
