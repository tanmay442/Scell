import { useState } from 'react'
import { Hexagon, X } from 'lucide-react'
import { platform } from '../platform'
import { workspaceActions, useWorkspace } from './workspace-store'
import { FileIcon } from './file-icon'
import CodeEditor from '../editor/CodeEditor'

export function EditorArea() {
  const ws = useWorkspace()
  const { vfs } = platform()
  const [closing, setClosing] = useState<string | null>(null)

  const requestClose = (path: string) => {
    if (ws.dirty.has(path)) setClosing(path)
    else workspaceActions.closeTab(path)
  }

  return (
    <section className="editor-area">
      <div className="tab-strip">
        {ws.openPaths.map((path) => (
          <div
            key={path}
            className={`tab ${path === ws.activePath ? 'active' : ''}`}
            onClick={() => workspaceActions.setActive(path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                requestClose(path)
              }
            }}
            title={path}
          >
            <FileIcon path={path} size={13} />
            <span className="tab-name">{path.split('/').pop()}</span>
            <span className={`tab-dirty ${ws.dirty.has(path) ? 'on' : ''}`} />
            <button
              className="tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation()
                requestClose(path)
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {ws.openPaths.length === 0 ? <div className="tab active welcome-tab">Welcome</div> : null}
      </div>

      {closing !== null ? (
        <div className="dirty-confirm">
          <span>
            <strong>{closing.split('/').pop()}</strong> has unsaved changes
          </span>
          <button
            className="primary"
            onClick={() => {
              workspaceActions.save(closing)
              workspaceActions.closeTab(closing)
              setClosing(null)
            }}
          >
            Save
          </button>
          <button
            onClick={() => {
              workspaceActions.closeTab(closing)
              setClosing(null)
            }}
          >
            Discard
          </button>
          <button onClick={() => setClosing(null)}>Cancel</button>
        </div>
      ) : null}

      <div className="editor-host">
        {ws.openPaths.length === 0 ? (
          <Welcome />
        ) : (
          ws.openPaths.map((path) => {
            const draft = workspaceActions.draft(path)
            const value = draft !== undefined ? draft : (vfs.read(path) ?? '')
            const reveal = ws.reveal !== null && ws.reveal.path === path ? ws.reveal.line : undefined
            return (
              <CodeEditor
                key={`${path}::${ws.resetTokens.get(path) ?? 0}`}
                path={path}
                value={value}
                active={path === ws.activePath}
                revealLine={reveal}
                onRevealed={() => workspaceActions.consumeReveal()}
                onChange={(next) => workspaceActions.setDraft(path, next)}
              />
            )
          })
        )}
      </div>
    </section>
  )
}

function Welcome() {
  const quick: { label: string; path?: string }[] = [
    { label: 'Open README.md', path: '/README.md' },
    { label: 'Open src/index.ts', path: '/src/index.ts' },
    { label: 'Open src/broken.ts (see live type errors)', path: '/src/broken.ts' },
  ]
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <Hexagon size={44} className="cell-mark" strokeWidth={1.6} />
        <h1>Cell</h1>
        <p className="welcome-sub">A dev environment that lives entirely in this browser tab.</p>
      </div>
      <div className="welcome-cols">
        <div>
          <h2>Start</h2>
          {quick.map((q) => (
            <button key={q.label} className="linkish" onClick={() => q.path && workspaceActions.openFile(q.path)}>
              {q.label}
            </button>
          ))}
          <h2>Workspace</h2>
          <span className="welcome-hint">starter · TypeScript strict · no server</span>
        </div>
        <div>
          <h2>Keyboard</h2>
          <ul className="welcome-keys">
            <li>
              <kbd>Ctrl</kbd>+<kbd>S</kbd> save active file
            </li>
            <li>
              <kbd>Ctrl</kbd>+<kbd>`</kbd> toggle terminal panel
            </li>
            <li>
              <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>W</kbd> close tab
            </li>
            <li>
              <kbd>Ctrl</kbd>+<kbd>C</kbd> clear terminal line
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
