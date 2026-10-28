import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import type { ShellLike } from './npm'

/**
 * Tool registry: built-ins (bash/read/edit/write/ls/load_skill) plus custom
 * tools loaded from ~/.cell/tools/*.json:
 *
 *   { "name": "gh-issue", "description": "…", "parameters": {…},
 *     "run": { "kind": "bash", "command": "gh issue view {{number}}" } }
 *
 * Custom tools run through the same shell the user types into; {{arg}}
 * placeholders are interpolated with single-quote shell escaping and stdout
 * comes back as the result (stderr merged, exit code noted). Only the
 * "bash" kind exists — it covers every local automation without a new DSL.
 */

export type ApprovalPolicy = 'auto' | 'ask'

export interface CustomToolDef {
  name: string
  description: string
  parameters?: Record<string, unknown>
  run: { kind: 'bash'; command: string }
}

export interface ToolInfo {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 'auto' runs immediately (read/ls/load_skill); 'ask' prints a prompt line first */
  approval: ApprovalPolicy
  custom: boolean
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  id: string
  content: string
  isError?: boolean
  /** the tool step hit its time budget (exit 124); content is partial */
  timedOut?: boolean
}

/** default budget for one agent bash step: no step wedges the tab forever */
export const AGENT_BASH_TIMEOUT_MS = 120_000
export const AGENT_BASH_MAX = 20_000
export const AGENT_READ_MAX = 30_000

/** head+tail truncation with an explicit receipt — never silent (P0-6). */
export function truncateWithReceipt(text: string, max: number): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  const headLen = Math.floor(max * 0.75)
  const tailLen = max - headLen
  return `${text.slice(0, headLen)}\n… [truncated ${dropped} chars]\n${text.slice(text.length - tailLen)}`
}

/** Untruncatable trailer appended AFTER truncation (P0-5). */
export function exitTrailer(result: { exitCode: number; timedOut?: boolean; oomSuspected?: boolean }, timeoutMs?: number): string {
  const parts: string[] = []
  if (result.timedOut) {
    const secs = timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : 120
    parts.push(`[exit 124 — timed out after ${secs}s]`)
  } else if (result.exitCode !== 0) {
    parts.push(`[exit ${result.exitCode}]`)
  }
  if (result.oomSuspected) parts.push('[oom suspected — output may be partial]')
  return parts.length > 0 ? `\n${parts.join(' ')}` : ''
}

const TOOLS_DIR = '/home/user/.cell/tools'

/** Paths the agent must never read/write through file tools (P0-3/P0-4):
 * its own key material, live sessions, and the registries it could use
 * to shadow tools, override skills, or rewrite its own instructions. */
const DENIED_PREFIXES = [
  '/home/user/.cell/agent.json',
  '/home/user/.cell/auth.json',
  '/home/user/.cell/sessions',
  '/home/user/.cell/tools',
  '/home/user/.cell/skills',
]

/** true when an expanded absolute path touches agent key/config/registry state. */
export function isDeniedPath(absPath: string): boolean {
  const normalized = absPath.replace(/\/+$/, '')
  return DENIED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

/** Bash patterns that error instead of running (P0-4): destructive or
 * self-modifying commands the non-interactive approval line cannot gate. */
const BASH_DENY: { re: RegExp; label: string }[] = [
  { re: /\brm\s+[^|;&]*-[a-z]*r[a-z]*f/i, label: 'rm -rf' },
  { re: /\brm\s+[^|;&]*(?:\s|^)(?:~|\/|\$HOME|\${HOME})/, label: 'rm on home/root' },
  { re: /\bcell\s+(load|save)\b/, label: 'cell load/save' },
  { re: /\bcurl\b[^|]*\|\s*(?:sh|bash)\b/, label: 'curl|sh' },
  { re: /\bwget\b[^|]*\|\s*(?:sh|bash)\b/, label: 'wget|sh' },
]

/** non-null when a bash command must be refused before it runs. */
export function bashDenyReason(command: string): string | null {
  for (const { re, label } of BASH_DENY) {
    re.lastIndex = 0
    if (re.test(command)) return `refused ${label}: destructive or self-modifying commands cannot run non-interactively`
  }
  return null
}

const BUILTIN_DEFS: { name: string; description: string; approval: ApprovalPolicy }[] = [
  { name: 'bash', description: 'Run a shell command in the workspace (bash-compatible). Returns stdout+stderr and the exit code. cd is per-call. Each step times out after 120s (exit 124, overridable with timeoutMs up to 600000); output past 20k chars is head+tail truncated with a receipt.', approval: 'ask' },
  { name: 'read', description: 'Read a text file from the filesystem. Long files are paged — pass offset/limit.', approval: 'auto' },
  { name: 'edit', description: 'Replace one exact block of text in a file. The old text must occur exactly once.', approval: 'ask' },
  { name: 'write', description: 'Create or overwrite a text file. Parent directories are created.', approval: 'ask' },
  { name: 'ls', description: 'List a directory.', approval: 'auto' },
  { name: 'load_skill', description: 'Load the full body of a skill by name (progressive disclosure: the system prompt only carries names + one-liners).', approval: 'auto' },
]

const PARAM_SCHEMAS: Record<string, Record<string, unknown>> = {
  bash: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'the command line to run' },
      cwd: { type: 'string', description: 'working directory (default: home)' },
      timeoutMs: { type: 'number', description: 'step budget in ms (default 120000, max 600000; exit 124 on expiry)' },
    },
    required: ['command'],
  },
  read: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute path, ~ allowed' },
      offset: { type: 'number', description: 'first line (1-based, default 1)' },
      limit: { type: 'number', description: 'max lines (default 2000)' },
    },
    required: ['path'],
  },
  edit: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute path, ~ allowed' },
      oldText: { type: 'string', description: 'exact text to replace (must be unique)' },
      newText: { type: 'string', description: 'replacement text' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  write: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute path, ~ allowed' },
      content: { type: 'string', description: 'full file content' },
    },
    required: ['path', 'content'],
  },
  ls: {
    type: 'object',
    properties: { path: { type: 'string', description: 'directory to list (default ~)' } },
    required: [],
  },
  load_skill: {
    type: 'object',
    properties: { name: { type: 'string', description: 'skill name from the system prompt list' } },
    required: ['name'],
  },
}

