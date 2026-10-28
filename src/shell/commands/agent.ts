import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import type { CommandResult, ShellLike } from './npm'

/**
 * `cell agent` — a headless agentic harness that lives where the agent works:
 * the Cell filesystem. An LLM (Anthropic or OpenAI, your key) loops over real
 * tools — bash (the same shell you type into), read, write, ls — until the
 * task is done. Long tasks are the point: node runs 5 minutes, git and npm
 * are the real thing, and every file the agent touches lands in the VFS you
 * see in the tree.
 *
 * Configure ~/.cell/agent.json:
 *   { "provider": "anthropic", "apiKey": "sk-ant-…", "model": "claude-sonnet-4-5" }
 */

const AGENT_CONFIG_PATH = '/home/user/.cell/agent.json'
const DEFAULT_MAX_STEPS = 30
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
}

interface AgentConfig {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model: string
}

const KNOWN_PROVIDERS = ['anthropic', 'openai'] as const

function readConfig(vfs: Vfs): { config: AgentConfig } | { error: string } {
  const raw = vfs.read(AGENT_CONFIG_PATH)
  if (raw === null) {
    return {
      error: [
        'cell agent: no model configured — create ~/.cell/agent.json:',
        '',
        '  {',
        '    "provider": "anthropic",',
        '    "apiKey": "sk-ant-…",',
        '    "model": "claude-sonnet-4-5"',
        '  }',
        '',
        'anthropic and openai both work (openai: provider "openai", model "gpt-4o").',
        'Anthropic calls send the browser-direct-access header, so no proxy is needed.',
      ].join('\n'),
    }
  }
  try {
    const parsed = JSON.parse(raw) as { provider?: string; apiKey?: string; model?: string }
    if (!parsed.apiKey) return { error: 'cell agent: apiKey missing in ~/.cell/agent.json\n' }
    if (parsed.provider !== undefined && !(KNOWN_PROVIDERS as readonly string[]).includes(parsed.provider)) {
      return { error: `cell agent: unknown provider '${parsed.provider}' (use anthropic or openai)\n` }
    }
    const provider = parsed.provider === 'openai' ? 'openai' : 'anthropic'
    return {
      config: {
        provider,
        apiKey: parsed.apiKey,
        model: parsed.model ?? DEFAULT_MODELS[provider],
      },
    }
  } catch {
    return { error: 'cell agent: ~/.cell/agent.json is not valid JSON\n' }
  }
}

const SYSTEM_PROMPT = `You are an autonomous coding agent running INSIDE Cell — a complete development environment in a browser tab. You are not on a normal server; keep this in mind:

- The filesystem is a real POSIX-style tree rooted at /; your home is /home/user (~). Everything persists in this browser.
- The shell is bash-compatible: node, npm, pnpm, npx, tsc, git (real libgit2), curl, plus coreutils (sed, awk, jq, rg, find, xargs, sqlite3…). Pipes and redirection work.
- node runs JavaScript and TypeScript directly. npm installs from the real registry. git clones work over https (github via a CORS relay automatically).
- There is NO child_process, no native binaries, no ssh, no display. Long processes: up to 5 minutes each.
- Edit files with the read/write/edit tools (small precise edits over whole-file rewrites); verify with read and bash (cat, tsc, npm test, git diff).

Work like a careful engineer: inspect before changing, make small verifiable moves, run the checks, and say plainly what you did at the end.`

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResult {
  id: string
  content: string
  isError?: boolean
}

interface AgentToolsDeps {
  vfs: Vfs
  shell: ShellLike
  cwd: string
}

