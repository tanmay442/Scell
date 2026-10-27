import { Files, Search, GitBranch, Blocks, Settings } from 'lucide-react'

const ITEMS = [
  { id: 'explorer', label: 'Explorer', icon: Files, enabled: true, hint: '' },
  { id: 'search', label: 'Search', icon: Search, enabled: false, hint: 'Search — Phase 5' },
  { id: 'git', label: 'Source Control', icon: GitBranch, enabled: false, hint: 'Git — Phase 3' },
  { id: 'extensions', label: 'Packages', icon: Blocks, enabled: false, hint: 'npm install — Phase 2' },
  { id: 'settings', label: 'Settings', icon: Settings, enabled: false, hint: 'Settings — later' },
]

export function ActivityBar() {
  return (
    <nav className="activity-bar">
      {ITEMS.map(({ id, label, icon: Icon, enabled, hint }) => (
        <button
          key={id}
          className={`activity-item ${enabled ? 'enabled active' : 'disabled'}`}
          title={hint || label}
          disabled={!enabled}
        >
          <Icon size={22} strokeWidth={1.6} />
        </button>
      ))}
    </nav>
  )
}
