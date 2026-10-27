import { getActivePath, workspaceActions } from './workspace-store'

export interface KeyboardHooks {
  togglePanel(): void
}

/**
 * Global keymap. The editor does not swallow these — CodeMirror leaves
 * Mod-S unbound and the browser event still fires from inside it.
 */
export function attachGlobalKeys(hooks: KeyboardHooks): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      workspaceActions.saveActive()
    } else if (mod && !e.altKey && e.key === '`') {
      e.preventDefault()
      hooks.togglePanel()
    } else if (mod && e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault()
      const active = getActivePath()
      if (active) workspaceActions.closeTab(active)
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
