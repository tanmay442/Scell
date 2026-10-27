import { createRoot } from 'react-dom/client'
import { EventBus } from './events'
import { initPlatform } from './platform'
import { createVfs, createIdbPersistence, seedStarterProject, startAutoSave } from './vfs'
import { startLanguageService } from './lang/service'
import { App } from './ui/App'
import './styles/global.css'

// No StrictMode: its dev-only double-mounting double-initializes editors
// and terminals (CodeMirror state maps, xterm instances) — the kind of
// global side effect StrictMode exists to surface, but here the singleton
// platform makes the second mount genuinely wrong, not a bug indicator.
async function boot() {
  const persistence = createIdbPersistence()
  const saved = await persistence.load().catch(() => null)
  const vfs = createVfs(saved ?? undefined)
  seedStarterProject(vfs)

  const bus = new EventBus()
  initPlatform({ vfs, bus })
  startAutoSave(vfs, persistence)
  // every VFS mutation is mirrored onto the bus — the tree, status bar and
  // tab bookkeeping all listen there, not to the VFS directly
  vfs.watch((event) => bus.emit('vfs:changed', event))

  const root = createRoot(document.getElementById('root')!)
  root.render(<App />)

  bus.emit('diagnostics:updated', { diagnostics: [], version: 0 })
  startLanguageService()
  bus.emit('app:ready', {})
}

void boot()
