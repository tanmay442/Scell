import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import { isProtectedPath, isWriteProtectedPath } from '../../vfs/protected-paths'
import { redactSecrets } from './agent-redact'
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
const AGENT_READ_MAX = 30_000

/** head+tail truncation with an explicit receipt — never silent (P0-6). */
export function truncateWithReceipt(text: string, max: number): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  const headLen = Math.floor(max * 0.75)
  const tailLen = max - headLen
  return `${text.slice(0, headLen)}\n… [truncated ${dropped} chars]\n${text.slice(text.length - tailLen)}`
}

/** Untruncatable trailer appended AFTER truncation (P0-5). */
function exitTrailer(result: { exitCode: number; timedOut?: boolean; oomSuspected?: boolean }, timeoutMs?: number): string {
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

/** Paths the agent must never read/write through file tools: the whole
 * ~/.cell prefix (keys, sessions, registries, secrets) — see
 * src/vfs/protected-paths.ts for the policy. */
export function isDeniedPath(absPath: string): boolean {
  return isProtectedPath(vfsPath.normalize(absPath))
}

/** Write/edit additionally refuse shell-auto-executed files (~/.bashrc):
 * readable, never writable by the agent. */
function isWriteDeniedPath(absPath: string): boolean {
  const normalizedPath = vfsPath.normalize(absPath)
  return isProtectedPath(normalizedPath) || isWriteProtectedPath(normalizedPath)
}

/** Bash patterns that error instead of running (P0-4): destructive or
 * self-modifying commands the non-interactive approval line cannot gate.
 * This is a guardrail, not a sandbox boundary: it catches the common
 * shapes (rm -rf/-fr/-r -f/--recursive --force, pipe-to-shell) but a
 * determined command can spell the same effect other ways. The real
 * gate is the UI approval prompt; these patterns exist so a fat-fingered
 * or prompt-injected `rm -rf` never runs unexamined in headless mode. */
const BASH_DENY: { re: RegExp; label: string }[] = [
  { re: /\brm\s+[^|;&]*(?:\s|^)(?:~|\/|\$HOME|\${HOME})/, label: 'rm on home/root' },
  { re: /\bcell\s+(load|save)\b/, label: 'cell load/save' },
  { re: /\bcurl\b[^|]*\|\s*(?:sh|bash)\b/, label: 'curl|sh' },
  { re: /\bwget\b[^|]*\|\s*(?:sh|bash)\b/, label: 'wget|sh' },
]

/** rm is refused only when recursive AND force combine (any spelling:
 * -rf, -fr, -r -f, --recursive --force). Plain `rm -f x` stays allowed. */
function isRecursiveForceRm(command: string): boolean {
  for (const segment of command.split(/[|;&\n]+/)) {
    const tokens = segment.trim().split(/\s+/)
    const rmIndex = tokens.findIndex((token) => token === 'rm')
    if (rmIndex === -1) continue
    const flagTokens = tokens.slice(rmIndex + 1).filter((token) => token.startsWith('-'))
    const recursive = flagTokens.some((token) => token === '--recursive' || /^-[a-z]*r/i.test(token))
    const force = flagTokens.some((token) => token === '--force' || /^-[a-z]*f/i.test(token))
    if (recursive && force) return true
  }
  return false
}

/** First path-like token in a bash command that lands on denied agent
 * state, or null. Tokens are normalized (., .., ~) before the check so
 * spelling tricks do not walk around the file-tool deny-list. This is
 * still text scanning, not parsing: `$(cat ~/.cell/agent.json)` spelled
 * with variables or concatenation can evade it. The UI approval gate is
 * the real boundary; this keeps honest and semi-honest commands out. */
export function bashDeniedPath(command: string): string | null {
  for (const rawToken of command.split(/[\s'"`]+/)) {
    const token = rawToken.replace(/[),;]+$/, '')
    if (!token.includes('/')) continue
    const expanded = expand(token, '/home/user')
    if (isDeniedPath(expanded)) return expanded
  }
  return null
}

/** non-null when a bash command must be refused before it runs. */
export function bashDenyReason(command: string): string | null {
  const deniedPath = bashDeniedPath(command)
  if (deniedPath !== null) {
    return `refused: agent key/config/registry paths are not reachable from bash (${deniedPath})`
  }
  if (isRecursiveForceRm(command)) {
    return 'refused rm -rf: destructive or self-modifying commands cannot run non-interactively'
  }
  for (const { re, label } of BASH_DENY) {
    re.lastIndex = 0
    if (re.test(command)) return `refused ${label}: destructive or self-modifying commands cannot run non-interactively`
  }
  return null
}

const BUILTIN_DEFS: { name: string; description: string; approval: ApprovalPolicy }[] = [
  { name: 'bash', description: 'Run a shell command in the workspace (bash-compatible). Returns stdout+stderr and the exit code. cd is per-call. Each step times out after 120s (exit 124, overridable with timeoutMs up to 600000); output past 20k chars is head+tail truncated with a receipt.', approval: 'ask' },
  { name: 'read', description: 'Read a file from the filesystem. Text files are paged (offset/limit); pass base64:true for raw bytes of images/wasm/archives.', approval: 'auto' },
  { name: 'edit', description: 'Replace one exact block of text in a file. The old text must occur exactly once.', approval: 'ask' },
  { name: 'write', description: 'Create or overwrite a text file. Parent directories are created.', approval: 'ask' },
  { name: 'ls', description: 'List a directory.', approval: 'auto' },
  { name: 'load_skill', description: 'Load the full body of a skill by name (progressive disclosure: the system prompt only carries names + one-liners).', approval: 'auto' },
  { name: 'job_start', description: 'Start a long command in the background (own shell env, 10-min cap). Returns a job id; output streams to ~/.cell/jobs/<id>.log.', approval: 'ask' },
  { name: 'job_poll', description: 'Check a background job: status, exit code, and latest output tail.', approval: 'auto' },
  { name: 'job_list', description: 'List background jobs started this run.', approval: 'auto' },
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
      base64: { type: 'boolean', description: 'return raw bytes as base64 (images, wasm, archives) instead of text lines' },
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
  job_start: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'the command line to run in the background' },
      cwd: { type: 'string', description: 'working directory (default: home)' },
    },
    required: ['command'],
  },
  job_poll: {
    type: 'object',
    properties: { id: { type: 'string', description: 'job id from job_start' } },
    required: ['id'],
  },
  job_list: {
    type: 'object',
    properties: {},
    required: [],
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
  // normalize here, not just in the VFS: the deny-list check below runs on
  // this string, so `~/.cell/../.cell/agent.json` must collapse before it
  if (raw === '~') return '/home/user'
  if (raw.startsWith('~/')) return vfsPath.normalize(`/home/user${raw.slice(1)}`)
  return raw.startsWith('/') ? vfsPath.normalize(raw) : vfsPath.join(cwd, raw)
}

