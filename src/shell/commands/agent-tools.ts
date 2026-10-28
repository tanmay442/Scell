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
}

const TOOLS_DIR = '/home/user/.cell/tools'

const BUILTIN_DEFS: { name: string; description: string; approval: ApprovalPolicy }[] = [
  { name: 'bash', description: 'Run a shell command in the workspace (bash-compatible). Returns stdout+stderr and the exit code. cd is per-call.', approval: 'ask' },
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
      if (body !== undefined) return { id: call.id, content: body.slice(0, 30_000) }
      return { id: call.id, content: `unknown skill '${name}'`, isError: true }
    }
    const custom = deps.customTools?.get(call.name)
    if (custom !== undefined) {
      const command = interpolateArgs(custom.run.command, call.input)
      const result = await shell.exec(command, deps.cwd)
      const text = `${result.stdout}${result.stderr}${result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : ''}`.trim()
      return { id: call.id, content: (text === '' ? '(no output)' : text).slice(0, 20_000), isError: result.exitCode !== 0 }
    }
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
