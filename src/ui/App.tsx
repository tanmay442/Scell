import { Suspense, lazy, useState } from 'react'
import { AgentHome } from './AgentHome'

export type SidebarView = 'explorer' | 'git' | 'agent'

const CodeShell = lazy(() => import('./CodeShell').then((module) => ({ default: module.CodeShell })))

/**
 * The agent is the front door; the full IDE lives one click away
 * behind "Workspace" and loads on demand.
 */
export function App() {
  const [appMode, setAppMode] = useState<'agent' | 'code'>('agent')

  if (appMode === 'agent') {
    return <AgentHome onOpenWorkspace={() => setAppMode('code')} />
  }
  return (
    <Suspense fallback={null}>
      <CodeShell onHome={() => setAppMode('agent')} />
    </Suspense>
  )
}
