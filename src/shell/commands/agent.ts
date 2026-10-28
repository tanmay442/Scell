import type { Vfs } from '../../vfs/types'
import type { CommandResult, ShellLike } from './npm'
import { redactSecrets } from './agent-redact'
import {
  registryEntries,
  runTool,
  approvalFor,
  type CustomToolDef,
  type ToolCall,
  type ToolInfo,
  type ToolResult,
} from './agent-tools'
import { loadSkills, skillIndex } from './agent-skills'
import { saveSession, loadSession, sessionId, type SessionTurn } from './agent-sessions'
import { expandSlashCommand } from './agent-commands'
import {
  callModel,
  newProviderState,
  setMetaOutputs,
  setMetaPendingUser,
  type AgentConfig,
  type ProviderKind,
  type ProviderState,
} from './agent-providers'

/**
 * `cell agent` — a headless agentic harness that lives where the agent works:
 * the Cell filesystem. An LLM (Meta, Anthropic or OpenAI — your key) loops
 * over real tools — bash (the same shell you type into), read, write, edit,
 * ls, load_skill plus custom ~/.cell/tools/*.json — until the task is done.
 * Long tasks are the point: node runs 5 minutes, git and npm are the real
 * thing, and every file the agent touches lands in the VFS you see in the tree.
 *
 * Configure ~/.cell/agent.json:
 *   { "provider": "meta", "model": "muse-spark-1.3-contributor" }
 * The Meta key is read at runtime from /home/user's host auth file
 * (~/.pi/agent/auth.json → meta.key on this machine) or from "apiKey"
 * in agent.json; anthropic/openai keep working with an apiKey as before.
 *
 * Sessions persist to ~/.cell/sessions/<id>.json; resume with
 * `cell agent --resume <id> "continue…"`. Tool output is truncated into the
 * context (last turns kept; full compaction is a follow-up). Secrets are
 * redacted from the transcript and the saved session.
 */

const AGENT_CONFIG_PATH = '/home/user/.cell/agent.json'
const AUTH_MIRROR_PATH = '/home/user/.cell/auth.json'
const DEFAULT_MAX_STEPS = 30
const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  meta: 'muse-spark-1.3-contributor',
}

const KNOWN_PROVIDERS: ProviderKind[] = ['anthropic', 'openai', 'meta']

const BASE_SYSTEM_PROMPT = `You are an autonomous coding agent running INSIDE Cell — a complete development environment in a browser tab. You are not on a normal server; keep this in mind:

- The filesystem is a real POSIX-style tree rooted at /; your home is /home/user (~). Everything persists in this browser.
- The shell is bash-compatible: node, npm, pnpm, npx, tsc, git (real libgit2), curl, plus coreutils (sed, awk, jq, rg, find, xargs, sqlite3…). Pipes and redirection work.
- node runs JavaScript and TypeScript directly. npm installs from the real registry. git clones work over https (github via a CORS relay automatically).
- There is NO child_process, no native binaries, no ssh, no display. Long processes: up to 5 minutes each (node/python); each bash step times out after 120s with exit 124 — split long work across steps or raise timeoutMs (max 600000).
- /tmp is volatile scratch: it is never persisted and invisible to python/node runs. Keep anything you want under ~ (~/artifacts for visuals).
- Tool output past 20k chars arrives head+tail truncated with an explicit '… [truncated N chars]' receipt; node/python streams cap at 4MB the same way. Exit codes ride an untruncatable '[exit N]' trailer (124 = timed out); '[oom suspected]' means the run died under memory pressure, not a test failure.
- Edit files with the read/write/edit tools (small precise edits over whole-file rewrites); verify with read and bash (cat, tsc, npm test, git diff).
- python3 runs offline (pyodide fallback exists — matplotlib/numpy/pandas work); write visuals to ~/artifacts.
- Preview browser apps with: cell preview [dir] (the bundler path, not a server).

Work like a careful engineer: inspect before changing, make small verifiable moves, run the checks, and say plainly what you did at the end.`

