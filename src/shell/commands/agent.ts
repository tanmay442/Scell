import type { Vfs } from '../../vfs/types'
import type { CommandResult, ShellLike } from './shell-types'
import { redactSecrets } from './agent-redact'
import {
  JobManager,
  registryEntries,
  runTool,
  loadCustomTools,
  approvalFor,
  type CustomToolDef,
  type ToolCall,
  type ToolInfo,
  type ToolResult,
} from './agent-tools'
import { loadSkills, skillIndex } from './agent-skills'
import { saveSession, loadSession, sessionId, truncateTurns, type SessionTurn } from './agent-sessions'
import { expandSlashCommand } from './agent-commands'
import {
  callModel,
  newProviderState,
  emptyProviderState,
  capLiveState,
  setMetaOutputs,
  setMetaPendingUser,
  setMetaResumeFlush,
  isOpenAIShaped,
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
// no upper cap by default: the stop button (UI) / Ctrl-C (terminal)
// and per-step timeouts are the guardrails. --steps N sets an explicit one.
const DEFAULT_MAX_STEPS = Number.POSITIVE_INFINITY
const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  meta: 'muse-spark-1.3-contributor',
  compat: 'gpt-4o',
}

const KNOWN_PROVIDERS: ProviderKind[] = ['anthropic', 'openai', 'meta', 'compat']

