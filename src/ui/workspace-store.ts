import { useSyncExternalStore } from 'react'
import { platform } from '../platform'

export interface WorkspaceSnapshot {
  openPaths: readonly string[]
  activePath: string | null
  dirty: ReadonlySet<string>
  /** bumped when a tab's content is discarded, forcing an editor remount */
  resetTokens: ReadonlyMap<string, number>
  reveal: { path: string; line: number; token: number } | null
  version: number
}

interface WorkspaceState {
  openPaths: string[]
  activePath: string | null
  drafts: Map<string, string>
  resetTokens: Map<string, number>
  reveal: { path: string; line: number; token: number } | null
  version: number
}

const state: WorkspaceState = {
  openPaths: [],
  activePath: null,
  drafts: new Map(),
  resetTokens: new Map(),
  reveal: null,
  version: 0,
}

const subscribers = new Set<() => void>()

// useSyncExternalStore requires getSnapshot to be referentially stable
// between mutations — the snapshot is rebuilt only inside commit().
let cached: WorkspaceSnapshot | null = null

function isDirty(path: string): boolean {
  const draft = state.drafts.get(path)
  if (draft === undefined) return false
  return draft !== platform().vfs.read(path)
}

function rebuild(): WorkspaceSnapshot {
  cached = {
    openPaths: state.openPaths,
    activePath: state.activePath,
    dirty: new Set([...state.drafts.keys()].filter(isDirty)),
    resetTokens: state.resetTokens,
    reveal: state.reveal,
    version: state.version,
  }
  return cached
}

function commit(mutate: () => void) {
  mutate()
  state.version++
  rebuild()
  for (const notify of subscribers) notify()
}

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify)
      return () => subscribers.delete(notify)
    },
    () => cached ?? rebuild(),
  )
}

/** Non-hook read for the keymap and other imperative code paths. */
export function getActivePath(): string | null {
  return state.activePath
}

export const workspaceActions = {
  openFile(path: string, line?: number) {
    commit(() => {
      if (!state.openPaths.includes(path)) state.openPaths.push(path)
      state.activePath = path
      if (line !== undefined) {
        state.reveal = { path, line, token: state.version + 1 }
      }
    })
  },

  setActive(path: string) {
    if (state.activePath === path) return
    commit(() => {
      state.activePath = path
    })
  },

  closeTab(path: string) {
    commit(() => {
      const idx = state.openPaths.indexOf(path)
      if (idx === -1) return
      state.openPaths.splice(idx, 1)
      if (state.activePath === path) {
        state.activePath = state.openPaths[Math.min(idx, state.openPaths.length - 1)] ?? null
      }
      state.drafts.delete(path)
    })
  },

  draft(path: string): string | undefined {
    return state.drafts.get(path)
  },

  setDraft(path: string, content: string) {
    commit(() => {
      state.drafts.set(path, content)
    })
  },

  save(path: string) {
    const draft = state.drafts.get(path)
    if (draft === undefined) return
    if (draft === platform().vfs.read(path)) {
      state.drafts.delete(path)
      commit(() => {})
      return
    }
    platform().vfs.write(path, draft)
    commit(() => {
      state.drafts.delete(path)
    })
  },

  saveActive() {
    if (state.activePath) workspaceActions.save(state.activePath)
  },

  discard(path: string) {
    commit(() => {
      state.drafts.delete(path)
      state.resetTokens.set(path, (state.resetTokens.get(path) ?? 0) + 1)
    })
  },

  /** VFS deleted a path — close any tabs at or under it. */
  handleVfsDelete(path: string) {
    commit(() => {
      const affected = state.openPaths.filter((p) => p === path || p.startsWith(`${path}/`))
      for (const p of affected) {
        state.openPaths.splice(state.openPaths.indexOf(p), 1)
        state.drafts.delete(p)
      }
      if (state.activePath && !state.openPaths.includes(state.activePath)) {
        state.activePath = state.openPaths[state.openPaths.length - 1] ?? null
      }
    })
  },

  /** VFS renamed a path — retab old paths to their new names. */
  handleVfsRename(from: string, to: string) {
    commit(() => {
      for (let i = 0; i < state.openPaths.length; i++) {
        const p = state.openPaths[i]
        if (p === from) state.openPaths[i] = to
        else if (p.startsWith(`${from}/`)) state.openPaths[i] = `${to}${p.slice(from.length)}`
      }
      const draft = state.drafts.get(from)
      if (draft !== undefined) {
        state.drafts.delete(from)
        state.drafts.set(to, draft)
      }
      if (state.activePath === from) state.activePath = to
    })
  },

  consumeReveal() {
    if (!state.reveal) return
    commit(() => {
      state.reveal = null
    })
  },
}
