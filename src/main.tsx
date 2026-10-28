import { createRoot } from 'react-dom/client'
import { EventBus } from './events'
import { initPlatform } from './platform'
import { createVfs, createIdbPersistence, seedStarterProject, migrateStarter, ensureStarterProject, startAutoSave } from './vfs'
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
  // Seed only a truly fresh workspace — migrateStarter writes dotfiles into
  // old workspaces, and running it first on a fresh VFS made the workspace
  // non-empty, silently suppressing the starter project.
  if (saved) {
    migrateStarter(vfs)
    ensureStarterProject(vfs)
  } else {
    seedStarterProject(vfs)
  }
  // installed dependencies live in IndexedDB now — ask Chrome not to evict
  // them under storage pressure (granted silently in most cases)
  void navigator.storage?.persist?.().catch(() => {})
  // Earlier builds kept repo state in a separate IndexedDB store; .git is a
  // real VFS directory now, so that database is dead weight — remove it once.
  if (typeof indexedDB !== 'undefined') {
    try {
      void indexedDB.deleteDatabase('cell-git-state-v2')
    } catch {
      // private mode — persistence is best-effort anyway
    }
  }

  const bus = new EventBus()
  initPlatform({ vfs, bus })
  startAutoSave(vfs, persistence)
  // every VFS mutation is mirrored onto the bus — the tree, status bar and
  // tab bookkeeping all listen there, not to the VFS directly. Events
  // coalesce into one per quiet window: an npm install writes thousands of
  // files, and a UI rebuild per file froze the tab.
  let vfsEventTimer: ReturnType<typeof setTimeout> | null = null
  let lastVfsEvent: import('./vfs/types').VfsEvent = { kind: 'write', path: '/' }
  vfs.watch((event) => {
    lastVfsEvent = event
    if (vfsEventTimer !== null) return
    vfsEventTimer = setTimeout(() => {
      vfsEventTimer = null
      bus.emit('vfs:changed', lastVfsEvent)
    }, 120)
  })

  const root = createRoot(document.getElementById('root')!)
  root.render(<App />)

  bus.emit('diagnostics:updated', { diagnostics: [], version: 0 })
  startLanguageService()
  bus.emit('app:ready', {})
}

void boot()
