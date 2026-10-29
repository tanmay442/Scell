import { useEffect, useState, useSyncExternalStore } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { VStack, HStack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  LinkIcon,
  RocketLaunchIcon,
  DocumentMagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { platform } from '../platform'
import { agentStore } from './agent-store'
import { getActivePath } from './workspace-store'
import { findGitRepos, gitCommand } from '../shell/commands/git'
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

interface DockData {
  jobsRunning: number
  jobsDone: number
  repoName: string | null
  branch: string | null
  changedFiles: string[]
}

const EMPTY: DockData = { jobsRunning: 0, jobsDone: 0, repoName: null, branch: null, changedFiles: [] }

async function pollDock(): Promise<DockData> {
  const { vfs } = platform()
  let jobsRunning = 0
  let jobsDone = 0
  try {
    const dir = '/home/user/.cell/jobs'
    if (vfs.isDir(dir)) {
      for (const name of vfs.readDir(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(vfs.read(`${dir}/${name}`) ?? '{}') as { status?: string }
          if (parsed.status === 'running') jobsRunning++
          else jobsDone++
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  let repoName: string | null = null
  let branch: string | null = null
  let changedFiles: string[] = []
  try {
    const repos = findGitRepos(vfs)
    const active = getActivePath() ?? '/home/user/project'
    const root = repos.find((repo) => active === repo || active.startsWith(`${repo}/`)) ?? repos[0] ?? null
    if (root !== null) {
      repoName = vfsPath.basename(root)
      const head = vfs.read(`${root}/.git/HEAD`) ?? ''
      branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length).trim() : null
      const status = await gitCommand(vfs, ['status'], { cwd: root })
      changedFiles = status.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('On branch') && !line.startsWith('Your branch'))
        .slice(0, 20)
    }
  } catch { /* git is best-effort here */ }
  return { jobsRunning, jobsDone, repoName, branch, changedFiles }
}

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
  }, [agent.running, agent.entries.length])

  const lastTool = [...agent.entries].reverse().find((entry) => entry.kind === 'tool')
  const agentLabel = agent.pendingSummary !== null
    ? 'waiting for approval'
    : agent.running
      ? (lastTool ? lastTool.text.slice(0, 42) : 'working…')
      : 'idle'

  if (!open) {
    return (
      <div style={pillStyle}>
        <Button
          label={agent.running ? 'Agent running' : 'Status'}
          variant="secondary"
          size="sm"
          icon={<StatusDot variant={agent.running ? 'accent' : 'neutral'} label={agentLabel} />}
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
            <StatusDot variant={agent.running ? 'accent' : 'neutral'} label={agentLabel} />
            <Text type="supporting" color="secondary">{agentLabel}</Text>
          </HStack>
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
          <HStack gap={2} vAlign="center">
            <LinkIcon width={14} />
            <Text type="supporting" color="secondary">No connectors yet</Text>
            <ChevronRightIcon width={12} />
          </HStack>
        </VStack>
      </Card>
    </div>
  )
}