function toolDefs(provider: 'anthropic' | 'openai') {
  const defs = [
    {
      name: 'bash',
      description: 'Run a shell command in the workspace (bash-compatible). Returns stdout+stderr and the exit code. cd is per-call.',
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the command line to run' },
          cwd: { type: 'string', description: 'working directory (default: home)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read',
      description: 'Read a text file from the filesystem. Long files are paged — pass offset/limit.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path, ~ allowed' },
          offset: { type: 'number', description: 'first line (1-based, default 1)' },
          limit: { type: 'number', description: 'max lines (default 2000)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'edit',
      description: 'Replace one exact block of text in a file. The old text must occur exactly once.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path, ~ allowed' },
          oldText: { type: 'string', description: 'exact text to replace (must be unique)' },
          newText: { type: 'string', description: 'replacement text' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    {
      name: 'write',
      description: 'Create or overwrite a text file. Parent directories are created.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path, ~ allowed' },
          content: { type: 'string', description: 'full file content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'ls',
      description: 'List a directory.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'directory to list (default ~)' } },
        required: [],
      },
    },
  ]
  if (provider === 'anthropic') {
    return defs.map((def) => ({ name: def.name, description: def.description, input_schema: def.schema }))
  }
  return defs.map((def) => ({ type: 'function' as const, function: { name: def.name, description: def.description, parameters: def.schema } }))
}

function expand(p: string, cwd: string): string {
  const raw = p.trim()
  if (raw === '~') return '/home/user'
  if (raw.startsWith('~/')) return `/home/user${raw.slice(1)}`
  return raw.startsWith('/') ? raw : vfsPath.join(cwd, raw)
}

async function runTool(deps: AgentToolsDeps, call: ToolCall): Promise<ToolResult> {
  const { vfs, shell } = deps
  try {
    if (call.name === 'bash') {
      const command = String(call.input.command ?? '')
      const cwd = call.input.cwd !== undefined ? expand(String(call.input.cwd), deps.cwd) : deps.cwd
      const result = await shell.exec(command, cwd)
      const text = `${result.stdout}${result.stderr}${result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : ''}`.trim()
      return { id: call.id, content: text === '' ? '(no output)' : text.slice(0, 20_000), isError: result.exitCode !== 0 }
    }
    if (call.name === 'read') {
      const path = expand(String(call.input.path ?? ''), deps.cwd)
      const content = vfs.read(path)
      if (content === null) return { id: call.id, content: `no such file (or binary): ${path}`, isError: true }
      const lines = content.split('\n')
      const offset = Math.max(1, Number(call.input.offset ?? 1))
      const limit = Math.max(1, Number(call.input.limit ?? 2000))
      const page = lines.slice(offset - 1, offset - 1 + limit)
      const shown = `lines ${offset}-${offset + page.length - 1} of ${lines.length}\n${page.join('\n')}`
      return { id: call.id, content: shown.slice(0, 30_000) }
    }
    if (call.name === 'edit') {
      const path = expand(String(call.input.path ?? ''), deps.cwd)
      const content = vfs.read(path)
      if (content === null) return { id: call.id, content: `no such file (or binary): ${path}`, isError: true }
      const oldText = String(call.input.oldText ?? '')
      const newText = String(call.input.newText ?? '')
      if (oldText === '') return { id: call.id, content: 'edit: oldText must not be empty', isError: true }
      const occurrences = content.split(oldText).length - 1
      if (occurrences === 0) return { id: call.id, content: 'edit: old text not found', isError: true }
      if (occurrences > 1) return { id: call.id, content: `edit: old text matches ${occurrences} times — include more context`, isError: true }
      vfs.write(path, content.replace(oldText, newText))
      return { id: call.id, content: `edited ${path}` }
    }
    if (call.name === 'write') {
      const path = expand(String(call.input.path ?? ''), deps.cwd)
      vfs.write(path, String(call.input.content ?? ''))
      return { id: call.id, content: `wrote ${path}` }
    }
    if (call.name === 'ls') {
      const path = expand(String(call.input.path ?? '~'), deps.cwd)
      const names = vfs.readDir(path)
      return { id: call.id, content: names.length === 0 ? '(empty)' : names.join('\n') }
    }
    return { id: call.id, content: `unknown tool ${call.name}`, isError: true }
  } catch (err) {
    return { id: call.id, content: err instanceof Error ? err.message : String(err), isError: true }
  }
}

function clip(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines ? text : `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)`
}

/** The agent loop. Returns the full transcript for the terminal. */
export async function runAgent(
  vfs: Vfs,
  args: string[],
  opts: { cwd: string; shell: ShellLike },
): Promise<CommandResult> {
  const valueFlags = new Set(['--steps', '--max-steps', '-s'])
  const words: string[] = []
  let maxSteps = DEFAULT_MAX_STEPS
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) {
        maxSteps = parseInt(args[++i] ?? '', 10) || DEFAULT_MAX_STEPS
      }
      continue
    }
    words.push(arg)
  }
  const prompt = words.join(' ').trim()

  const configured = readConfig(vfs)
  if ('error' in configured) return { stdout: '', stderr: `${configured.error}\n`, exitCode: 1 }
  if (!prompt) {
    return {
      stdout: 'usage: cell agent "do something in this workspace" [--steps N]\n',
      stderr: '',
      exitCode: 1,
    }
  }

  const { config } = configured
  const deps: AgentToolsDeps = { vfs, shell: opts.shell, cwd: opts.cwd }
  const transcript: string[] = [`agent ▸ ${prompt}`, `model: ${config.provider}/${config.model}, max ${maxSteps} steps`]

  const anthropicMessages: { role: 'user' | 'assistant'; content: unknown }[] = [
    { role: 'user', content: prompt },
  ]
  const openaiMessages: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }[] = [
    { role: 'user', content: prompt },
  ]

  for (let step = 1; step <= maxSteps; step++) {
    const model = await callModel(config, anthropicMessages, openaiMessages)
    if ('error' in model) {
      transcript.push(`agent ✗ ${model.error}`)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 1 }
    }

    if (model.text.trim().length > 0 && model.calls.length === 0) {
      transcript.push(`\n${model.text.trim()}`)
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }
    if (model.text.trim().length > 0) transcript.push(`⏺ ${clip(model.text.trim(), 4)}`)

    if (model.truncated) {
      // max_tokens cut the turn mid-stream: partial tool calls would
      // execute with made-up arguments, so discard them and ask to continue
      transcript.push('agent: model output truncated — continuing briefly')
      if (config.provider === 'anthropic') {
        anthropicMessages.push({
          role: 'user',
          content: 'Your previous output was truncated by max_tokens. Continue briefly from where you left off.',
        })
      } else {
        openaiMessages.push({ role: 'user', content: 'Your previous output was truncated. Continue briefly from where you left off.' } as never)
      }
      continue
    }

    if (model.calls.length === 0) {
      transcript.push('agent: model returned nothing runnable — stopping')
      return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
    }

    // record the assistant turn, then execute each tool call
    if (config.provider === 'anthropic') {
      anthropicMessages.push({
        role: 'assistant',
        content: [
          ...(model.text.trim() ? [{ type: 'text', text: model.text }] : []),
          ...model.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
        ],
      })
    } else {
      openaiMessages.push({
        role: 'assistant',
        content: model.text.trim() || null,
        tool_calls: model.calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      } as never)
    }

    const toolResults: ToolResult[] = []
    for (const call of model.calls) {
      const summary =
        call.name === 'bash'
          ? String(call.input.command ?? '')
          : call.name === 'write'
            ? `${call.input.path ?? ''}`
            : `${call.input.path ?? call.input.cwd ?? ''}`
      transcript.push(`⏺ ${call.name} ${summary}`)
      const result = await runTool(deps, call)
      transcript.push(clip(result.content.split('\n').map((line) => `  ${line}`).join('\n'), 12))
      toolResults.push(result)
    }

    if (config.provider === 'anthropic') {
      anthropicMessages.push({
        role: 'user',
        content: toolResults.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          is_error: result.isError ?? false,
        })),
      })
    } else {
      for (const result of toolResults) {
        openaiMessages.push({ role: 'tool', content: result.content, tool_call_id: result.id } as never)
      }
    }
  }

  transcript.push(`agent: reached the ${maxSteps}-step limit — continue with \`cell agent "keep going"\``)
  return { stdout: `${transcript.join('\n')}\n`, stderr: '', exitCode: 0 }
}

interface ModelTurn {
  text: string
  calls: ToolCall[]
  truncated: boolean
}

async function callModel(
  config: AgentConfig,
  anthropicMessages: { role: 'user' | 'assistant'; content: unknown }[],
  openaiMessages: { role: string; content: string | null }[],
): Promise<ModelTurn | { error: string }> {
  try {
    if (config.provider === 'anthropic') {
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
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: anthropicMessages,
          tools: toolDefs('anthropic'),
        }),
      })
      if (!response.ok) {
        return { error: `anthropic ${response.status}: ${(await response.text()).slice(0, 300)}` }
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

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...openaiMessages],
        tools: toolDefs('openai'),
      }),
    })
    if (!response.ok) {
      return { error: `openai ${response.status}: ${(await response.text()).slice(0, 300)}` }
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
  } catch (err) {
    const hint = err instanceof TypeError ? ' (network/CORS — the browser could not reach the API)' : ''
    return { error: `${err instanceof Error ? err.message : String(err)}${hint}` }
  }
}