/** Shell-escape one interpolated value (single-quote style). */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Replace {{name}} placeholders with shell-quoted args. Unknown keys → ''. */
export function interpolateArgs(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_full, key: string) => {
    const value = args[key]
    if (value === undefined || value === null) return ''
    return shellQuote(String(value))
  })
}

function parseCustomTool(raw: string, path: string): CustomToolDef | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `${path}: not valid JSON` }
  }
  const def = parsed as Partial<CustomToolDef>
  if (typeof def.name !== 'string' || def.name === '') return { error: `${path}: missing "name"` }
  if (!/^[A-Za-z0-9_-]+$/.test(def.name)) return { error: `${path}: bad tool name '${def.name}'` }
  if (typeof def.description !== 'string') return { error: `${path}: missing "description"` }
  if (def.run === undefined || def.run.kind !== 'bash' || typeof def.run.command !== 'string') {
    return { error: `${path}: run must be { "kind": "bash", "command": "…" }` }
  }
  return {
    name: def.name,
    description: def.description,
    parameters: (def.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    run: { kind: 'bash', command: def.run.command },
  }
}

export function loadCustomTools(vfs: Vfs): { tools: CustomToolDef[]; warnings: string[] } {
  const tools: CustomToolDef[] = []
  const warnings: string[] = []
  let names: string[]
  try {
    names = vfs.isDir(TOOLS_DIR) ? vfs.readDir(TOOLS_DIR) : []
  } catch {
    return { tools, warnings }
  }
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const path = `${TOOLS_DIR}/${name}`
    const raw = vfs.read(path)
    if (raw === null) continue
    const parsed = parseCustomTool(raw, path)
    if ('error' in parsed) {
      warnings.push(parsed.error)
      continue
    }
    if (BUILTIN_DEFS.some((def) => def.name === parsed.name)) {
      warnings.push(`${path}: shadows a built-in tool — ignored`)
      continue
    }
    if (tools.some((tool) => tool.name === parsed.name)) {
      warnings.push(`${path}: duplicate custom tool '${parsed.name}' — ignored`)
      continue
    }
    tools.push(parsed)
  }
  return { tools, warnings }
}

export function registryEntries(vfs: Vfs): { entries: ToolInfo[]; warnings: string[] } {
  const { tools, warnings } = loadCustomTools(vfs)
  const entries: ToolInfo[] = BUILTIN_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: PARAM_SCHEMAS[def.name] ?? { type: 'object', properties: {} },
    approval: def.approval,
    custom: false,
  }))
  for (const tool of tools) {
    entries.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      approval: 'ask',
      custom: true,
    })
  }
  return { entries, warnings }
}

export function approvalFor(entries: ToolInfo[], name: string): ApprovalPolicy {
  return entries.find((entry) => entry.name === name)?.approval ?? 'ask'
}

/** per-call step budget, clamped so one typo cannot wedge the tab (P0-1). */
export function clampTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return AGENT_BASH_TIMEOUT_MS
  return Math.min(600_000, Math.max(1_000, Math.floor(n)))
}

