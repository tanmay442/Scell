import { useEffect, useState } from 'react'
import { Binary, X } from 'lucide-react'
import { Logo } from './Logo'
import { platform } from '../platform'
import { workspaceActions, useWorkspace } from './workspace-store'
import { FileIcon } from './file-icon'
import CodeEditor from '../editor/CodeEditor'
import { downloadVfsFile } from './download'

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
            // deleted files and directories have no editable content — show
            // a placeholder instead of crashing (EISDIR) or silently
            // recreating the file on save
            if (!vfs.isFile(path)) {
              return (
                <div key={path} className="editor-missing">
                  {vfs.exists(path) ? 'This is a directory.' : 'This file no longer exists.'}
                </div>
              )
            }
            // images render; other binaries get a placeholder, not a lossy
            // text editor
            if (vfs.isFile(path) && !vfs.isText(path)) {
              if (isImage(path)) return <ImageView key={path} path={path} active={path === ws.activePath} />
              return <BinaryView key={path} path={path} active={path === ws.activePath} />
            }
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

const PROJECT = '/home/user/project'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])

function isImage(path: string): boolean {
  return IMAGE_EXTS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())
}

/** Renders image files straight from the VFS bytes (webp, png, svg, …). */
function ImageView({ path, active }: { path: string; active: boolean }) {
  const { vfs, bus } = platform()
  const [url, setUrl] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => bus.on('vfs:changed', (event) => {
    if (event.path === path) setVersion((v) => v + 1)
  }), [bus, path])
  useEffect(() => {
    const bytes = vfs.readBytes(path)
    if (bytes === null) return
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const created = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
    setUrl(created)
    return () => URL.revokeObjectURL(created)
  }, [vfs, path, version])
  const stat = vfs.stat(path)
  const size = stat ? (stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)} KB` : `${stat.size} B`) : ''
  return (
    <div className={`image-view ${active ? '' : 'hidden'}`}>
      {url !== null ? <img src={url} alt={path} /> : <span>cannot read {path}</span>}
      <span className="image-meta">
        {path.split('/').pop()} — {size}
      </span>
      <button className="view-download" onClick={() => downloadVfsFile(path)}>
        Download
      </button>
    </div>
  )
}

function BinaryView({ path, active }: { path: string; active: boolean }) {
  const { vfs } = platform()
  const stat = vfs.stat(path)
  const size = stat ? (stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)} KB` : `${stat.size} B`) : ''
  return (
    <div className={`binary-view ${active ? '' : 'hidden'}`}>
      <Binary size={28} />
      <span className="binary-name">{path.split('/').pop()}</span>
      <span className="binary-size">{size} — binary file, not editable</span>
      <button className="view-download" onClick={() => downloadVfsFile(path)}>
        Download
      </button>
    </div>
  )
}

function Welcome() {
  const quick: { label: string; path?: string }[] = [
    { label: 'Open README.md', path: `${PROJECT}/README.md` },
    { label: 'Open src/index.ts', path: `${PROJECT}/src/index.ts` },
    { label: 'Open src/broken.ts (see live type errors)', path: `${PROJECT}/src/broken.ts` },
  ]
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <Logo size={48} />
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
          <span className="welcome-hint">~/project · TypeScript strict · full home directory · no server</span>
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
