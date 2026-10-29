import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Bot, Check, ChevronRight, Play, SquarePen, X } from 'lucide-react'
import { agentActions, agentStore, COMPACT_AT_CHARS } from './agent-store'

/**
 * Agent chat (main area): streaming transcript as structured entries,
 * inline approval cards, context meter, composer. Sessions, config,
 * skills and tools live in the Agent sidebar; this is the conversation.
 */
export function AgentChat() {
  const state = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState(30)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    agentActions.refresh()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [state.entries, state.pendingSummary])

  const send = () => {
    if (prompt.trim() === '') return
    const text = prompt
    setPrompt('')
    void agentActions.run(text, steps)
  }

  const contextTokens = Math.round(state.contextChars / 4)
  const contextPct = Math.min(100, Math.round((state.contextChars / COMPACT_AT_CHARS) * 100))
  const modelLabel = state.config.model || state.config.provider

  return (
    <section className="agent-chat">
      <header className="agent-chat-header">
        <span className="agent-chat-title"><Bot size={15} /> Agent</span>
        <span className="agent-chip">{state.config.provider}/{modelLabel}</span>
        <span className={`agent-chip ${state.config.permission === 'full' ? 'ok' : 'warn'}`}>
          {state.config.permission === 'full' ? 'full permission' : 'ask mode'}
        </span>
        {state.sessionId !== null ? <span className="agent-chip mono">{state.sessionId}</span> : null}
        <span className="agent-context" title="Estimated context; auto-compaction summarizes at the threshold">
          <span className="agent-context-bar"><span style={{ width: `${contextPct}%` }} /></span>
          <span className="agent-context-label">~{contextTokens.toLocaleString()} tok · compacts at ~{Math.round(COMPACT_AT_CHARS / 4000)}k</span>
        </span>
        <span className="agent-spacer" />
        <button className="agent-btn" onClick={() => agentActions.clearChat()}><SquarePen size={13} /> New chat</button>
      </header>

      <div className="agent-chat-scroll" ref={scrollRef}>
        <div className="agent-chat-column">
          {state.entries.length === 0 ? (
            <div className="agent-empty">
              <Bot size={28} />
              <p>Ask for work in this workspace. The agent has bash, files, skills, background jobs and your custom tools.</p>
              <p className="agent-empty-hint">Try: “run the tests and fix what fails” · “plot the CSV in ~/project as a chart in ~/artifacts”</p>
            </div>
          ) : null}
          {state.entries.map((entry) => {
            if (entry.kind === 'user') {
              return (
                <div key={entry.id} className="chat-user">
                  <span className="chat-user-mark">❯</span>
                  <span>{entry.text}</span>
                </div>
              )
            }
            if (entry.kind === 'tool') {
              return (
                <div key={entry.id} className="chat-tool">
                  <ChevronRight size={13} />
                  <span className="chat-tool-text">{entry.text}</span>
                </div>
              )
            }
            if (entry.kind === 'result') {
              return <pre key={entry.id} className="chat-result">{entry.text}</pre>
            }
            if (entry.kind === 'approval') {
              return (
                <div key={entry.id} className="chat-approval-record">
                  ❓ {entry.text}
                </div>
              )
            }
            if (entry.kind === 'note') {
              return (
                <div key={entry.id} className="chat-note">{entry.text}</div>
              )
            }
            return (
              <div key={entry.id} className="chat-assistant">{entry.text}</div>
            )
          })}
          {state.pendingSummary !== null ? (
            <div className="chat-approval">
              <div className="chat-approval-title">Approve this tool call?</div>
              <div className="chat-approval-call">{state.pendingSummary}</div>
              <div className="agent-row">
                <button className="agent-btn primary" onClick={() => agentActions.decide(true)}><Check size={13} /> Approve</button>
                <button className="agent-btn danger" onClick={() => agentActions.decide(false)}><X size={13} /> Deny</button>
              </div>
            </div>
          ) : null}
          {state.running ? <div className="chat-note">⠋ working…</div> : null}
        </div>
      </div>

      <footer className="agent-composer">
        <div className="agent-chat-column">
          {state.resumeTarget !== null ? (
            <div className="agent-resume-chip">
              resuming <span className="mono">{state.resumeTarget}</span>
              <button className="agent-chip-x" onClick={() => agentActions.setResumeTarget(null)}><X size={11} /></button>
            </div>
          ) : null}
          <div className="agent-composer-box">
            <textarea
              className="agent-composer-input"
              rows={3}
              value={prompt}
              placeholder="Describe the task…  (Enter to send, Shift+Enter for a newline)"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="agent-composer-bar">
              <label className="agent-label inline">steps
                <input className="agent-input agent-steps" type="number" min={1} max={200} value={steps} onChange={(e) => setSteps(Math.max(1, Number(e.target.value) || 30))} />
              </label>
              <select
                className="agent-input agent-permission"
                value={state.config.permission}
                onChange={(e) => {
                  agentActions.setConfig({ permission: e.target.value })
                  agentActions.saveConfig()
                }}
              >
                <option value="full">Full permission</option>
                <option value="ask">Ask each time</option>
              </select>
              <span className="agent-spacer" />
              <button className="agent-btn primary" disabled={state.running || prompt.trim() === ''} onClick={send}>
                <Play size={13} /> {state.running ? 'Running…' : 'Run'}
              </button>
            </div>
          </div>
        </div>
      </footer>
    </section>
  )
}
