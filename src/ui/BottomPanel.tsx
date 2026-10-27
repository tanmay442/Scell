import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { diagnosticsStore } from '../diagnostics-store'
import { ProblemsPanel } from './ProblemsPanel'

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel'))

const MIN_HEIGHT = 120
const MAX_HEIGHT_VH = 0.6

export function BottomPanel({ onToggle }: { onToggle: () => void }) {
  const [tab, setTab] = useState<'terminal' | 'problems'>('terminal')
  const [height, setHeight] = useState(280)
  const [resizing, setResizing] = useState(false)
  const [errorCount, setErrorCount] = useState(0)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  useEffect(() => diagnosticsStore.subscribe(() => {
    setErrorCount(diagnosticsStore.get().items.filter((d) => d.category === 'error').length)
  }), [])

  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { startY: e.clientY, startHeight: height }
      setResizing(true)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [height],
  )

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const max = window.innerHeight * MAX_HEIGHT_VH
    const delta = dragRef.current.startY - e.clientY
    setHeight(Math.min(max, Math.max(MIN_HEIGHT, dragRef.current.startHeight + delta)))
  }, [])

  const onHandleUp = useCallback(() => {
    dragRef.current = null
    setResizing(false)
  }, [])

  return (
    <section className={`bottom-panel ${resizing ? 'resizing' : ''}`} style={{ height }}>
      <div
        className="panel-resize-handle"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
      />
      <div className="panel-tabs">
        <button className={`panel-tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab('terminal')}>
          TERMINAL
        </button>
        <button className={`panel-tab ${tab === 'problems' ? 'active' : ''}`} onClick={() => setTab('problems')}>
          PROBLEMS {errorCount > 0 ? <span className="count-badge error">{errorCount}</span> : null}
        </button>
        <span className="panel-spacer" />
        <button className="panel-icon" title="Hide panel (Ctrl+`)" onClick={onToggle}>
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'terminal' ? (
          <Suspense fallback={<div className="panel-fallback">loading shell…</div>}>
            <TerminalPanel />
          </Suspense>
        ) : (
          <ProblemsPanel />
        )}
      </div>
    </section>
  )
}
