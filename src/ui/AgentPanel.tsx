import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Play, RotateCcw, Save, X } from 'lucide-react'
import { platform } from '../platform'
import { createShell } from '../shell/shell'
import { runAgent } from '../shell/commands/agent'
import { listSessions } from '../shell/commands/agent-sessions'
import type { ToolCall } from '../shell/commands/agent-tools'
import { getActivePath } from './workspace-store'

const CONFIG_PATH = '/home/user/.cell/agent.json'
const HOME = '/home/user'

interface AgentConfigForm {
  provider: string
  model: string
  apiKey: string
  baseURL: string
}

const EMPTY_FORM: AgentConfigForm = { provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: '', baseURL: '' }

function loadForm(): AgentConfigForm {
  try {
    const raw = platform().vfs.read(CONFIG_PATH)
    if (raw === null) return EMPTY_FORM
    const parsed = JSON.parse(raw) as Partial<AgentConfigForm>
    return {
      provider: parsed.provider ?? 'meta',
      model: parsed.model ?? '',
      apiKey: parsed.apiKey ?? '',
      baseURL: parsed.baseURL ?? '',
    }
  } catch {
    return EMPTY_FORM
  }
}

function summarizeCall(call: ToolCall): string {
  if (call.name === 'bash' || call.name === 'job_start') return String(call.input.command ?? '')
  if (call.input.path !== undefined) return `${call.input.path}`
  return JSON.stringify(call.input).slice(0, 140)
}

/**
 * Agent panel: config, prompt, live streaming transcript, per-call
 * approve/deny (the real gate the headless terminal cannot offer), and
 * session resume. The run executes against the same VFS + shell the
 * terminal uses; jobs get a dedicated shell instance.
 */
export function AgentPanel() {
  const [form, setForm] = useState<AgentConfigForm>(loadForm)
  const [savedNote, setSavedNote] = useState('')
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState(30)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [sessions, setSessions] = useState<string[]>([])
  const [pending, setPending] = useState<{ summary: string } | null>(null)
  const approvalQueueRef = useRef<{ summary: string; resolve: (allowed: boolean) => void }[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const refreshSessions = useCallback(() => {
    setSessions(listSessions(platform().vfs).map((name) => name.replace(/\.json$/, '')))
  }, [])

  useEffect(refreshSessions, [refreshSessions])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-499), line])
  }, [])

  // FIFO: parallel runs/jobs can queue approvals; a single-slot
  // resolver would drop all but the last
  const approve = useCallback((call: ToolCall): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const entry = { summary: `${call.name} ${summarizeCall(call)}`, resolve }
      approvalQueueRef.current.push(entry)
      if (approvalQueueRef.current.length === 1) setPending({ summary: entry.summary })
    })
  }, [])

  const decide = (allowed: boolean) => {
    const head = approvalQueueRef.current.shift()
    head?.resolve(allowed)
    const next = approvalQueueRef.current[0]
    setPending(next ? { summary: next.summary } : null)
  }

  const cancelApprovals = () => {
    for (const entry of approvalQueueRef.current.splice(0)) entry.resolve(false)
    setPending(null)
  }

  const saveConfig = () => {
    const data: Record<string, string> = { provider: form.provider }
    if (form.model.trim() !== '') data.model = form.model.trim()
    if (form.apiKey.trim() !== '') data.apiKey = form.apiKey.trim()
    if (form.provider === 'compat' && form.baseURL.trim() !== '') data.baseURL = form.baseURL.trim()
    platform().vfs.write(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`)
    setSavedNote('saved to ~/.cell/agent.json')
  }

  const run = async (resumeId: string | null) => {
    const text = prompt.trim()
    if (running || (resumeId === null && text === '') || (resumeId !== null && text === '')) return
    setRunning(true)
    setLog([])
    appendLog(resumeId !== null ? `agent ▸ (resume ${resumeId}) ${text}` : `agent ▸ ${text}`)
    const { vfs } = platform()
    const cwd = getActivePath() ?? HOME
    try {
      const shell = createShell(vfs, { protected: true })
      const jobShell = createShell(vfs, { protected: true })
      const args = resumeId !== null
        ? ['--resume', resumeId, '--steps', String(steps), text]
        : ['--steps', String(steps), text]
      const result = await runAgent(vfs, args, { cwd, shell, jobShell, onProgress: appendLog, approve })
      appendLog(result.exitCode === 0 ? 'agent ✓ done' : `agent ✗ exit ${result.exitCode} — see terminal transcript for detail`)
      if (result.stderr.trim() !== '') appendLog(result.stderr.trim())
    } catch (err) {
      appendLog(`agent ✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
      cancelApprovals()
      refreshSessions()
    }
  }

  return (
    <div className="agent-panel">
      <div className="agent-section">
        <label className="agent-label">Provider</label>
        <select className="agent-input" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
          <option value="meta">meta (Muse Spark)</option>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="compat">openai-compatible (baseURL)</option>
        </select>
        <label className="agent-label">Model</label>
        <input className="agent-input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="muse-spark-1.3-contributor" />
        {form.provider === 'compat' ? (
          <>
            <label className="agent-label">Base URL</label>
            <input className="agent-input" value={form.baseURL} onChange={(e) => setForm({ ...form, baseURL: e.target.value })} placeholder="https://api.x.ai/v1" />
          </>
        ) : null}
        <label className="agent-label">API key {form.provider === 'meta' ? '(blank = machine auth file)' : ''}</label>
        <input className="agent-input" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-…" />
        <button className="agent-btn" onClick={saveConfig}><Save size={13} /> Save config</button>
        {savedNote !== '' ? <div className="agent-note">{savedNote}</div> : null}
      </div>

      <div className="agent-section">
        <label className="agent-label">Task</label>
        <textarea className="agent-input agent-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Fix the failing test in src/…" />
        <div className="agent-row">
          <label className="agent-label inline">Steps
            <input className="agent-input agent-steps" type="number" min={1} max={200} value={steps} onChange={(e) => setSteps(Math.max(1, Number(e.target.value) || 30))} />
          </label>
          <button className="agent-btn primary" disabled={running || prompt.trim() === ''} onClick={() => void run(null)}><Play size={13} /> Run</button>
        </div>
      </div>

      {pending !== null ? (
        <div className="agent-approval">
          <div className="agent-approval-text">Approve this tool call?</div>
          <div className="agent-approval-call">{pending.summary}</div>
          <div className="agent-row">
            <button className="agent-btn primary" onClick={() => decide(true)}><Check size={13} /> Approve</button>
            <button className="agent-btn danger" onClick={() => decide(false)}><X size={13} /> Deny</button>
          </div>
        </div>
      ) : null}

      <pre className="agent-log" ref={logRef}>{log.length === 0 ? 'Agent output streams here. Ask tools (bash, edit, write, custom) pause for your approval above.' : log.join('\n')}</pre>

      <div className="agent-section">
        <label className="agent-label">Sessions (resume)</label>
        {sessions.length === 0 ? <div className="agent-note">no sessions yet</div> : sessions.map((id) => (
          <div key={id} className="agent-session-row">
            <span className="agent-session-id">{id}</span>
            <button className="agent-btn" disabled={running || prompt.trim() === ''} title="Resume with the task text above" onClick={() => void run(id)}><RotateCcw size={12} /> Resume</button>
          </div>
        ))}
      </div>

      <div className="agent-note agent-foot"><Bot size={12} /> Tools: bash/read/edit/write/ls/load_skill, job_start/job_poll/job_list, plus ~/.cell/tools/*.json. Skills: ~/.cell/skills/*/SKILL.md.</div>
    </div>
  )
}
