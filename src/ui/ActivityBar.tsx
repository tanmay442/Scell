import { Bot, Files, Search, GitBranch, Blocks, Settings } from 'lucide-react'
import type { SidebarView } from './App'

const ITEMS: {
  id: SidebarView | string
  label: string
  icon: typeof Files
  view?: SidebarView
  hint?: string
}[] = [
  { id: 'explorer', label: 'Explorer', icon: Files, view: 'explorer' },
  { id: 'git', label: 'Source Control', icon: GitBranch, view: 'git' },
  { id: 'agent', label: 'Agent', icon: Bot, view: 'agent' },
  { id: 'search', label: 'Search', icon: Search, hint: 'Search — Phase 5' },
  { id: 'packages', label: 'Packages', icon: Blocks, hint: 'npm install — you can already run it in the terminal' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'Settings — later' },
]

export function ActivityBar({ active, onSelect }: { active: SidebarView; onSelect(view: SidebarView): void }) {
  return (
    <nav className="activity-bar">
      {ITEMS.map(({ id, label, icon: Icon, view, hint }) => {
        const enabled = view !== undefined
        const isActive = enabled && view === active
        return (
          <button
            key={id}
            className={`activity-item ${enabled ? 'enabled' : 'disabled'} ${isActive ? 'active' : ''}`}
            title={hint || label}
            disabled={!enabled}
            onClick={() => view && onSelect(view)}
          >
            <Icon size={22} strokeWidth={1.6} />
            {id === 'git' ? <span className="activity-badge" /> : null}
          </button>
        )
      })}
    </nav>
  )
}
