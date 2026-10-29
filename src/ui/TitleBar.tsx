import { useEffect, useState } from 'react'
import { Logo } from './Logo'
import { platform } from '../platform'

export function TitleBar({ onHome }: { onHome?: () => void }) {
  const [status, setStatus] = useState<{ message: string; tone: 'info' | 'ok' | 'error' } | null>(null)

  useEffect(() => {
    const { bus } = platform()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = bus.on('app:status', (s) => {
      setStatus(s)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setStatus(null), 4000)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <header className="title-bar">
      <div className="title-bar-left">
        <button className="title-home" title="Back to Agent" onClick={onHome}>
          <Logo size={16} />
          <span>Agent</span>
        </button>
        <span className="wordmark">CELL</span>
        <span className="title-sep">/</span>
        <span className="project-name">workspace</span>
      </div>
      <div className={`title-status ${status ? `tone-${status.tone}` : ''}`}>{status?.message ?? ''}</div>
    </header>
  )
}
