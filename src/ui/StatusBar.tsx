import { useEffect, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { CircleAlert, TriangleAlert, TerminalSquare } from 'lucide-react'
import { platform } from '../platform'
import { diagnosticsStore } from '../diagnostics-store'

export function StatusBar({
  onTogglePanel,
  panelVisible,
}: {
  onTogglePanel(): void
  panelVisible: boolean
}) {
  const { vfs, bus } = platform()
  const { items } = useSyncExternalStore(diagnosticsStore.subscribe, diagnosticsStore.get)
  const [cwd, setCwd] = useState('/')
  const [fileCount, setFileCount] = useState(() => vfs.listAllFiles().length)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const offCwd = bus.on('terminal:cwd', ({ cwd }) => setCwd(cwd))
    let timer: ReturnType<typeof setTimeout> | null = null
    const offVfs = bus.on('vfs:changed', () => {
      setFileCount(vfs.listAllFiles().length)
      setSaving(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setSaving(false), 600)
    })
    return () => {
      offCwd()
      offVfs()
      if (timer) clearTimeout(timer)
    }
  }, [bus, vfs])

  const errors = items.filter((d) => d.category === 'error').length
  const warnings = items.filter((d) => d.category === 'warning').length

  return (
    <footer className="status-bar">
      <div className="status-left">
        <button className="status-chip" onClick={onTogglePanel} title="Toggle panel (Ctrl+`)">
          <TerminalSquare size={13} />
          {panelVisible ? `~${cwd === '/' ? '' : cwd}` : 'terminal'}
        </button>
        <span className="status-plain">
          {fileCount} file{fileCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="status-right">
        <span className={`save-dot ${saving ? 'saving' : 'saved'}`} title={saving ? 'saving…' : 'workspace saved'} />
        <span className="status-plain">{saving ? 'saving…' : 'saved'}</span>
        <button className="status-chip" onClick={onTogglePanel} title="Show problems">
          <CircleAlert size={13} className={errors ? 'problem-error' : ''} /> {errors}
          <TriangleAlert size={13} className={warnings ? 'problem-warning' : ''} /> {warnings}
        </button>
        <span className="status-pill">strict</span>
        <span className="status-pill">ts-rust</span>
      </div>
    </footer>
  )
}