function hostMetaKey(): string | null {
  // Node-only path (unit tests, scripts): read the machine key without a
  // static node:fs import (that would break the browser bundle).
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown; env?: Record<string, string> } }).process
    const fromEnv = proc?.env?.CELL_AGENT_LIVE_KEY
    if (fromEnv) return fromEnv
    const getModule = proc?.getBuiltinModule
    if (!getModule) return null
    const fs = getModule.call(proc, 'fs') as { readFileSync?: (path: string, enc: string) => string; existsSync?: (path: string) => boolean } | null
    if (!fs?.readFileSync) return null
    const home = proc?.env?.HOME ?? '/home/tanmay442'
    for (const path of ['/home/tanmay442/.pi/agent/auth.json', `${home}/.pi/agent/auth.json`]) {
      try {
        const raw = fs.readFileSync(path, 'utf8')
        const key = (JSON.parse(raw) as { meta?: { key?: string } }).meta?.key
        if (typeof key === 'string' && key !== '') return key
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // browser or unreadable — fall through to the VFS mirror
  }
  return null
}

function readConfig(vfs: Vfs): { config: AgentConfig } | { error: string } {
  const raw = vfs.read(AGENT_CONFIG_PATH)
  if (raw === null) {
    return {
      error: [
        'cell agent: no model configured — create ~/.cell/agent.json:',
        '',
        '  {',
        '    "provider": "meta",',
        '    "model": "muse-spark-1.3-contributor"',
        '  }',
        '',
        'meta resolves its key from the machine auth file (no apiKey needed);',
        'anthropic/openai need { "provider": "anthropic", "apiKey": "sk-…", "model": "…" }.',
        'Anthropic calls send the browser-direct-access header, so no proxy is needed.',
      ].join('\n'),
    }
  }
  try {
    const parsed = JSON.parse(raw) as {
      provider?: string
      apiKey?: string
      model?: string
      max_output_tokens?: number
      approval?: string
    }
    if (parsed.provider !== undefined && !(KNOWN_PROVIDERS as readonly string[]).includes(parsed.provider)) {
      return { error: `cell agent: unknown provider '${parsed.provider}' (use meta, anthropic or openai)\n` }
    }
    const provider = (parsed.provider ?? 'anthropic') as ProviderKind
    let apiKey = parsed.apiKey ?? ''
    if (!apiKey && provider === 'meta') {
      apiKey = hostMetaKey() ?? ''
      if (!apiKey) {
        // VFS mirror of the host auth file (shape: { "meta": { "key": "…" } })
        try {
          const mirror = vfs.read(AUTH_MIRROR_PATH)
          if (mirror !== null) {
            const key = (JSON.parse(mirror) as { meta?: { key?: string } }).meta?.key
            if (typeof key === 'string' && key !== '') apiKey = key
          }
        } catch {
          // ignore — error below covers it
        }
      }
    }
    if (!apiKey) return { error: 'cell agent: apiKey missing in ~/.cell/agent.json\n' }
    const maxOutput = typeof parsed.max_output_tokens === 'number' ? parsed.max_output_tokens : undefined
    return {
      config: {
        provider,
        apiKey,
        model: parsed.model ?? DEFAULT_MODELS[provider],
        ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
      },
    }
  } catch {
    return { error: 'cell agent: ~/.cell/agent.json is not valid JSON\n' }
  }
}

function clip(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines ? text : `${all.slice(0, lines).join('\n')}\n… [truncated ${all.length - lines} lines]`
}

function toolSummary(call: ToolCall): string {
  if (call.name === 'bash') return String(call.input.command ?? '')
  if (call.name === 'load_skill') return String(call.input.name ?? '')
  if (call.input.path !== undefined) return String(call.input.path)
  if (call.input.cwd !== undefined) return String(call.input.cwd)
  return JSON.stringify(call.input).slice(0, 120)
}

export interface RunAgentOpts {
  cwd: string
  shell: ShellLike
  onProgress?: (line: string) => void
}