const BASE_SYSTEM_PROMPT = `You are Cell, a general-purpose AI agent who lives in this browser workspace. Think of yourself as a frontier chat assistant (like Grok or ChatGPT) who also has real tools: bash, files, git, node, python, and a live app preview, all running in this tab.

## First, judgment: most requests need no tools
- Questions, explanations, writing, editing text, brainstorming, advice, plans, summaries of what the user pasted, math you can do reliably in your head: answer directly and well. Do not run commands, explore the filesystem, or check things "just in case" for these — it only slows the answer down.
- Use tools only when the task actually needs them: reading or changing files, running code or tests, computation beyond reliable mental math (use python), producing a file or a visual, checking something real about this workspace, or fetching current external data.
- If a request is ambiguous in a way that changes the work, ask one short question. Otherwise pick the sensible reading and go.
- Be direct: lead with the answer or the result. No preamble, no filler, no narrating intentions at length before simple work.

## When you do act
- Inspect before changing, make small verifiable moves, run the checks, and say plainly what you did at the end.
- Your workspace for this thread is named below. Files you create for the user go there by default; other projects under ~ stay reachable by path when a task points at them.

## Environment facts (they matter only when tools do)
- The filesystem is a real POSIX-style tree rooted at /; home is /home/user (~). Everything persists in this browser.
- The shell is bash-compatible: node, npm, pnpm, npx, tsc, git (real libgit2), curl, plus coreutils (sed, awk, jq, rg, find, xargs, sqlite3). Pipes and redirection work.
- node runs JavaScript and TypeScript directly. npm installs from the real registry. git clones work over https (github via a CORS relay automatically).
- There is NO child_process, no native binaries, no ssh, no display, no listening servers. Long processes: up to 5 minutes each (node/python); each bash step times out after 120s with exit 124 — split long work across steps or raise timeoutMs (max 600000).
- /tmp is volatile scratch: never persisted and invisible to python/node runs. Keep anything that matters in your workspace.
- curl goes through the browser, so CORS blocks many sites. When a fetch fails, say so plainly instead of guessing what the page said.
- Tool output past 20k chars arrives head+tail truncated with an explicit receipt; exit codes ride an untruncatable '[exit N]' trailer (124 = timed out).
- Raster images (JPG/PNG/WebP/GIF): Pillow is available in python3 in this workspace — use the images skill for exact dimensions, format converts, EXIF normalize, and byte budgets. Read input dimensions first with it, verify outputs by reopening them.
- Preview browser apps with: cell preview [dir] (the bundler path, not a server).

## Linking files
- When you create a file the user may want to see — a chart, image, page, document, dataset, script — link it once in your reply: [revenue chart](cell-file:/home/user/threads/.../artifacts/revenue.html). The link opens a preview when clicked. Use the absolute path; a bare path or a lone filename in backticks also linkifies when the file exists, but the explicit link is reliable. Never report a pile of generated files as plain text when each could be a link.

## Visuals in chat
The chat renders HTML live, inline in the thread — transparent background, no box around it. Use a visual when one explains better than text: a chart, a comparison, a diagram, a table with many rows, a timeline, a plan.
- Preferred: write a self-contained .html file at artifacts/<name>.html in your workspace (inline CSS/JS/SVG only, no external requests). It appears in the chat as a live visual the moment you finish.
- Or emit a \`\`\`html fenced block in your reply for something small and inline.
- Keep visuals VERY simple: plain inline SVG, a handful of elements, minimal or no JS, no libraries. They must render instantly; one small hover or click touch is plenty.
- Blend in: the frame is transparent over the chat's near-black background. Set NO background anywhere that wraps the visual — no cards, no panels, no page backdrop. Text and shapes sit directly on the transparent frame, in light colors. CSS variables are provided for you: --bg (transparent), --fg #ECECEC, --muted #AFAFAF, --accent #3FA37A, --chart-1..--chart-5. Never set a fixed height or internal scrollbars — the frame grows to fit your content exactly.
- One idea per visual, values labelled, sized for a ~760px chat column.`

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
    const home = proc?.env?.HOME
    if (!home) return null
    for (const path of [`${home}/.pi/agent/auth.json`]) {
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
        'cell agent: no model configured — easiest is the Agent panel (sidebar):',
        'pick a provider, paste your key, Save config. Or create ~/.cell/agent.json:',
        '',
        '  {',
        '    "provider": "meta",',
        '    "apiKey": "…",',
        '    "model": "muse-spark-1.3-contributor"',
        '  }',
        '',
        'In the browser the key must be in the file (or the panel) — there is',
        'no host filesystem here. Under Node/vitest, meta also resolves its',
        'key from ~/.pi/agent/auth.json. anthropic/openai: same shape with',
        'their provider/model names.',
      ].join('\n'),
    }
  }
  try {
    const parsed = JSON.parse(raw) as {
      provider?: string
      apiKey?: string
      model?: string
      baseURL?: string
      max_output_tokens?: number
      permission?: string
      thinking?: string
    }
    if (parsed.provider !== undefined && !(KNOWN_PROVIDERS as readonly string[]).includes(parsed.provider)) {
      return { error: `cell agent: unknown provider '${parsed.provider}' (use meta, anthropic, openai or compat)\n` }
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
    if (provider === 'compat') {
      if (!parsed.baseURL) return { error: 'cell agent: compat provider needs "baseURL" in ~/.cell/agent.json (e.g. https://api.x.ai/v1)\n' }
      // local servers (ollama etc.) often need no key; send a placeholder
      if (!apiKey) apiKey = 'cell-local'
    } else if (!apiKey) return { error: 'cell agent: apiKey missing in ~/.cell/agent.json\n' }
    const maxOutput = typeof parsed.max_output_tokens === 'number' ? parsed.max_output_tokens : undefined
    return {
      config: {
        provider,
        apiKey,
        model: parsed.model ?? DEFAULT_MODELS[provider],
        // permission defaults to full: 'ask' tools run without a gate
        // unless the user explicitly chose per-call approval
        permission: parsed.permission === 'ask' ? 'ask' : 'full',
        ...(typeof parsed.thinking === 'string' && parsed.thinking !== '' ? { thinking: parsed.thinking } : {}),
        ...(parsed.baseURL !== undefined ? { baseURL: parsed.baseURL } : {}),
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
  /** dedicated shell for background jobs (own env); jobs off when absent */
  jobShell?: ShellLike
  /** interactive approval gate (Agent panel): resolve true to run an 'ask' tool */
  approve?: (call: ToolCall) => Promise<boolean>
  /** ms before a pending approval auto-denies (default 300s) */
  approveTimeoutMs?: number
  /** cooperative stop: checked before every step and every tool call */
  signal?: AbortSignal
  /** step budget override (UI passes Infinity — no upper limit) */
  maxSteps?: number
  /** UI manual-compact request, consumed once per check */
  shouldCompact?: () => boolean
  /** UI hooks (Agent chat): structured events alongside the text transcript */
  onToolResult?: (call: ToolCall, result: ToolResult) => void
  onContext?: (chars: number) => void
  onSession?: (id: string) => void
}

/**
 * Generate a short sidebar title for a session with one cheap model
 * call (no tools). Returns null when unconfigured or the call fails —
 * the caller falls back to the raw prompt. Persists session.title.
 */
export async function generateSessionTitle(vfs: Vfs, id: string): Promise<string | null> {
  const configured = readConfig(vfs)
  if ('error' in configured) return null
  const loaded = loadSession(vfs, id)
  if ('error' in loaded) return null
  if (loaded.session.title !== undefined && loaded.session.title.trim() !== '') return loaded.session.title
  const lastAssistant = [...loaded.session.turns].reverse().find((turn) => turn.role === 'assistant')?.text ?? ''
  const ask = `Give this coding-agent session a 3-6 word title (plain words, no quotes, no period). Reply with the title only.\n\nTask: ${loaded.session.prompt.slice(0, 500)}\nOutcome: ${lastAssistant.slice(0, 500)}`
  const state = newProviderState(ask)
  const result = await callModel({ ...configured.config, thinking: 'minimal' }, state, [], 'You title sessions.', undefined, undefined)
  if ('error' in result) return null
  const title = result.text.trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 60).trim()
  if (title === '') return null
  try {
    // re-read before writing: a run may have persisted newer turns
    // while the title call was in flight; never save the stale copy
    const fresh = loadSession(vfs, id)
    if ('error' in fresh) return null
    if (fresh.session.title !== undefined && fresh.session.title.trim() !== '') return fresh.session.title
    saveSession(vfs, { ...fresh.session, title })
  } catch {
    // best-effort
  }
  return title
}

/** The agent loop. Returns the full transcript for the terminal. */
export async function runAgent(vfs: Vfs, args: string[], opts: RunAgentOpts): Promise<CommandResult> {
  const valueFlags = new Set(['--steps', '--max-steps', '-s', '--resume', '--session'])
  const words: string[] = []
  let maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
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
            '  --steps N             step budget (default: no limit)',
            '',
            'config: ~/.cell/agent.json { provider: meta|anthropic|openai|compat, model, apiKey?, baseURL?, permission: full|ask }',
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
  let resumedStartedAt: string | null = null
  let sessionPrompt = prompt
  if (resumeId !== null) {
    const loaded = loadSession(vfs, resumeId)
    if ('error' in loaded) return { stdout: '', stderr: `cell agent: ${loaded.error}`, exitCode: 1 }
    resumedTurns = loaded.session.turns
    resumedTranscript = loaded.session.transcript
    resumedStartedAt = loaded.session.startedAt ?? null
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
  // registryEntries is the single source of truth for custom tools (P0-1):
  // the loader inside already drops shadows/duplicates with warnings —
  // rebuild the same map here so runTool resolves exactly what was listed.
  const { entries, warnings } = registryEntries(vfs)
  const customTools = new Map<string, CustomToolDef>(loadCustomTools(vfs).tools.map((tool) => [tool.name, tool]))
  const { skills, warnings: skillWarnings } = loadSkills(vfs, opts.cwd)
  const skillBodies = new Map(skills.map((skill) => [skill.name, `# ${skill.name}\n\n${skill.body}`]))

  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nYour workspace for this thread is ${opts.cwd} — your own folder. Create files, projects and artifacts there by default (paths relative to it work in every tool). The open project and ~/.cell registries stay reachable by absolute path; other threads' folders are not visible to you and do not exist as far as your tools are concerned.\n\nSkills (one line each — use load_skill for the full body when the task needs it):\n${skillIndex(skills)}\n\nCustom tools: ${[...customTools.keys()].join(', ') || '(none)'} — declared in ~/.cell/tools/*.json, approval: ask.`

  const state: ProviderState = resumeId !== null ? emptyProviderState() : newProviderState(expanded.prompt)
  if (resumeId !== null) {
    rebuildState(state, config.provider, resumedTurns, resumedResponseId)
    if (expanded.prompt !== '') {
      if (config.provider === 'meta') {
        // flush tool outputs the saved run never sent before the new prompt (P0-6)
        const unsent = unsentMetaOutputs(resumedTurns, resumedResponseId)
        if (unsent.length > 0) setMetaResumeFlush(state, unsent, expanded.prompt)
        else setMetaPendingUser(state, expanded.prompt)
      } else {
        pushUserTurn(state, config.provider, expanded.prompt)
      }
    }
  }

  let transcript: string[] = resumeId !== null
    ? [...resumedTranscript, `agent ▸ (resumed ${resumeId}) ${redactSecrets(sessionPrompt)}${expanded.command ? ` [/${expanded.command}]` : ''}`]
    : [`agent ▸ ${redactSecrets(prompt)}`, `model: ${config.provider}/${config.model}, max ${maxSteps === Number.POSITIVE_INFINITY ? '∞' : maxSteps} steps`]
  if (resumeId === null && expanded.command) transcript[0] += ` [/${expanded.command}]`
  for (const warning of warnings) transcript.push(`agent warning: ${warning}`)
  for (const warning of skillWarnings) transcript.push(`agent warning: ${warning}`)
  if (skills.length > 0) transcript.push(`skills: ${skills.map((s) => s.name).join(', ')} (load_skill for the body)`)

  let turns: SessionTurn[] = resumeId !== null ? [...resumedTurns] : [{ role: 'user', text: prompt }]
  if (resumeId !== null && expanded.prompt !== '') turns.push({ role: 'user', text: expanded.prompt })

  const deps = { vfs, shell: opts.shell, cwd: opts.cwd, skills: skillBodies, customTools, ...(opts.jobShell ? { jobs: new JobManager(opts.jobShell, vfs) } : {}) }
  // strip a .json suffix so --resume x.json does not save x.json.json (P1-5)
  const id = resumeId !== null ? resumeId.replace(/\.json$/, '') : sessionId()
  const startedAt = resumedStartedAt ?? new Date().toISOString()

  opts.onSession?.(id)

  const persist = (steps: number, runFinished = false) => {
    try {
      // merge sidebar metadata from disk at save time: a run must never
      // wipe a title/pin/archive/lock the user set (or a title the
      // titler wrote) while it was working
      const existing = loadSession(vfs, id)
      const meta = 'error' in existing ? {} : {
        ...(existing.session.title !== undefined ? { title: existing.session.title } : {}),
        ...(existing.session.pinned !== undefined ? { pinned: existing.session.pinned } : {}),
        ...(existing.session.archived !== undefined ? { archived: existing.session.archived } : {}),
        ...(existing.session.locked !== undefined ? { locked: existing.session.locked } : {}),
      }
      saveSession(vfs, { id, startedAt, provider: config.provider, model: config.model, prompt: sessionPrompt, transcript, turns, steps, ...meta, ...(runFinished ? {} : { liveRun: true }) })
    } catch {
      // sessions are best-effort — the transcript still returns
    }
  }

  let lastCompactStep = -10
  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) {
      transcript.push('agent: stopped by user')
      persist(step, true)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }
    // compaction: when the live context passes the threshold, summarize
    // the turns into one user message and continue from it (instead of
    // the old middle-drop, which lost decisions silently)
    const manualCompact = opts.shouldCompact?.() === true
    if (step > 1 && (manualCompact || (step - lastCompactStep >= 3 && contextSize(state, turns, config.provider) > COMPACT_AT_CHARS))) {
      const summary = await summarizeTurns(config, turns, entries)
      if (summary !== null) {
        applyCompaction(state, config.provider, summary)
        turns = [{ role: 'user', text: summary }]
        transcript.push('agent: context compacted — earlier turns summarized, continuing')
        lastCompactStep = step
      }
    }
    opts.onContext?.(contextSize(state, turns, config.provider))
    const model = await callModel(config, state, entries, systemPrompt, opts.onProgress, turns, opts.signal)
    if ('error' in model) {
      transcript.push(`agent ✗ ${redactSecrets(model.error)}`)
      persist(step, true)
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
      recordAssistantMessage(state, config.provider, model.text, model.calls)
      capLiveState(state)
      transcript.push(`session ${id} — resume with \`cell agent --resume ${id} "…"\``)
      persist(step, true)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }
    if (model.text.trim().length > 0) transcript.push(`⏺ ${clip(redactSecrets(model.text.trim()), 4)}`)

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
      } else if (isOpenAIShaped(config.provider)) {
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
      persist(step, true)
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
      if (opts.signal?.aborted) {
        transcript.push('agent: stopped by user')
        persist(step, true)
        return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
      }
      const summary = toolSummary(call)
      // per-tool approval: read/ls/load_skill run; everything else prints
      // a clear prompt line first (non-interactive shells auto-proceed —
      // the line is the audit trail for what the agent touched)
      const approval = approvalFor(entries, call.name)
      if (approval === 'ask' && config.permission === 'ask' && opts.approve !== undefined) {
        // interactive gate (Agent panel): the user decides per call.
        // Bounded: an abandoned prompt (closed panel, walked away)
        // auto-denies instead of hanging the run forever.
        const allowed = await withApprovalTimeout(opts.approve, call, opts.approveTimeoutMs ?? 300_000)
        transcript.push(redactSecrets(`❓ approval: ${call.name} ${summary} — ${allowed ? 'approved' : 'DENIED by user'}`))
        if (!allowed) {
          const denied: ToolResult = { id: call.id, content: 'denied by user — do not retry this exact call; ask or choose another approach', isError: true }
          toolResults.push(denied)
          metaOutputs.push({ type: 'function_call_output', call_id: call.id, output: denied.content })
          continue
        }
      } else if (approval === 'ask') {
        transcript.push(redactSecrets(`❓ approval: ${call.name} ${summary} — auto-approved (${config.permission === 'full' ? 'full permission' : 'non-interactive run'})`))
      }
      transcript.push(redactSecrets(`⏺ ${call.name} ${summary}`))
      opts.onProgress?.(redactSecrets(`⏺ ${call.name} ${summary}`))
      const result = await runTool(deps, call)
      // redact BEFORE truncating: a secret split across the cut must not
      // survive in either half (P2), and raw results never re-enter context (P0-3)
      const safeContent = redactSecrets(result.content)
      transcript.push(clip(safeContent.split('\n').map((line) => `  ${line}`).join('\n'), 12))
      const safeResult = { ...result, content: safeContent }
      toolResults.push(safeResult)
      opts.onToolResult?.(call, safeResult)
      metaOutputs.push({ type: 'function_call_output', call_id: call.id, output: safeContent })
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
    } else if (isOpenAIShaped(config.provider)) {
      for (const result of toolResults) {
        state.openaiMessages.push({ role: 'tool', content: result.content, tool_call_id: result.id } as never)
      }
    } else {
      setMetaOutputs(state, metaOutputs)
    }
    // live-state caps: provider logs stay bounded and pair-safe (P1-4),
    // session turns/transcript stay bounded between persists
    capLiveState(state)
    if (turns.length > 60) turns = truncateTurns(turns)
    if (transcript.length > 300) transcript = transcript.slice(-300)
    // persist every step (flagged live): a closed or crashed tab can
    // resume this session from exactly here, and boot can tell the run
    // was interrupted instead of finding a silent half-conversation
    persist(step)
  }

  transcript.push(`agent: reached the ${maxSteps}-step limit — continue with \`cell agent --resume ${id} "keep going"\``)
  persist(maxSteps, true)
  // unfinished work is not success: non-zero so SSE done events, usage
  // rows, job retries, and shells all record it as incomplete
  return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 2 }
}

