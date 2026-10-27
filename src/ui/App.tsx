import { useEffect, useState } from 'react'
import { platform } from '../platform'
import { workspaceActions } from './workspace-store'
import { attachGlobalKeys } from './keyboard'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { Sidebar } from './Sidebar'
import { EditorArea } from './EditorArea'
import { BottomPanel } from './BottomPanel'
import { PreviewPanel } from './PreviewPanel'
import { StatusBar } from './StatusBar'

export type SidebarView = 'explorer' | 'git'

export function App() {
  const [panelVisible, setPanelVisible] = useState(true)
  const [sidebarView, setSidebarView] = useState<SidebarView>('explorer')

  useEffect(() => {
    const { bus } = platform()
    const detachKeys = attachGlobalKeys({ togglePanel: () => setPanelVisible((v) => !v) })
    const unwatch = bus.on('vfs:changed', (e) => {
      if (e.kind === 'delete') workspaceActions.handleVfsDelete(e.path)
      if (e.kind === 'rename' && e.to) workspaceActions.handleVfsRename(e.path, e.to)
    })
    bus.emit('app:status', { message: 'workspace ready', tone: 'ok' })
    return () => {
      detachKeys()
      unwatch()
    }
  }, [])

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <ActivityBar active={sidebarView} onSelect={(view) => setSidebarView(view)} />
        <Sidebar view={sidebarView} />
        <div className="app-main">
          <div className="editor-preview-row">
            <EditorArea />
            <PreviewPanel />
          </div>
          <BottomPanel
            onToggle={() => setPanelVisible(false)}
            collapsed={!panelVisible}
          />
        </div>
      </div>
      <StatusBar onTogglePanel={() => setPanelVisible((v) => !v)} panelVisible={panelVisible} />
    </div>
  )
}