/** The agent loop. Returns the full transcript for the terminal. */
export async function runAgent(vfs: Vfs, args: string[], opts: RunAgentOpts): Promise<CommandResult> {
  const valueFlags = new Set(['--steps', '--max-steps', '-s', '--resume', '--session'])
  const words: string[] = []
  let maxSteps = DEFAULT_MAX_STEPS
  let resumeId: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--resume' || arg === '--session') {
      resumeId = args[++i] ?? null
      continue
    }
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) {
        maxSteps = parseInt(args[++i] ?? '', 10) || DEFAULT_MAX_STEPS
      } else if (arg === '--help' || arg === '-h') {
        return {
          stdout: [
            'usage: cell agent "do something in this workspace" [--steps N] [--resume <id>]',
            '',
            '  /commit, /preview     slash commands from ~/.cell/commands/*.md',
            '  --resume <id>         continue a session in ~/.cell/sessions/',
            '  --steps N             step budget (default 30)',
            '',
            'config: ~/.cell/agent.json { provider: meta|anthropic|openai, model, apiKey? }',
            'tools: bash/read/edit/write/ls/load_skill + ~/.cell/tools/*.json',
            'skills: ~/.cell/skills/<name>/SKILL.md (+ <project>/.cell/skills/ override)',
          ].join('\n') + '\n',
          stderr: '',
          exitCode: 0,
        }
      }
      continue
    }
    words.push(arg)
  }
  let prompt = words.join(' ').trim()

  const configured = readConfig(vfs)
  if ('error' in configured) return { stdout: '', stderr: `${configured.error}\n`, exitCode: 1 }

  // resume: restore transcript + turns, then continue with the new prompt
  let resumedTurns: SessionTurn[] = []
  let resumedTranscript: string[] = []
  let resumedResponseId: string | null = null
  let sessionPrompt = prompt
  if (resumeId !== null) {
    const loaded = loadSession(vfs, resumeId)
    if ('error' in loaded) return { stdout: '', stderr: `cell agent: ${loaded.error}`, exitCode: 1 }
    resumedTurns = loaded.session.turns
    resumedTranscript = loaded.session.transcript
    resumedResponseId = [...loaded.session.turns].reverse().find((turn) => turn.responseId)?.responseId ?? null
    if (!prompt) prompt = loaded.session.prompt
    sessionPrompt = prompt
    if (configured.config.provider !== loaded.session.provider) {
      return { stdout: '', stderr: `cell agent: session is ${loaded.session.provider}, config is ${configured.config.provider} — match them to resume\n`, exitCode: 1 }
    }
  }

  if (!prompt) {
    return {
      stdout: 'usage: cell agent "do something in this workspace" [--steps N] [--resume <id>]\n',
      stderr: '',
      exitCode: 1,
    }
  }

  // slash commands expand before the model sees the prompt
  const expanded = expandSlashCommand(vfs, opts.cwd, prompt)
  prompt = expanded.prompt

  const { config } = configured
  const { entries, warnings } = registryEntries(vfs)
  const customTools = new Map<string, CustomToolDef>()
  try {
    if (vfs.isDir('/home/user/.cell/tools')) {
      for (const name of vfs.readDir('/home/user/.cell/tools')) {
        if (!name.endsWith('.json')) continue
        const raw = vfs.read(`/home/user/.cell/tools/${name}`)
        if (raw === null) continue
        try {
          const parsed = JSON.parse(raw) as CustomToolDef
          if (parsed?.run?.kind === 'bash') customTools.set(parsed.name, parsed)
        } catch {
          // warning already collected by registryEntries
        }
      }
    }
  } catch {
    // no custom tools
  }
  const { skills } = loadSkills(vfs, opts.cwd)
  const skillBodies = new Map(skills.map((skill) => [skill.name, `# ${skill.name}\n\n${skill.body}`]))

  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nSkills (one line each — use load_skill for the full body when the task needs it):\n${skillIndex(skills)}\n\nCustom tools: ${[...customTools.keys()].join(', ') || '(none)'} — declared in ~/.cell/tools/*.json, approval: ask.`

  const state: ProviderState = newProviderState(expanded.prompt)
  if (resumeId !== null) {
    rebuildState(state, config.provider, resumedTurns, resumedResponseId)
    if (expanded.prompt !== '') pushUserTurn(state, config.provider, expanded.prompt)
  }

  const transcript: string[] = resumeId !== null
    ? [...resumedTranscript, `agent ▸ (resumed ${resumeId}) ${redactSecrets(sessionPrompt)}${expanded.command ? ` [/${expanded.command}]` : ''}`]
    : [`agent ▸ ${redactSecrets(prompt)}`, `model: ${config.provider}/${config.model}, max ${maxSteps} steps`]
  if (resumeId === null && expanded.command) transcript[0] += ` [/${expanded.command}]`
  for (const warning of warnings) transcript.push(`agent warning: ${warning}`)
  if (skills.length > 0) transcript.push(`skills: ${skills.map((s) => s.name).join(', ')} (load_skill for the body)`)

  const turns: SessionTurn[] = resumeId !== null ? [...resumedTurns] : [{ role: 'user', text: prompt }]
  if (resumeId !== null && expanded.prompt !== '') turns.push({ role: 'user', text: expanded.prompt })

  const deps = { vfs, shell: opts.shell, cwd: opts.cwd, skills: skillBodies, customTools }
  const id = resumeId ?? sessionId()
  const startedAt = new Date().toISOString()

  const persist = (steps: number) => {
    try {
      saveSession(vfs, { id, startedAt, provider: config.provider, model: config.model, prompt: sessionPrompt, transcript, turns, steps })
    } catch {
      // sessions are best-effort — the transcript still returns
    }
  }

  for (let step = 1; step <= maxSteps; step++) {
    const model = await callModel(config, state, entries, systemPrompt, opts.onProgress, turns)
    if ('error' in model) {
      transcript.push(`agent ✗ ${redactSecrets(model.error)}`)
      persist(step)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 1 }
    }

    if (model.text.trim().length > 0 && model.calls.length === 0) {
      transcript.push(`\n${redactSecrets(model.text.trim())}`)
      turns.push({
        role: 'assistant',
        text: model.text,
        ...(model && 'responseId' in model && typeof (model as { responseId?: string }).responseId === 'string'
          ? { responseId: (model as { responseId?: string }).responseId }
          : {}),
      })
      recordProviderTurn(state, config.provider, model.text, model.calls, turns)
      transcript.push(`session ${id} — resume with \`cell agent --resume ${id} "…"\``)
      persist(step)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }
    if (model.text.trim().length > 0) transcript.push(redactSecrets(`⏺ ${clip(model.text.trim(), 4)}`))

    if (model.truncated) {
      // max_tokens cut the turn mid-stream: partial tool calls would
      // execute with made-up arguments, so discard them and ask to continue
      transcript.push('agent: model output truncated — continuing briefly')
      turns.push({ role: 'assistant', text: model.text })
      if (config.provider === 'anthropic') {
        state.anthropicMessages.push({
          role: 'user',
          content: 'Your previous output was truncated by max_tokens. Continue briefly from where you left off.',
        })
        turns.push({ role: 'user', text: 'Your previous output was truncated by max_tokens. Continue briefly from where you left off.' })
      } else if (config.provider === 'openai') {
        state.openaiMessages.push({ role: 'user', content: 'Your previous output was truncated. Continue briefly from where you left off.' } as never)
        turns.push({ role: 'user', text: 'Your previous output was truncated. Continue briefly from where you left off.' })
      } else {
        setMetaPendingUser(state, 'Your previous output was truncated. Continue briefly from where you left off.')
        turns.push({ role: 'user', text: 'Your previous output was truncated. Continue briefly from where you left off.' })
      }
      continue
    }

    if (model.calls.length === 0) {
      transcript.push('agent: model returned nothing runnable — stopping')
      persist(step)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }

    // record the assistant turn, then execute each tool call
    recordAssistantMessage(state, config.provider, model.text, model.calls)
    turns.push({
      role: 'assistant',
      text: model.text,
      toolCalls: model.calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
      ...(model && 'responseId' in model && typeof (model as { responseId?: string }).responseId === 'string'
        ? { responseId: (model as { responseId?: string }).responseId }
        : {}),
    })

    const toolResults: ToolResult[] = []
    const metaOutputs: { type: string; call_id: string; output: string }[] = []
    for (const call of model.calls) {
      const summary = toolSummary(call)
      // per-tool approval: read/ls/load_skill run; everything else prints
      // a clear prompt line first (non-interactive shells auto-proceed —
      // the line is the audit trail for what the agent touched)
      const approval = approvalFor(entries, call.name)
      if (approval === 'ask') {
        transcript.push(redactSecrets(`❓ approval: ${call.name} ${summary} — auto-approved (non-interactive run)`))
      }
      transcript.push(redactSecrets(`⏺ ${call.name} ${summary}`))
      opts.onProgress?.(`⏺ ${call.name} ${summary}`)
      const result = await runTool(deps, call)
      transcript.push(redactSecrets(clip(result.content.split('\n').map((line) => `  ${line}`).join('\n'), 12)))
      toolResults.push(result)
      metaOutputs.push({ type: 'function_call_output', call_id: call.id, output: result.content })
    }
    turns.push({ role: 'tool', text: toolResults.map((result) => result.content).join('\n'), toolResults: toolResults.map((result) => ({ id: result.id, content: result.content, isError: result.isError })) })

    if (config.provider === 'anthropic') {
      state.anthropicMessages.push({
        role: 'user',
        content: toolResults.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          is_error: result.isError ?? false,
        })),
      })
    } else if (config.provider === 'openai') {
      for (const result of toolResults) {
        state.openaiMessages.push({ role: 'tool', content: result.content, tool_call_id: result.id } as never)
      }
    } else {
      setMetaOutputs(state, metaOutputs)
    }
  }

  transcript.push(`agent: reached the ${maxSteps}-step limit — continue with \`cell agent --resume ${id} "keep going"\``)
  persist(maxSteps)
  return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
}

function pushUserTurn(state: ProviderState, provider: ProviderKind, text: string): void {
  if (provider === 'anthropic') state.anthropicMessages.push({ role: 'user', content: text })
  else if (provider === 'openai') state.openaiMessages.push({ role: 'user', content: text } as never)
  else setMetaPendingUser(state, text)
}

function recordAssistantMessage(state: ProviderState, provider: ProviderKind, text: string, calls: ToolCall[]): void {
  if (provider === 'anthropic') {
    state.anthropicMessages.push({
      role: 'assistant',
      content: [
        ...(text.trim() ? [{ type: 'text', text }] : []),
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
      ],
    })
  } else if (provider === 'openai') {
    state.openaiMessages.push({
      role: 'assistant',
      content: text.trim() || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    } as never)
  }
  // meta needs no local message log — chaining rides previous_response_id
}

function recordProviderTurn(
  state: ProviderState,
  provider: ProviderKind,
  text: string,
  calls: ToolCall[],
  _turns: SessionTurn[],
): void {
  recordAssistantMessage(state, provider, text, calls)
}

function rebuildState(state: ProviderState, provider: ProviderKind, turns: SessionTurn[], responseId: string | null): void {
  if (provider === 'meta') {
    state.metaResponseId = responseId
    state.metaFirstInput = null
    return
  }
  for (const turn of turns) {
    if (turn.role === 'user') {
      pushUserTurn(state, provider, turn.text)
    } else if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      recordAssistantMessage(state, provider, turn.text, turn.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })))
    } else if (turn.role === 'assistant') {
      recordAssistantMessage(state, provider, turn.text, [])
    } else if (turn.role === 'tool' && turn.toolResults) {
      if (provider === 'anthropic') {
        state.anthropicMessages.push({
          role: 'user',
          content: turn.toolResults.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.content,
            is_error: result.isError ?? false,
          })),
        })
      } else {
        for (const result of turn.toolResults) {
          state.openaiMessages.push({ role: 'tool', content: result.content, tool_call_id: result.id } as never)
        }
      }
    }
  }
}

export type { ToolInfo }
