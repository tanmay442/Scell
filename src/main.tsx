import { createRoot } from 'react-dom/client'
import { EventBus } from './events'
import { initPlatform } from './platform'
import { createVfs, createIdbPersistence, loadSeedFlag, saveSeedFlag, seedStarterProject, migrateStarter, ensureStarterProject, startAutoSave } from './vfs'
import { startLanguageService } from './lang/service'
import { App } from './ui/App'
import { Theme } from '@astryxdesign/core/theme'
import { cellTheme } from './cell-theme'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/fonts.css'
import './styles/global.css'

// No StrictMode: its dev-only double-mounting double-initializes editors
// and terminals (CodeMirror state maps, xterm instances) — the kind of
// global side effect StrictMode exists to surface, but here the singleton
// platform makes the second mount genuinely wrong, not a bug indicator.
async function boot() {
  const persistence = createIdbPersistence()
  const [saved, seededBefore] = await Promise.all([
    persistence.load().catch(() => null),
    loadSeedFlag().catch(() => false),
  ])
  const vfs = createVfs(saved ?? undefined)
  // Seed only a truly fresh workspace — migrateStarter writes dotfiles into
  // old workspaces, and running it first on a fresh VFS made the workspace
  // non-empty, silently suppressing the starter project. A null image with
  // the tombstone set is a deliberate full wipe: leave it empty instead of
  // resurrecting the starter (P0-9).
  if (saved) {
    migrateStarter(vfs)
    ensureStarterProject(vfs)
  } else if (!seededBefore) {
    seedStarterProject(vfs)
  }
  void saveSeedFlag().catch(() => {})
  // installed dependencies live in IndexedDB now — ask Chrome not to evict
  // them under storage pressure (granted silently in most cases)
  void navigator.storage?.persist?.().catch(() => {})
  // the preview service worker registers at boot so it is ACTIVE long before
  // the first `cell preview` — a lazily-registered one raced its first build
  // into the srcdoc fallback (and router apps warned 'No routes matched')
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    void navigator.serviceWorker.register('/cell-preview-sw.js').catch(() => {})
  }
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
  startAutoSave(vfs, persistence, 400, {
    onError: (message) => bus.emit('app:status', { message, tone: 'error' }),
  })
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
  root.render(
    <Theme theme={cellTheme} mode="dark">
      <App />
    </Theme>,
  )

  bus.emit('diagnostics:updated', { diagnostics: [], version: 0 })
  startLanguageService()
  bus.emit('app:ready', {})
}

void boot()