export interface JobRecord {
  id: string
  command: string
  status: 'running' | 'done'
  exitCode?: number
  output: string
}

const JOBS_DIR = '/home/user/.cell/jobs'
const JOB_MAX_OUTPUT = 40_000

/**
 * Background jobs: long commands the agent starts and polls instead of
 * blocking a step. Jobs run on a DEDICATED shell instance (own session
 * env — exports in the foreground shell do not carry in; say so in the
 * command if it matters). Output streams to ~/.cell/jobs/<id>.log so a
 * resumed session can still read what a job produced.
 */
export class JobManager {
  private jobs = new Map<string, JobRecord>()
  private counter = 0

  constructor(private shell: ShellLike, private vfs: Vfs) {}

  start(command: string, cwd: string): JobRecord {
    const denied = bashDenyReason(command)
    if (denied !== null) throw new Error(denied)
    // run-scoped unique id: a bare counter per run overwrote the
    // previous run's job-1 status/log while it could still write
    const id = `job-${Date.now().toString(36)}-${++this.counter}`
    const startedAt = Date.now()
    const record: JobRecord = { id, command, status: 'running', output: '' }
    this.jobs.set(id, record)
    const logPath = `${JOBS_DIR}/${id}.log`
    const writeStatus = () => {
      try {
        this.vfs.write(`${JOBS_DIR}/${id}.json`, JSON.stringify({ id, command, status: record.status, startedAt, ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}) }))
      } catch { /* status file is best-effort */ }
    }
    writeStatus()
    const append = (text: string) => {
      // redact before the log file: it is a plain VFS file that ships in
      // cell save snapshots, unlike transcript lines it is not re-redacted
      // redact the JOINED buffer: per-chunk redaction lets a secret
      // split across two progress appends survive in the on-disk log
      record.output = redactSecrets(truncateWithReceipt(`${record.output}${text}`, JOB_MAX_OUTPUT))
      try { this.vfs.write(logPath, record.output) } catch { /* log is best-effort */ }
    }
    append(`$ ${command}\n`)
    void this.shell.exec(command, cwd, (line) => append(`${line}\n`), { timeoutMs: 600_000 })
      .then((result) => {
        record.status = 'done'
        record.exitCode = result.exitCode
        append(`${result.stdout}${result.stderr}${exitTrailer(result, 600_000)}\n`)
        writeStatus()
      })
      .catch((err) => {
        record.status = 'done'
        record.exitCode = -1
        append(`\n[job error: ${err instanceof Error ? err.message : String(err)}]\n`)
        writeStatus()
      })
    return record
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  list(): JobRecord[] {
    return [...this.jobs.values()]
  }
}

