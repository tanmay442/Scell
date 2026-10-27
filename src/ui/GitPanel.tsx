import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleAlert, FilePlus, FilePenLine, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { platform } from '../platform'
import { findGitRepos, gitCommand } from '../shell/commands/git'
import type { Vfs } from '../vfs/types'
import { getActivePath, workspaceActions } from './workspace-store'

interface Change {
  path: string
  label: string
}

interface RepoState {
  root: string
  branch: string | null
  changes: Change[]
  commits: { sha: string; message: string }[]
}

type PanelState = { kind: 'loading' } | { kind: 'none' } | ({ kind: 'repo' } & RepoState)

const HOME = '/home/user'

async function runGit(args: string[], cwd: string) {
  const { vfs } = platform()
  return gitCommand(vfs, args, { cwd })
}

/** Repos are discovered, never assumed: every .git in the VFS is a repo root. */
function pickRepo(repos: string[]): string | null {
  if (repos.length === 0) return null
  const active = getActivePath()
  const containing = active !== null ? repos.filter((root) => active === root || active.startsWith(`${root}/`)) : []
  if (containing.length > 0) return containing.sort((a, b) => b.length - a.length)[0]
  return repos[0]
}

/** The branch is read from the repo's real HEAD file — exactly what git does. */
function readBranch(vfs: Vfs, root: string): string | null {
  const head = vfs.read(`${root}/.git/HEAD`)
  if (head === null) return null
  const match = /^ref: refs\/heads\/(.+)$/.exec(head.trim())
  if (match) return match[1]
  const sha = head.trim()
  return sha.length >= 7 ? `${sha.slice(0, 7)} (detached)` : null
}

