import { useEffect, useState, useSyncExternalStore } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { VStack, HStack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import {
  ChevronDownIcon,
  FolderOpenIcon,
  LinkIcon,
  RocketLaunchIcon,
  DocumentMagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { platform } from '../platform'
import { agentActions, agentStore } from './agent-store'
import { getActivePath } from './workspace-store'
import { findGitRepos, gitCommand } from '../shell/commands/git'
import { parseStatus } from './GitPanel'
import { agentStore as _agentStoreRef } from './agent-store'
import { vfsPath } from '../vfs/types'
import type { CSSProperties } from 'react'

const dockStyle: CSSProperties = {
  position: 'fixed',
  right: 14,
  top: 64,
  width: 252,
  zIndex: 60,
  opacity: 0.92,
}
const pillStyle: CSSProperties = {
  position: 'fixed',
  right: 14,
  top: 64,
  zIndex: 60,
  opacity: 0.92,
}

interface ServerStatus {
  /** configured server URL, or '' when unset */
  url: string
  reachable: boolean
  telegram: boolean
  threads: number
  busyThreads: number
  workers: number
  /** newest server thread, for the "latest work" line */
  latest: string | null
}

interface DockData {
  jobsRunning: number
  jobsDone: number
  repoName: string | null
  branch: string | null
  changedFiles: string[]
  server: ServerStatus | null
}

const EMPTY: DockData = { jobsRunning: 0, jobsDone: 0, repoName: null, branch: null, changedFiles: [], server: null }

async function pollDock(): Promise<DockData> {
  const { vfs } = platform()
  const agentBusy = _agentStoreRef.get().runningIds.length > 0
  // headless server + connectors (best-effort, cached on failure): the
  // dock is the always-visible indicator — sidebar has the full browser
  let server: ServerStatus | null = lastServer
  try {
    const { serverUrl, fetchServerHealth, fetchServerThreads } = await import('./server-threads')
    const url = serverUrl()
    if (url === '') {
      server = null
    } else {
      const [health, threads] = await Promise.all([fetchServerHealth(), fetchServerThreads()])
      if ('error' in health || 'error' in threads) {
        server = { url, reachable: false, telegram: lastServer?.telegram ?? false, threads: 0, busyThreads: 0, workers: 0, latest: lastServer?.latest ?? null }
      } else {
        const busy = threads.threads.filter((t) => t.busy)
        server = {
          url,
          reachable: true,
          telegram: health.telegram,
          threads: threads.threads.length,
          busyThreads: busy.length,
          workers: threads.threads.filter((t) => t.kind === 'worker').length,
          latest: threads.threads.length > 0 ? (threads.threads.map((t) => t.title ?? t.threadId).join(' · ').slice(0, 80)) : null,
        }
      }
    }
  } catch {
    // keep last known server state; the dock must never wedge the UI
  }
  lastServer = server
  let jobsRunning = 0
  let jobsDone = 0
  try {
    const dir = '/home/user/.cell/jobs'
    if (vfs.isDir(dir)) {
      for (const name of vfs.readDir(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(vfs.read(`${dir}/${name}`) ?? '{}') as { status?: string; startedAt?: number }
          // a crashed tab leaves 'running' behind forever; only the
          // last hour counts as live, older is history
          const fresh = parsed.startedAt !== undefined && Date.now() - parsed.startedAt < 3_600_000
          if (parsed.status === 'running' && fresh) jobsRunning++
          else if (parsed.status === 'done') jobsDone++
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  let repoName: string | null = null
  let branch: string | null = null
  let changedFiles: string[] = []
  if (agentBusy) {
    // do not mirror the VFS into MEMFS mid-run; keep last git snapshot
    return { jobsRunning, jobsDone, server, ...lastGit }
  }
  try {
    const repos = findGitRepos(vfs)
    const active = getActivePath() ?? '/home/user/project'
    const root = repos.find((repo) => active === repo || active.startsWith(`${repo}/`)) ?? repos[0] ?? null
    if (root !== null) {
      repoName = vfsPath.basename(root)
      const head = vfs.read(`${root}/.git/HEAD`) ?? ''
      branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length).trim() : null
      const status = await gitCommand(vfs, ['status'], { cwd: root })
      changedFiles = parseStatus(status.stdout).map((change) => change.path).slice(0, 20)
    }
  } catch { /* git is best-effort here */ }
  lastGit = { repoName, branch, changedFiles }
  return { jobsRunning, jobsDone, server, repoName, branch, changedFiles }
}

let lastServer: ServerStatus | null = null

let lastGit: Pick<DockData, 'repoName' | 'branch' | 'changedFiles'> = { repoName: null, branch: null, changedFiles: [] }

/**
 * Persistent right-side status dock (both modes): what the agent is
 * doing, background jobs, reviewable changes (only when any), the
 * workspace, and connector state. Collapses to a small pill.
 */
export function StatusDock({ onOpenWorkspace }: { onOpenWorkspace?: () => void }) {
  const agent = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const [open, setOpen] = useState(true)
  const [data, setData] = useState<DockData>(EMPTY)

  useEffect(() => {
    let alive = true
    const tick = () => {
      void pollDock().then((next) => {
        if (alive) setData(next)
      })
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // re-poll when a run starts/ends; entry pushes do not re-arm it
  }, [agent.running])

  const lastTool = [...agent.entries].reverse().find((entry) => entry.kind === 'tool')
  const runningCount = agent.runningIds.length
  const agentLabel = agent.pendingGlobal !== null
    ? 'waiting for approval'
    : runningCount > 0
      ? (runningCount > 1 ? `working in ${runningCount} threads` : (lastTool ? lastTool.text.slice(0, 42) : 'working…'))
      : 'idle'

  if (!open) {
    return (
      <div style={pillStyle}>
        <Button
          label={runningCount > 0 ? 'Agent running' : 'Status'}
          variant="secondary"
          size="sm"
          icon={<StatusDot variant={runningCount > 0 ? 'accent' : 'neutral'} label={agentLabel} />}
          onClick={() => setOpen(true)}
        />
      </div>
    )
  }

  return (
    <div style={dockStyle}>
      <Card variant="muted" padding={3}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <RocketLaunchIcon width={14} />
            <Text type="label" weight="semibold">Agent</Text>
            <span style={{ flex: 1 }} />
            <Button label="Collapse status" variant="ghost" size="sm" isIconOnly icon={<ChevronDownIcon width={14} />} onClick={() => setOpen(false)} />
          </HStack>
          <HStack gap={2} vAlign="center">
            <StatusDot variant={runningCount > 0 ? 'accent' : 'neutral'} label={agentLabel} />
            <Text type="supporting" color="secondary">{agentLabel}</Text>
          </HStack>
          {agent.pendingGlobal !== null ? (
            <>
              <Text type="supporting" color="secondary">
                {agent.pendingGlobal.summary.slice(0, 120)}
              </Text>
              <HStack gap={2}>
                <Button label="Approve" variant="primary" size="sm" onClick={() => agentActions.decideFor(agent.pendingGlobal!.threadId, true)} />
                <Button label="Deny" variant="ghost" size="sm" onClick={() => agentActions.decideFor(agent.pendingGlobal!.threadId, false)} />
              </HStack>
            </>
          ) : null}
          {data.jobsRunning + data.jobsDone > 0 ? (
            <Text type="supporting" color="secondary">
              Jobs: {data.jobsRunning} running · {data.jobsDone} done
            </Text>
          ) : null}

          {data.changedFiles.length > 0 ? (
            <>
              <HStack gap={2} vAlign="center">
                <DocumentMagnifyingGlassIcon width={14} />
                <Text type="label" weight="semibold">Review</Text>
              </HStack>
              <Text type="supporting" color="secondary">
                {data.changedFiles.length} changed file{data.changedFiles.length === 1 ? '' : 's'} in {data.repoName}
              </Text>
              {data.changedFiles.slice(0, 4).map((file) => (
                <Text key={file} type="supporting" color="secondary" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11 }}>{file}</Text>
              ))}
              {onOpenWorkspace ? <Button label="Open in Workspace" variant="ghost" size="sm" icon={<FolderOpenIcon width={14} />} onClick={onOpenWorkspace} /> : null}
            </>
          ) : null}

          <HStack gap={2} vAlign="center">
            <FolderOpenIcon width={14} />
            <Text type="supporting" color="secondary">
              {data.repoName ?? 'workspace'}{data.branch ? ` · ${data.branch}` : ''}
            </Text>
          </HStack>
          {data.server !== null ? (
            <HStack gap={2} vAlign="center">
              <StatusDot variant={data.server.reachable ? 'accent' : 'neutral'} label={data.server.reachable ? 'server up' : 'server down'} />
              <Text type="supporting" color="secondary">
                {(() => { try { const u = new URL(data.server!.url); return `${u.host}` } catch { return data.server!.url } })()}
                {data.server.reachable ? ` · ${data.server.threads} thread${data.server.threads === 1 ? '' : 's'}${data.server.busyThreads > 0 ? ` (${data.server.busyThreads} busy)` : ''}` : ' · unreachable'}
              </Text>
            </HStack>
          ) : null}
          <HStack gap={2} vAlign="center">
            <LinkIcon width={14} />
            <Text type="supporting" color="secondary">
              {data.server !== null && data.server.reachable && data.server.telegram ? 'Telegram live' : data.server !== null && data.server.reachable ? 'No connectors yet' : 'Connectors — see sidebar'}
            </Text>
          </HStack>
          {data.server !== null && data.server.reachable && (data.server.workers > 0 || data.server.latest !== null) ? (
            <Text type="supporting" color="secondary">
              Latest: {data.server.workers > 0 ? `${data.server.workers} worker${data.server.workers === 1 ? '' : 's'} · ` : ''}{data.server.latest ?? '—'}
            </Text>
          ) : null}
        </VStack>
      </Card>
    </div>
  )
}