export function expand(path: string, cwd: string): string {
  const raw = path.trim()
  if (raw === '~') return '/home/user'
  if (raw.startsWith('~/')) return `/home/user${raw.slice(1)}`
  return raw.startsWith('/') ? raw : vfsPath.join(cwd, raw)
}

export interface RunToolDeps {
  vfs: Vfs
  shell: ShellLike
  cwd: string
  /** full skill bodies by name, for the load_skill tool */
  skills?: Map<string, string>
  /** custom tool definitions (re-loaded per run; pass through for tests) */
  customTools?: Map<string, CustomToolDef>
}

export async function runTool(deps: RunToolDeps, call: ToolCall): Promise<ToolResult> {
  const { vfs, shell } = deps
  try {
    if (call.name === 'load_skill') {
      const name = String(call.input.name ?? '')
      const body = deps.skills?.get(name)
      if (body !== undefined) return { id: call.id, content: truncateWithReceipt(body, AGENT_READ_MAX) }
      return { id: call.id, content: `unknown skill '${name}'`, isError: true }
    }
    const custom = deps.customTools?.get(call.name)
    if (custom !== undefined) {
      const command = interpolateArgs(custom.run.command, call.input)
      const denied = bashDenyReason(command)
      if (denied !== null) return { id: call.id, content: denied, isError: true }
      const timeoutMs = clampTimeout(call.input.timeoutMs)
      const result = await shell.exec(command, deps.cwd, undefined, { timeoutMs })
      const combined = result.stdout !== '' && result.stderr !== '' ? `${result.stdout}\n${result.stderr}` : `${result.stdout}${result.stderr}`
      const body = truncateWithReceipt(combined.trim(), AGENT_BASH_MAX)
      const text = `${body}${exitTrailer(result, timeoutMs)}`.trim()
      return {
        id: call.id,
        content: text === '' ? '(no output)' : text,
        isError: result.exitCode !== 0,
        ...(result.timedOut ? { timedOut: true } : {}),
      }
    }
    if (call.name === 'bash') {
      const command = String(call.input.command ?? '')
      const denied = bashDenyReason(command)
      if (denied !== null) return { id: call.id, content: denied, isError: true }
      const cwd = call.input.cwd !== undefined ? expand(String(call.input.cwd), deps.cwd) : deps.cwd
      const timeoutMs = clampTimeout(call.input.timeoutMs)
      const result = await shell.exec(command, cwd, undefined, { timeoutMs })
      const combined = result.stdout !== '' && result.stderr !== '' ? `${result.stdout}\n${result.stderr}` : `${result.stdout}${result.stderr}`
      const body = truncateWithReceipt(combined.trim(), AGENT_BASH_MAX)
      const text = `${body}${exitTrailer(result, timeoutMs)}`.trim()
      return {
        id: call.id,
        content: text === '' ? '(no output)' : text,
        isError: result.exitCode !== 0,
        ...(result.timedOut ? { timedOut: true } : {}),
      }
    }
    if (call.name === 'read') {
      const path = expand(String(call.input.path ?? ''), deps.cwd)
      if (isDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not readable (${path})`, isError: true }
      const content = vfs.read(path)
      if (content === null) return { id: call.id, content: `no such file (or binary): ${path}`, isError: true }
      const lines = content.split('\n')
      const rawOffset = Number(call.input.offset ?? 1)
      const rawLimit = Number(call.input.limit ?? 2000)
      const offset = Number.isFinite(rawOffset) ? Math.max(1, Math.floor(rawOffset)) : 1
      const limit = Number.isFinite(rawLimit) ? Math.min(5000, Math.max(1, Math.floor(rawLimit))) : 2000
      const page = lines.slice(offset - 1, offset - 1 + limit)
      const shown = `lines ${offset}-${offset + page.length - 1} of ${lines.length}\n${page.join('\n')}`
      return { id: call.id, content: truncateWithReceipt(shown, AGENT_READ_MAX) }
    }
    if (call.name === 'edit') {
      const path = expand(String(call.input.path ?? ''), deps.cwd)
      if (isDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not writable (${path})`, isError: true }
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
      if (isDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not writable (${path})`, isError: true }
      vfs.write(path, String(call.input.content ?? ''))
      return { id: call.id, content: `wrote ${path}` }
    }
    if (call.name === 'ls') {
      const path = expand(String(call.input.path ?? '~'), deps.cwd)
      if (isDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not listable (${path})`, isError: true }
      const names = vfs.readDir(path)
      return { id: call.id, content: names.length === 0 ? '(empty)' : names.join('\n') }
    }
    return { id: call.id, content: `unknown tool ${call.name}`, isError: true }
  } catch (err) {
    return { id: call.id, content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