function parseStatus(stdout: string): Change[] {
  const changes: Change[] = []
  const seen = new Set<string>()
  const pattern = /^(new file|modified|deleted|renamed|typechange|added):\s*(.+)$/
  for (const rawLine of stdout.split('\n')) {
    // lg2/git status prefixes status lines with '#' + indent
    const line = rawLine.replace(/^[#\s]+/, '')
    const match = pattern.exec(line)
    if (match) {
      let path = match[2].trim()
      path = path.replace(/^"|"$/g, '').split(' -> ').pop() ?? path
      if (!seen.has(path)) {
        seen.add(path)
        changes.push({ path, label: match[1] })
      }
    }
  }
  return changes
}

function parseLog(stdout: string): { sha: string; message: string }[] {
  const commits: { sha: string; message: string }[] = []
  let current: { sha: string; message: string } | null = null
  for (const line of stdout.split('\n')) {
    const shaMatch = /^commit ([0-9a-f]{7,40})/.exec(line)
    if (shaMatch) {
      if (current) commits.push(current)
      current = { sha: shaMatch[1].slice(0, 7), message: '' }
    } else if (current && /^ {4}\S/.test(line) && !current.message) {
      current.message = line.trim()
    }
  }
  if (current) commits.push(current)
  return commits.slice(0, 12)
}

function displayPath(path: string): string {
  return path === HOME ? '~' : path.replace(new RegExp(`^${HOME}/`), '~/')
}

function expandTilde(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return HOME
  if (trimmed.startsWith('~/')) return `${HOME}${trimmed.slice(1)}`
  return trimmed.startsWith('/') ? trimmed : `${HOME}/${trimmed}`
}

/**
 * Source Control view: repo status, staged/unstaged changes, commit box and
 * recent history — backed by the same libgit2 WASM bridge the shell uses,
 * over repositories discovered in the VFS (no hardcoded paths anywhere).
 */
export function GitPanel() {
  const { vfs, bus } = platform()
  const [vfsVersion, setVfsVersion] = useState(0)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
  const [initPath, setInitPath] = useState('~')
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return bus.on('vfs:changed', () => setVfsVersion((v) => v + 1))
  }, [bus])

  const repos = useMemo(() => findGitRepos(vfs), [vfs, vfsVersion])
  const root = selectedRoot !== null && repos.includes(selectedRoot) ? selectedRoot : pickRepo(repos)

  const refresh = useCallback(async () => {
    if (root === null) {
      setState({ kind: 'none' })
      return
    }
    setState((prev) => (prev.kind === 'repo' && prev.root === root ? prev : { kind: 'loading' }))
    const [status, log] = await Promise.all([runGit(['status'], root), runGit(['log'], root)])
    setState({
      kind: 'repo',
      root,
      branch: readBranch(vfs, root),
      changes: parseStatus(status.stdout),
      commits: parseLog(log.stdout),
    })
  }, [root, vfs])

  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = bus.on('vfs:changed', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 700)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [bus, refresh])

  const initRepo = async () => {
    if (busy) return
    setBusy(true)
    try {
      const target = expandTilde(initPath)
      const result = await runGit(['init'], target)
      if (result.exitCode === 0) {
        vfs.mkdir(target)
        setSelectedRoot(target)
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commitAll = async () => {
    if (state.kind !== 'repo' || !message.trim() || busy) return
    setBusy(true)
    try {
      await runGit(['add', '.'], state.root)
      const result = await runGit(['commit', '-m', message.trim()], state.root)
      if (result.exitCode === 0) setMessage('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') {
    return <div className="git-panel-empty">loading repository…</div>
  }

  if (state.kind === 'none') {
    return (
      <div className="git-panel-empty">
        No repository in the workspace yet.
        <div className="git-init-row">
          <input
            className="git-init-path"
            value={initPath}
            spellCheck={false}
            placeholder="~"
            onChange={(e) => setInitPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void initRepo()
            }}
          />
          <button className="git-init-btn" onClick={() => void initRepo()} disabled={busy || !initPath.trim()}>
            <FilePlus size={13} /> git init
          </button>
        </div>
        <span className="git-hint">
          Or clone one in the terminal: <code>git clone &lt;url&gt;</code> — it lands in the filesystem like any
          other directory.
        </span>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="sidebar-header">
        <span>SOURCE CONTROL</span>
        <span className="sidebar-actions">
          <button title="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </span>
      </div>
      <div className="git-meta">
        {state.branch ? <span className="git-branch">{state.branch}</span> : null}
        {repos.length > 1 ? (
          <select className="git-repo-select" value={state.root} onChange={(e) => setSelectedRoot(e.target.value)}>
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {displayPath(repo)}
              </option>
            ))}
          </select>
        ) : (
          <span className="git-root">{displayPath(state.root)}</span>
        )}
      </div>
      <div className="git-commit-box">
        <textarea
          className="git-message"
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={message}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void commitAll()
            }
          }}
        />
        <button className="git-commit-btn" onClick={() => void commitAll()} disabled={busy || !message.trim()}>
          <GitCommitHorizontal size={14} /> Commit (add all)
        </button>
      </div>
      <div className="git-section">CHANGES ({state.changes.length})</div>
      {state.changes.length === 0 ? (
        <div className="git-panel-empty">working tree clean</div>
      ) : (
        state.changes.map((change) => (
          <button
            key={change.path}
            className="tree-row is-file git-change"
            onClick={() => workspaceActions.openFile(`${state.root}/${change.path}`.replace('//', '/'))}
            title={`${change.label} — ${change.path}`}
          >
            {change.label === 'new file' || change.label === 'added' ? (
              <FilePlus size={13} className="problem-ok" />
            ) : (
              <FilePenLine size={13} className="problem-warning" />
            )}
            <span className="tree-file-name">{change.path}</span>
            <span className="git-change-label">{change.label}</span>
          </button>
        ))
      )}
      <div className="git-section">HISTORY</div>
      {state.commits.length === 0 ? (
        <div className="git-panel-empty">no commits yet</div>
      ) : (
        state.commits.map((commit) => (
          <div key={commit.sha} className="git-commit-row">
            <span className="git-sha">{commit.sha}</span>
            <span className="git-msg">{commit.message || <CircleAlert size={11} />}</span>
          </div>
        ))
      )}
    </div>
  )
}
