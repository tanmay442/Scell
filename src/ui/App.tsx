import { Suspense, lazy, useState } from 'react'
import { AgentHome } from './AgentHome'
import { StatusDock } from './StatusDock'

export type SidebarView = 'explorer' | 'git' | 'agent'

const CodeShell = lazy(() => import('./CodeShell').then((module) => ({ default: module.CodeShell })))

/**
 * The agent is the front door; the full IDE lives one click away
 * behind "Workspace" and loads on demand.
 */
const APP_MODE_KEY = 'cell.appMode'

export function App() {
  const [appMode, setMode] = useState<'agent' | 'code'>(() => {
    try {
      return localStorage.getItem(APP_MODE_KEY) === 'code' ? 'code' : 'agent'
    } catch {
      return 'agent'
    }
  })
  const setAppMode = (mode: 'agent' | 'code') => {
    try {
      localStorage.setItem(APP_MODE_KEY, mode)
    } catch { /* private mode */ }
    setMode(mode)
  }

  if (appMode === 'agent') {
    return (
      <>
        <AgentHome onOpenWorkspace={() => setAppMode('code')} />
        <StatusDock onOpenWorkspace={() => setAppMode('code')} />
      </>
    )
  }
  return (
    <Suspense fallback={null}>
      <CodeShell onHome={() => setAppMode('agent')} />
      <StatusDock />
    </Suspense>
  )
}