export interface RunToolDeps {
  vfs: Vfs
  shell: ShellLike
  cwd: string
  /** full skill bodies by name, for the load_skill tool */
  skills?: Map<string, string>
  /** custom tool definitions (re-loaded per run; pass through for tests) */
  customTools?: Map<string, CustomToolDef>
  /** background job table (job_start/job_poll/job_list); absent = jobs off */
  jobs?: JobManager
}

export async function runTool(deps: RunToolDeps, call: ToolCall): Promise<ToolResult> {
  const { vfs, shell } = deps
  try {
    if (call.name === 'job_start' || call.name === 'job_poll' || call.name === 'job_list') {
      if (deps.jobs === undefined) return { id: call.id, content: 'background jobs are not enabled in this run', isError: true }
      if (call.name === 'job_start') {
        const command = String(call.input.command ?? '')
        const cwd = call.input.cwd !== undefined ? expand(String(call.input.cwd), deps.cwd) : deps.cwd
        try {
          const record = deps.jobs.start(command, cwd)
          return { id: call.id, content: `started ${record.id}: ${command} (poll with job_poll, log ~/.cell/jobs/${record.id}.log)` }
        } catch (err) {
          return { id: call.id, content: err instanceof Error ? err.message : String(err), isError: true }
        }
      }
      if (call.name === 'job_list') {
        const all = deps.jobs.list()
        return { id: call.id, content: all.length === 0 ? '(no jobs)' : all.map((job) => `${job.id} ${job.status}${job.exitCode !== undefined ? ` exit ${job.exitCode}` : ''} — ${job.command}`).join('\n') }
      }
      const record = deps.jobs.get(String(call.input.id ?? ''))
      if (record === undefined) return { id: call.id, content: `unknown job '${String(call.input.id ?? '')}'`, isError: true }
      const tail = record.output.slice(-4000)
      return { id: call.id, content: `${record.id} ${record.status}${record.exitCode !== undefined ? ` exit ${record.exitCode}` : ''}\n${tail || '(no output yet)'}` }
    }
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
      if (call.input.base64 === true) {
        const bytes = vfs.readBytes(path)
        if (bytes === null) return { id: call.id, content: `no such file: ${path}`, isError: true }
        const MAX_BINARY = 262_144
        const slice = bytes.subarray(0, MAX_BINARY)
        let binary = ''
        for (let i = 0; i < slice.length; i += 8192) binary += String.fromCharCode(...slice.subarray(i, i + 8192))
        const receipt = bytes.length > MAX_BINARY ? ` (first ${MAX_BINARY} of ${bytes.length} bytes)` : ` (${bytes.length} bytes)`
        return { id: call.id, content: `base64${receipt}:\n${btoa(binary)}` }
      }
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
      if (isWriteDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not writable (${path})`, isError: true }
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
      if (isWriteDeniedPath(path)) return { id: call.id, content: `refused: agent key/config/registry paths are not writable (${path})`, isError: true }
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