/** Race an approval against its timeout; timeout resolves false. */
async function withApprovalTimeout(
  approve: (call: ToolCall) => Promise<boolean>,
  call: ToolCall,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      approve(call),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Rough context size in chars (~4 chars/token) across provider state. */
export const COMPACT_AT_CHARS = 200_000

function contextSize(state: ProviderState, turns: SessionTurn[], provider: ProviderKind): number {
  // one source per provider: the message log for anthropic/openai-shaped
  // (turns are derived FROM it — summing both double-counts), the turn
  // list for meta (which chains server-side and keeps no local log)
  try {
    if (provider === 'anthropic') return JSON.stringify(state.anthropicMessages).length
    if (provider === 'openai' || provider === 'compat') return JSON.stringify(state.openaiMessages).length
    return turns.reduce((sum, turn) => sum + turn.text.length, 0)
  } catch {
    return 0
  }
}

/** Ask the model (no tools) to compress the conversation so far. */
async function summarizeTurns(config: AgentConfig, turns: SessionTurn[], _entries: ToolInfo[]): Promise<string | null> {
  const flat = turns.map((turn) => {
    const calls = (turn.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.input).slice(0, 300)}`).join('; ')
    return `${turn.role}: ${turn.text.slice(0, 3000)}${calls ? ` [calls: ${calls}]` : ''}`
  }).join('\n').slice(0, 120_000)
  const prompt = `Summarize this coding-agent session for a fresh agent continuing the work. Preserve: the task, decisions made, files created/changed (paths), commands that mattered, current state, and next steps. Be concise, plain facts only.\n\n${flat}`
  const fresh = newProviderState(prompt)
  const result = await callModel(config, fresh, [], 'You summarize agent sessions.', undefined, undefined)
  if ('error' in result || result.text.trim() === '') return null
  return `[summary of earlier work]\n${result.text.trim()}`
}

/** Replace live provider state with the summary as the opening message. */
function applyCompaction(state: ProviderState, provider: ProviderKind, summary: string): void {
  state.anthropicMessages = [{ role: 'user', content: summary }]
  state.openaiMessages = [{ role: 'user', content: summary }]
  state.metaResponseId = null
  state.metaPendingUser = null
  state.metaPendingOutputs = null
  state.metaFirstInput = { role: 'user', content: [{ type: 'input_text', text: summary }] }
  void provider
}

function pushUserTurn(state: ProviderState, provider: ProviderKind, text: string): void {
  if (provider === 'anthropic') state.anthropicMessages.push({ role: 'user', content: text })
  else if (isOpenAIShaped(provider)) state.openaiMessages.push({ role: 'user', content: text } as never)
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
  } else if (isOpenAIShaped(provider)) {
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

/** Tool outputs recorded after the last chained response: the saved run
 * ended before they were sent, so resume must flush them first (P0-6). */
function unsentMetaOutputs(
  turns: SessionTurn[],
  responseId: string | null,
): { type: string; call_id: string; output: string }[] {
  if (responseId === null) return []
  let lastAssistant = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant' && turns[i].responseId !== undefined) {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant === -1) return []
  const anchor = turns[lastAssistant]
  if (anchor.responseId !== responseId || (anchor.toolCalls?.length ?? 0) === 0) return []
  const outputs: { type: string; call_id: string; output: string }[] = []
  for (const turn of turns.slice(lastAssistant + 1)) {
    if (turn.role === 'assistant') break
    if (turn.role === 'tool' && turn.toolResults) {
      for (const result of turn.toolResults) {
        outputs.push({ type: 'function_call_output', call_id: result.id, output: result.content })
      }
    }
  }
  return outputs
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

