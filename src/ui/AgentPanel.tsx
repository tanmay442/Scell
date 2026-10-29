import { useEffect, useSyncExternalStore } from 'react'
import { History, Save, Settings2, Sparkles, Wrench } from 'lucide-react'
import { agentActions, agentStore } from './agent-store'

/**
 * Agent sidebar: sessions, model config, skills, tools. The
 * conversation itself lives in the main-area Agent chat.
 */
export function AgentPanel() {
  const state = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const form = state.config

  useEffect(() => {
    agentActions.refresh()
  }, [])

  return (
    <div className="agent-panel">
      <div className="agent-section">
        <div className="agent-section-title"><History size={13} /> Sessions</div>
        {state.sessions.length === 0 ? (
          <div className="agent-note">no sessions yet</div>
        ) : (
          state.sessions.map((id) => (
            <button
              key={id}
              className={`agent-session-item ${state.resumeTarget === id ? 'active' : ''}`}
              title="Resume this session with your next message"
              onClick={() => agentActions.setResumeTarget(state.resumeTarget === id ? null : id)}
            >
              {id}
            </button>
          ))
        )}
      </div>

      <div className="agent-section">
        <div className="agent-section-title"><Settings2 size={13} /> Model</div>
        <label className="agent-label">Provider</label>
        <select className="agent-input" value={form.provider} onChange={(e) => agentActions.setConfig({ provider: e.target.value })}>
          <option value="meta">meta (Muse Spark)</option>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="compat">openai-compatible (baseURL)</option>
        </select>
        <label className="agent-label">Model</label>
        <input className="agent-input" value={form.model} onChange={(e) => agentActions.setConfig({ model: e.target.value })} placeholder="muse-spark-1.3-contributor" />
        {form.provider === 'compat' ? (
          <>
            <label className="agent-label">Base URL</label>
            <input className="agent-input" value={form.baseURL} onChange={(e) => agentActions.setConfig({ baseURL: e.target.value })} placeholder="https://api.x.ai/v1" />
          </>
        ) : null}
        <label className="agent-label">API key {form.provider === 'meta' ? '(required in the browser)' : ''}</label>
        <input className="agent-input" type="password" value={form.apiKey} onChange={(e) => agentActions.setConfig({ apiKey: e.target.value })} placeholder="sk-…" />
        <label className="agent-label">Permission</label>
        <select className="agent-input" value={form.permission} onChange={(e) => agentActions.setConfig({ permission: e.target.value })}>
          <option value="full">Full permissions (default)</option>
          <option value="ask">Ask before each tool call</option>
        </select>
        <button className="agent-btn" onClick={() => agentActions.saveConfig()}><Save size={13} /> Save config</button>
        {state.savedNote !== '' ? <div className="agent-note">{state.savedNote}</div> : null}
      </div>

      <div className="agent-section">
        <div className="agent-section-title"><Sparkles size={13} /> Skills</div>
        {state.skills.length === 0 ? (
          <div className="agent-note">none — add ~/.cell/skills/&lt;name&gt;/SKILL.md</div>
        ) : (
          state.skills.map((skill) => (
            <div key={skill.name} className="agent-skill-item">
              <span className="agent-skill-name">{skill.name}</span>
              <span className="agent-skill-desc">{skill.description}</span>
            </div>
          ))
        )}
      </div>

      <div className="agent-section">
        <div className="agent-section-title"><Wrench size={13} /> Tools</div>
        <div className="agent-note">{state.tools.join(' · ')}</div>
      </div>
    </div>
  )
}
