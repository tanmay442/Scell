import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSyncExternalStore } from 'react'
import { AppShell } from '@astryxdesign/core/AppShell'
import { Divider } from '@astryxdesign/core/Divider'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Layout, LayoutContent } from '@astryxdesign/core/Layout'
import { Stack, VStack, HStack, StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
} from '@astryxdesign/core/Chat'
import { Markdown } from '@astryxdesign/core/Markdown'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Card } from '@astryxdesign/core/Card'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { MoreMenu } from '@astryxdesign/core/MoreMenu'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { HoverCard } from '@astryxdesign/core/HoverCard'
import {
  MicrophoneIcon,
  PaperClipIcon,
  PlusIcon,
  ChatBubbleLeftRightIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  SparklesIcon,
  LinkIcon,
  WrenchScrewdriverIcon,
  ClockIcon,
  CheckIcon,
  XMarkIcon,
  PencilIcon,
  BookmarkIcon,
  LockClosedIcon,
  LockOpenIcon,
  ShareIcon,
  ArchiveBoxIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  PhotoIcon,
  DocumentTextIcon,
  DocumentIcon,
  ArrowsPointingOutIcon,
} from '@heroicons/react/24/outline'
import { agentActions, agentStore, COMPACT_AT_CHARS, threadWorkspace, type AgentConfigForm, type ChatEntry, type SessionInfo } from './agent-store'
import { fetchServerThreads, fetchThreadDetail, discoverTelegramChats, setServerToken as setServerTokenValue, setServerUrl, serverToken, serverUrl, telegramServerCommand, testTelegramToken, type ServerThread, type ServerThreadDetail } from './server-threads'
import { platform } from '../platform'
import { groupItems, splitHtmlBlocks } from './agent-entries'
import { splitFileRefs, fileKind } from './agent-files'
import { workspaceActions } from './workspace-store'
import { Logo } from './Logo'
import SlicedWaves from './SlicedWaves'

const SUGGESTIONS: { title: string; detail: string; prompt: string }[] = [
  { title: 'Explain it visually', detail: 'A hard topic, made obvious with a diagram', prompt: 'Explain how a transformer neural network works like I am a smart 15-year-old, with one simple visual in the chat.' },
  { title: 'Plan my week', detail: 'Priorities, schedule, and a visual plan', prompt: 'Help me plan a productive week: ask me what I have on, then build a day-by-day plan and show it as a visual.' },
  { title: 'Chart some data', detail: 'Python analysis, rendered in the thread', prompt: 'Generate an interesting dataset with python (e.g. simulated coffee shop sales for a year), analyze it, and show the key chart as a visual in this chat.' },
  { title: 'Fix the build', detail: 'Run the checks, find what fails, fix it', prompt: 'Run the project checks (typecheck/tests) in the current project, fix what fails, and verify.' },
]

const runningDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: '#3FA37A',
  flexShrink: 0,
}

const interruptedDot: CSSProperties = { ...runningDot, background: '#E0A458' }

const CONTENT_WIDTH = 800
const fill: CSSProperties = { height: '100%', minHeight: 0 }
const heroWrap: CSSProperties = { position: 'relative', height: '100%', overflow: 'hidden' }
const wavesLayer: CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%', opacity: 0.5, pointerEvents: 'none' }
const heroContent: CSSProperties = {
  position: 'relative',
  height: '100%',
  justifyContent: 'center',
  maxWidth: CONTENT_WIDTH,
  marginInline: 'auto',
  width: '100%',
  padding: '24px',
}
const resultBox: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--mono, monospace)',
  fontSize: 'var(--font-size-sm, 12px)',
  lineHeight: 1.55,
  maxHeight: 120,
  overflowY: 'auto',
  opacity: 0.85,
}
const approvalPre: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono, monospace)', fontSize: 'var(--font-size-sm, 12px)' }

const visualFrame: CSSProperties = {
  width: '100%',
  border: 'none',
  background: 'transparent',
  display: 'block',
}

function HtmlVisual({ path, html }: { path?: string; html?: string }) {
  const content = html ?? (path !== undefined ? (platform().vfs.read(path) ?? '') : '')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(200)

  // Height comes from the parent side: the frame runs same-origin
  // (allow-same-origin) so the parent measures the child body directly
  // on load, on a short settle schedule, and on child resizes. Frame ->
  // parent postMessage height reporting proved unreliable here (the
  // reporter's load-time measurement races layout inside scrollable,
  // remounting message lists), so it stays only as a fallback below.
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    let observer: ResizeObserver | null = null
    const timers: ReturnType<typeof setTimeout>[] = []
    const measure = () => {
      try {
        const doc = frame.contentDocument
        if (doc?.body) {
          const measured = Math.max(doc.body.offsetHeight, doc.body.scrollHeight)
          if (measured > 0) setHeight(Math.min(2400, Math.ceil(measured)))
        }
      } catch { /* cross-origin during navigation — next tick retries */ }
    }
    const onLoad = () => {
      measure()
      timers.push(setTimeout(measure, 250), setTimeout(measure, 900))
      try {
        const doc = frame.contentDocument
        if (doc?.body && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure)
          observer.observe(doc.body)
          observer.observe(doc.documentElement)
        }
      } catch { /* measurement stays on the settle schedule */ }
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      const reported = (event.data as { __cellVisualHeight?: unknown })?.__cellVisualHeight
      if (typeof reported === 'number' && reported > 0) setHeight(Math.min(2400, Math.ceil(reported)))
    }
    frame.addEventListener('load', onLoad)
    window.addEventListener('message', onMessage)
    return () => {
      frame.removeEventListener('load', onLoad)
      window.removeEventListener('message', onMessage)
      observer?.disconnect()
      timers.forEach(clearTimeout)
    }
  }, [content])

  if (content === '') return null
  // T3-style theme bridge: the frame is transparent over the chat, the
  // document gets the chat's palette as CSS variables, scrollbars are
  // hidden, and the document reports its own height (see reporter).
  const baseStyle = '<style>:root{color-scheme:dark;--bg:transparent;--fg:#ECECEC;--muted:#AFAFAF;--accent:#3FA37A;--chart-1:#3FA37A;--chart-2:#E0A458;--chart-3:#7AA2E0;--chart-4:#D97AB0;--chart-5:#9BC53D}html,body{background:transparent!important;margin:0;padding:0;height:auto!important;min-height:0!important;color:#ECECEC;font-family:system-ui,sans-serif;scrollbar-width:none}body>*{background:transparent!important;box-shadow:none!important}::-webkit-scrollbar{width:0;height:0}</style>'
  // measure the BODY, not the document element: an iframe's
  // documentElement.scrollHeight is floored at the viewport height,
  // so short visuals would never shrink below the initial height.
  // color-scheme:dark (above) is what stops Chrome painting a white
  // canvas under the transparent document on http pages.
  const reporter = '<script>function __cellMeasure(){var b=document.body;return b?Math.max(b.offsetHeight,b.scrollHeight):0}function __cellReport(){try{parent.postMessage({__cellVisualHeight:__cellMeasure()},"*")}catch(e){}}window.addEventListener("load",function(){__cellReport();setTimeout(__cellReport,300);setTimeout(__cellReport,1200)});if(window.ResizeObserver){new ResizeObserver(__cellReport).observe(document.documentElement);if(document.body)new ResizeObserver(__cellReport).observe(document.body)}</' + '<' + '/script>'
  const withBase = content.includes('<head>')
    ? content.replace('<head>', `<head>${baseStyle}`)
    : content.includes('<html')
      ? content.replace(/<html[^>]*>/, (tag) => `${tag}${baseStyle}`)
      : `${baseStyle}${content}`
  const srcDoc = withBase.includes('</body>') ? withBase.replace('</body>', `${reporter}</body>`) : `${withBase}${reporter}`
  return (
    <iframe ref={frameRef} title={path ?? 'visual'} sandbox="allow-scripts allow-same-origin" srcDoc={srcDoc} style={{ ...visualFrame, height }} />
  )
}

/** Split assistant text into markdown and ```html fenced parts. */
function orderedSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => !s.archived).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true))
}

function archivedSessions<T extends { archived?: boolean }>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => s.archived)
}

function shareSession(id: string, label: string): void {
  const markdown = agentActions.sessionMarkdown(id)
  if (markdown === '') return
  const blob = new Blob([markdown], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${label.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60) || id}.md`
  anchor.click()
  URL.revokeObjectURL(url)
}



const walkCache = new Map<string, { at: number; files: string[] }>()

/** Resolve a path the agent mentioned to a real file, or null. */
function makeFileResolver(workspace: string | null): (candidate: string) => string | null {
  const { vfs } = platform()
  return (candidate: string) => {
    if (candidate.startsWith('~/')) {
      const absolute = `/home/user${candidate.slice(1)}`
      return vfs.isFile(absolute) ? absolute : null
    }
    if (candidate.startsWith('/')) return vfs.isFile(candidate) ? candidate : null
    if (workspace === null) return null
    if (candidate.includes('/')) {
      const absolute = `${workspace}/${candidate}`
      return vfs.isFile(absolute) ? absolute : null
    }
    // bare filename: search the thread workspace (cached walk, 5s TTL)
    const now = Date.now()
    let cached = walkCache.get(workspace)
    if (cached === undefined || now - cached.at > 5000) {
      const files: string[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > 4 || files.length > 400) return
        let names: string[] = []
        try { names = vfs.readDir(dir) } catch { return }
        for (const name of names) {
          if (name === 'node_modules' || name === '.git') continue
          const child = `${dir}/${name}`
          if (vfs.isDir(child)) walk(child, depth + 1)
          else files.push(child)
        }
      }
      walk(workspace, 0)
      cached = { at: now, files }
      walkCache.set(workspace, cached)
      // bounded: one entry per workspace visited, evict oldest first
      while (walkCache.size > 50) {
        const oldest = walkCache.keys().next()
        if (oldest.done === true) break
        walkCache.delete(oldest.value)
      }
    }
    return cached.files.find((filePath) => filePath.endsWith(`/${candidate}`)) ?? null
  }
}

function FileChip({ path, label, onPreview }: { path: string; label: string; onPreview: (path: string) => void }) {
  const kind = fileKind(path)
  const Icon = kind === 'image' ? PhotoIcon : kind === 'text' ? DocumentTextIcon : kind === 'html' ? CodeBracketIcon : DocumentIcon
  return (
    <HStack gap={1}>
      <Button label={label} variant="ghost" size="sm" icon={<Icon width={14} />} onClick={() => onPreview(path)} />
    </HStack>
  )
}

const previewScroll: CSSProperties = { maxHeight: '60vh', overflowY: 'auto', width: '100%' }
const previewPre: CSSProperties = { ...previewScroll, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono, monospace)', fontSize: 'var(--font-size-sm, 12px)', margin: 0 }

function FilePreviewDialog({ path, onClose, onOpenWorkspace }: { path: string | null; onClose: () => void; onOpenWorkspace: () => void }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  useEffect(() => {
    if (path === null || fileKind(path) !== 'image') {
      setImageUrl(null)
      return
    }
    const bytes = platform().vfs.readBytes(path)
    if (bytes === null) {
      setImageUrl(null)
      return
    }
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [path])

  if (path === null) return null
  const { vfs } = platform()
  const kind = fileKind(path)
  const exists = vfs.isFile(path)
  const text = kind === 'text' && exists ? (vfs.read(path) ?? '') : ''
  const canOpenInWorkspace = exists && (kind === 'text' || kind === 'html')
  const download = () => {
    const bytes = vfs.readBytes(path)
    if (bytes === null) return
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = path.split('/').pop() ?? 'file'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose() }} purpose="form" width={860} padding={4}>
      <VStack gap={3}>
        <VStack gap={0.5}>
          <Text type="label" weight="semibold">{path.split('/').pop()}</Text>
          <Text type="supporting" color="secondary" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11 }}>{path}</Text>
        </VStack>
        {!exists ? (
          <Text type="body" color="secondary">This file no longer exists.</Text>
        ) : kind === 'image' ? (
          imageUrl !== null
            ? <img src={imageUrl} alt={path} style={{ maxWidth: '100%', maxHeight: '62vh', objectFit: 'contain', alignSelf: 'flex-start' }} />
            : <Text type="body" color="secondary">Could not read this image.</Text>
        ) : kind === 'html' ? (
          <Stack style={previewScroll}><HtmlVisual path={path} /></Stack>
        ) : kind === 'text' ? (
          path.endsWith('.md') || path.endsWith('.markdown')
            ? <Stack style={previewScroll}><Markdown>{text.slice(0, 30_000)}</Markdown></Stack>
            : <pre style={previewPre}>{text.slice(0, 30_000)}</pre>
        ) : (
          <Text type="body" color="secondary">No inline preview for this file type — download it or open it in the Workspace.</Text>
        )}
        <HStack gap={2}>
          {canOpenInWorkspace ? (
            <Button
              label="Open in Workspace"
              variant="primary"
              size="sm"
              onClick={() => {
                workspaceActions.openFile(path)
                onOpenWorkspace()
              }}
            />
          ) : null}
          {exists ? <Button label="Download" variant="ghost" size="sm" onClick={download} /> : null}
          <Button label="Close" variant="ghost" size="sm" onClick={onClose} />
        </HStack>
      </VStack>
    </Dialog>
  )
}

const Transcript = memo(function Transcript({ entries, running, workspace, onPreview }: { entries: readonly ChatEntry[]; running: boolean; workspace: string | null; onPreview: (path: string) => void }) {
  const resolveFile = makeFileResolver(workspace)
  const items = groupItems(entries)
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'tools') {
          return (
            <ChatMessage key={item.id} sender="assistant">
              <ChatToolCalls
                calls={item.entries.map((entry) => {
                  const space = entry.text.indexOf(' ')
                  return {
                    name: entry.name ?? (space === -1 ? entry.text : entry.text.slice(0, space)),
                    target: space === -1 ? '' : entry.text.slice(space + 1),
                    status: entry.status ?? 'complete',
                    ...(entry.resultText ? { resultDetail: <Stack style={resultBox}>{entry.resultText}</Stack> } : {}),
                  }
                })}
              />
            </ChatMessage>
          )
        }
        const entry = item.entry
        if (entry.kind === 'user') {
          return (
            <ChatMessage key={entry.id} sender="user">
              <ChatMessageBubble>{entry.text}</ChatMessageBubble>
            </ChatMessage>
          )
        }
        if (entry.kind === 'result') {
          return (
            <ChatMessage key={entry.id} sender="assistant">
              <ChatMessageBubble variant="ghost" width="100%">
                <Stack style={resultBox}>{entry.text}</Stack>
              </ChatMessageBubble>
            </ChatMessage>
          )
        }
        if (entry.kind === 'note') {
          return <ChatSystemMessage key={entry.id}>{entry.text}</ChatSystemMessage>
        }
        if (entry.kind === 'visual') {
          return (
            <ChatMessage key={entry.id} sender="assistant">
              <Stack style={{ position: 'relative', width: '100%' }}>
                <HtmlVisual path={entry.text} />
                <span style={{ position: 'absolute', top: 2, right: 2 }}>
                  <Button label="Expand visual" variant="ghost" size="sm" isIconOnly icon={<ArrowsPointingOutIcon width={13} />} onClick={() => onPreview(entry.text)} />
                </span>
              </Stack>
            </ChatMessage>
          )
        }
        return (
          <ChatMessage key={entry.id} sender="assistant">
            <VStack gap={2}>
              {splitHtmlBlocks(entry.text).flatMap((part, partIndex) =>
                part.kind === 'html'
                  ? [<HtmlVisual key={`${partIndex}-html`} html={part.text} />]
                  : splitFileRefs(part.text, resolveFile).map((ref, refIndex) =>
                      ref.kind === 'file' ? (
                        <FileChip key={`${partIndex}-${refIndex}`} path={ref.path} label={ref.label} onPreview={onPreview} />
                      ) : ref.text.trim() === '' ? null : (
                        <ChatMessageBubble key={`${partIndex}-${refIndex}`} variant="ghost">
                          <Markdown density="compact">{ref.text}</Markdown>
                        </ChatMessageBubble>
                      ),
                    ),
              )}
            </VStack>
          </ChatMessage>
        )
      })}
      {running ? <ChatSystemMessage>Working…</ChatSystemMessage> : null}
    </>
  )
})

function ServerThreadsSection({ onOpenThread }: { onOpenThread: (thread: ServerThread) => void }) {
  const [url, setUrl] = useState(serverUrl())
  const [threads, setThreads] = useState<ServerThread[] | null>(null)
  const [status, setStatus] = useState('Not connected — set the server URL, then refresh.')
  const refresh = async () => {
    setServerUrl(url)
    setStatus('Connecting…')
    const out = await fetchServerThreads()
    if ('error' in out) {
      setThreads(null)
      setStatus(`Could not reach the server: ${out.error}`)
      return
    }
    setThreads(out.threads)
    setStatus(out.threads.length === 0 ? 'Connected — no server threads yet.' : `Connected — ${out.threads.length} thread(s).`)
  }
  const kindLabel = (kind: ServerThread['kind']) => kind === 'telegram' ? 'Telegram' : kind === 'worker' ? 'Worker' : 'Run'
  return (
    <SideNavSection title="On the server">
      <VStack gap={1.5}>
        <TextInput label="Server URL" value={url} onChange={setUrl} placeholder="http://localhost:8787" />
        <Button label="Refresh" variant="ghost" size="sm" onClick={refresh} />
        <Text type="supporting" color="secondary">{status}</Text>
        {(threads ?? []).map((thread) => (
          <SideNavItem
            key={thread.threadId}
            label={`${kindLabel(thread.kind)} · ${thread.title ?? thread.threadId}`}
            icon={ChatBubbleLeftRightIcon}
            size="sm"
            onClick={() => onOpenThread(thread)}
          />
        ))}
      </VStack>
    </SideNavSection>
  )
}

function ServerThreadDialog({ thread, onClose }: { thread: ServerThread; onClose: () => void }) {
  const [detail, setDetail] = useState<ServerThreadDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const out = await fetchThreadDetail(thread.threadId)
      if (cancelled) return
      if ('error' in out) setError(out.error)
      else setDetail(out.detail)
    })()
    return () => { cancelled = true }
  }, [thread.threadId])
  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose() }} purpose="form" width={720} padding={4}>
      <DialogHeader title={detail?.title ?? thread.threadId} subtitle={`${thread.kind} thread · ${thread.messages} message(s)${thread.busy ? ' · running' : ''}`} />
      <VStack gap={2}>
        {error !== null ? <Text type="body" color="secondary">Could not load: {error}</Text> : null}
        {detail === null && error === null ? <Text type="body" color="secondary">Loading…</Text> : null}
        {(detail?.files ?? []).length > 0 ? (
          <VStack gap={1}>
            <Text type="label" weight="semibold">Files in this thread</Text>
            {(detail?.files ?? []).map((file) => (
              <Text key={file.name} type="supporting">{file.name} · {Math.max(1, Math.round(file.size / 1024))} KB</Text>
            ))}
          </VStack>
        ) : null}
        <VStack gap={1}>
          <Text type="label" weight="semibold">Transcript (newest first)</Text>
          {(detail?.transcript ?? []).slice(0, 60).map((line, i) => (
            <Text key={i} type="supporting" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line.slice(0, 600)}</Text>
          ))}
        </VStack>
        <Text type="supporting" color="secondary">Read-only here — continue the conversation in Telegram (same thread), or resume it headless with --resume {detail?.sessionId ?? thread.threadId}.</Text>
      </VStack>
    </Dialog>
  )
}

function ConnectorsDialog({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('')
  const [allowFrom, setAllowFrom] = useState('')
  const [serverUrlValue, setServerUrlValue] = useState(serverUrl())
  const [serverTokenDraft, setServerTokenDraft] = useState(serverToken())
  const [testResult, setTestResult] = useState<string | null>(null)
  const [chats, setChats] = useState<Array<{ id: number; kind: string; text: string }> | null>(null)
  const [chatsNote, setChatsNote] = useState<string | null>(null)
  const test = async () => {
    setTestResult('Checking…')
    const out = await testTelegramToken(token)
    setTestResult('username' in out ? `Token works — bot @${out.username}` : `Failed: ${out.error}`)
  }
  const discover = async () => {
    setChatsNote('Reading recent updates… (message the bot first, then click again)')
    const out = await discoverTelegramChats(token)
    if ('error' in out) {
      setChatsNote(`Failed: ${out.error}`)
      setChats(null)
      return
    }
    setChats(out.chats)
    setChatsNote(out.chats.length === 0 ? 'No messages seen yet — send the bot anything, then click again.' : 'Pick your chat id for the allowlist:')
  }
  const save = () => {
    setServerUrl(serverUrlValue)
    setServerTokenValue(serverTokenDraft)
    onClose()
  }
  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose() }} purpose="form" width={640} padding={4}>
      <DialogHeader title="Connectors" subtitle="Telegram — the same bot on a second surface" />
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="label" weight="semibold">1 · Bot token (from BotFather)</Text>
          <TextInput label="Bot token" value={token} onChange={setToken} placeholder="123456:AAH…" />
          <HStack gap={2}>
            <Button label="Test token" variant="ghost" size="sm" onClick={test} />
            {testResult !== null ? <Text type="supporting" color="secondary">{testResult}</Text> : null}
          </HStack>
          <Text type="supporting" color="secondary">The token stays in this dialog and the server env — it is never written to the workspace or committed.</Text>
        </VStack>
        <VStack gap={1}>
          <Text type="label" weight="semibold">2 · Your chat id (allowlist)</Text>
          <TextInput label="Chat id" value={allowFrom} onChange={setAllowFrom} placeholder="6520414687" />
          <HStack gap={2}>
            <Button label="Discover chats" variant="ghost" size="sm" onClick={discover} />
          </HStack>
          {chatsNote !== null ? <Text type="supporting" color="secondary">{chatsNote}</Text> : null}
          {(chats ?? []).map((chat) => (
            <HStack key={chat.id} gap={2} vAlign="center">
              <Text type="supporting">{chat.id} · {chat.kind} · {chat.text}</Text>
              <Button label="Use" variant="ghost" size="sm" onClick={() => setAllowFrom(String(chat.id))} />
            </HStack>
          ))}
        </VStack>
        <VStack gap={1}>
          <Text type="label" weight="semibold">3 · Start the server</Text>
          <Text type="supporting" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{telegramServerCommand('./workspace', 8787, token, allowFrom)}</Text>
          <Text type="supporting" color="secondary">Run that where the server lives (token via env, allowlist baked in). Prefer a token file outside the workspace for long-lived deploys — see README.</Text>
        </VStack>
        <VStack gap={1}>
          <Text type="label" weight="semibold">4 · This panel reads the server</Text>
          <TextInput label="Server URL" value={serverUrlValue} onChange={setServerUrlValue} placeholder="http://localhost:8787" />
          <TextInput label="Server API token (CELL_API_TOKENS)" value={serverTokenDraft} onChange={setServerTokenDraft} placeholder="empty when auth is off" />
          <HStack gap={2}>
            <Button label="Save & close" variant="primary" size="sm" onClick={save} />
            <Button label="Cancel" variant="ghost" size="sm" onClick={onClose} />
          </HStack>
        </VStack>
      </VStack>
    </Dialog>
  )
}

function ContextRing({ chars }: { chars: number }) {
  const state = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const ratio = Math.min(1, chars / COMPACT_AT_CHARS)
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const usedTokens = Math.round(chars / 4)
  const totalTokens = Math.round(COMPACT_AT_CHARS / 4)
  const pct = Math.round(ratio * 100)
  const formatK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
  return (
    <HoverCard
      placement="above"
      content={
        <VStack gap={2} style={{ width: 264, padding: 6 }}>
          <HStack gap={2} vAlign="center">
            <Text type="label" weight="semibold">Context Window</Text>
            <span style={{ flex: 1 }} />
            <Text type="supporting" color="secondary">{pct}% · {formatK(usedTokens)}/{formatK(totalTokens)}</Text>
          </HStack>
          <ProgressBar label="Context used" isLabelHidden value={chars} max={COMPACT_AT_CHARS} />
          <Text type="supporting" color="secondary">
            Context for {state.config.model || state.config.provider} compacts automatically when needed.
          </Text>
          <Button
            label="Compact context"
            variant="secondary"
            size="sm"
            isDisabled={!state.running || chars === 0}
            onClick={() => agentActions.requestCompact()}
          />
          {!state.running ? <Text type="supporting" color="secondary">Compacting happens during a run.</Text> : null}
        </VStack>
      }>
      <span style={{ display: 'inline-flex', cursor: 'pointer' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="Context usage">
          <circle cx="12" cy="12" r={radius} fill="none" stroke="#2A2A2A" strokeWidth="2.5" />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="#35805F"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform="rotate(-90 12 12)"
          />
        </svg>
      </span>
    </HoverCard>
  )
}

function VoiceButton() {
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  // never leave the mic hot when the composer unmounts (mode switch,
  // hero->chat remount): stop recognition and drop its handlers
  useEffect(() => () => {
    try { recognitionRef.current?.stop() } catch { /* already stopped */ }
    recognitionRef.current = null
  }, [])
  const supported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  const toggle = () => {
    if (!supported) return
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition
    if (!Ctor) return
    const recognition = new Ctor() as unknown as {
      lang: string
      interimResults: boolean
      continuous: boolean
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null
      onend: (() => void) | null
      onerror: (() => void) | null
      start: () => void
      stop: () => void
    }
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join(' ').trim()
      if (transcript !== '') agentActions.appendDraft(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  return (
    <Button
      label={listening ? 'Stop voice input' : 'Voice input'}
      variant="ghost"
      size="sm"
      isIconOnly
      isDisabled={!supported}
      icon={<MicrophoneIcon width={16} style={listening ? { color: '#E5534B' } : undefined} />}
      onClick={toggle}
    />
  )
}

const MODEL_PRESETS: { provider: string; model: string; label: string }[] = [
  { provider: 'meta', model: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor' },
  { provider: 'meta', model: 'muse-spark-1.3', label: 'Muse Spark 1.3' },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' },
]
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

function AgentComposer({ onOpenSettings }: { onOpenSettings: () => void }) {
  const state = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const wasRunning = useRef(false)
  useEffect(() => {
    // keep the keyboard where the conversation is: after the first
    // send (hero remounts into the chat) and when a run ends
    if (wasRunning.current !== state.running || state.entries.length <= 1) {
      wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
    }
    wasRunning.current = state.running
  }, [state.running, state.entries.length])
  const form = state.config
  const needsKey = !state.keyAvailable && form.provider !== 'compat'
  const modelLabel = MODEL_PRESETS.find((preset) => preset.provider === form.provider && preset.model === form.model)?.label ?? (form.model || form.provider)

  /** Binary files (images etc.) cannot ride in the text draft: they are
   * staged as bytes and land in the thread workspace on send, with their
   * paths appended to the prompt. Text files keep the inline treatment. */
  const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tiff']
  const attachFiles = async (files: FileList | null) => {
    if (files === null) return
    for (const file of [...files]) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      const isImage = file.type.startsWith('image/') || IMAGE_EXTENSIONS.includes(ext)
      if (isImage) {
        if (file.size > 25_000_000) {
          agentActions.appendDraft(`[file: ${file.name} — too large to attach (${Math.round(file.size / 1024 / 1024)} MB, 25 MB max)]`)
          continue
        }
        try {
          agentActions.stageUpload(file.name, new Uint8Array(await file.arrayBuffer()))
        } catch {
          agentActions.appendDraft(`[file: ${file.name} — could not read]`)}
        continue
      }
      if (file.size > 200_000) {
        agentActions.appendDraft(`[file: ${file.name} — too large to attach (${Math.round(file.size / 1024)} KB)]`)
        continue
      }
      try {
        const text = await file.slice(0, 64_000).text()
        const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (truncated)` : text
        agentActions.setDraft(`${agentStore.get().draft}\n\n[file: ${file.name}]\n\`\`\`\n${clipped}\n\`\`\``)
      } catch {
        agentActions.appendDraft(`[file: ${file.name} — could not read as text]`)
      }
    }
  }

  return (
    <div ref={wrapRef}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          void attachFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <ChatComposer
        density="compact"
        value={state.draft}
        onChange={(value) => agentActions.setDraft(value)}
        onSubmit={(value) => void agentActions.run(value)}
        isStopShown={state.running}
        onStop={() => agentActions.stop()}
        placeholder="Ask anything. / commands work here"
        input={<ChatComposerInput style={{ minHeight: 56 }} />}
        isDisabled={state.activeLocked}
        status={
          state.activeLocked
            ? { type: 'warning', message: 'This chat is locked. Unlock it from the session menu to continue.' }
            : needsKey && !state.running
              ? { type: 'error', message: 'No API key configured — open Model settings in the sidebar to add one.' }
              : undefined
        }
        sendActions={
          <HStack gap={1} vAlign="center">
            <Button
              label="Attach files"
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<PaperClipIcon width={16} />}
              onClick={() => fileInputRef.current?.click()}
            />
            <VoiceButton />
            <ContextRing chars={state.contextChars} />
          </HStack>
        }
        footerActions={
          <HStack gap={1} vAlign="center" wrap="wrap">
            <DropdownMenu
              button={{ label: modelLabel, variant: 'ghost', size: 'sm', icon: <Logo size={14} /> }}
              items={[
                ...MODEL_PRESETS.map((preset) => ({
                  label: preset.label,
                  onClick: () => {
                    agentActions.setConfig({ provider: preset.provider, model: preset.model })
                    agentActions.saveConfig()
                  },
                })),
                { type: 'divider' as const },
                { label: 'Custom endpoint…', onClick: onOpenSettings },
              ]}
            />
            <DropdownMenu
              button={{ label: `Effort ${form.thinking}`, variant: 'ghost', size: 'sm' }}
              items={EFFORTS.map((effort) => ({
                label: effort === 'off' ? 'Off' : effort[0].toUpperCase() + effort.slice(1),
                onClick: () => {
                  agentActions.setConfig({ thinking: effort })
                  agentActions.saveConfig()
                },
              }))}
            />
            <DropdownMenu
              button={{ label: form.permission === 'full' ? 'Full access' : 'Ask first', variant: 'ghost', size: 'sm' }}
              items={[
                { label: 'Full access', onClick: () => { agentActions.setConfig({ permission: 'full' }); agentActions.saveConfig() } },
                { label: 'Ask first', onClick: () => { agentActions.setConfig({ permission: 'ask' }); agentActions.saveConfig() } },
              ]}
            />
          </HStack>
        }
      />
    </div>
  )
}

/**
 * Agent home (the product's front door): Astryx shell with SideNav
 * (sessions, skills, tools, settings), the conversation in the main
 * column, and a waves-lit empty state. The code IDE lives behind
 * "Workspace" — every editor feature intact, just not the front door.
 */
export function AgentHome({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const state = useSyncExternalStore(agentStore.subscribe, agentStore.get)
  const [storageLine, setStorageLine] = useState('Storage: checking…')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AgentConfigForm | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [serverThread, setServerThread] = useState<ServerThread | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)
  const form = state.config

  useEffect(() => {
    agentActions.refresh()
    agentActions.reopenLast()
    agentActions.ensureTitles()
  }, [])

  const openSettings = () => {
    setSettingsDraft({ ...state.config })
    setSettingsOpen(true)
    // storage health: is this browser keeping the workspace for good?
    void (async () => {
      try {
        const storage = navigator.storage
        if (!storage) {
          setStorageLine('Storage: browser API unavailable')
          return
        }
        const [persisted, estimate] = await Promise.all([
          storage.persisted ? storage.persisted() : Promise.resolve(false),
          storage.estimate ? storage.estimate() : Promise.resolve(null),
        ])
        const used = estimate?.usage !== undefined ? `${Math.max(1, Math.round(estimate.usage / 1_048_576))} MB used` : 'size unknown'
        setStorageLine(persisted
          ? `Storage: persistent — ${used}. Files, threads and settings auto-save here after every change.`
          : `Storage: best-effort — ${used}. The browser may evict this workspace under disk pressure; export backups with cell save.`)
      } catch {
        setStorageLine('Storage: status unavailable')
      }
    })()
  }

  const isEmpty = state.entries.length === 0
  const composer = (
    <Stack style={{ maxWidth: CONTENT_WIDTH, marginInline: 'auto', width: '100%', padding: '0 16px 14px', opacity: 0.94 }}>
      <AgentComposer onOpenSettings={openSettings} />
    </Stack>
  )

  return (
    <AppShell
      contentPadding={0}
      sideNav={
        <SideNav
          collapsible
          resizable={{ defaultWidth: 252, minWidth: 208, maxWidth: 360 }}
          header={<SideNavHeading heading="Cell" subheading="agent on V8" icon={<Logo size={22} />} />}
          footer={
            <VStack gap={1}>
              <SideNavSection title="Capabilities" isHeaderHidden>
                <SideNavItem label="Skills" icon={SparklesIcon} size="sm" collapsible={{ defaultIsCollapsed: true }}>
                  <VStack gap={0.5}>
                    {state.skills.map((skill) => (
                      <SideNavItem
                        key={skill.name}
                        label={skill.name}
                        size="sm"
                        onClick={() => agentActions.appendDraft(`Use the ${skill.name} skill to `)}
                      />
                    ))}
                  </VStack>
                </SideNavItem>
                <SideNavItem label="Tools" icon={WrenchScrewdriverIcon} size="sm" collapsible={{ defaultIsCollapsed: true }}>
                  <VStack gap={0.5}>
                    {state.tools.map((tool) => (
                      <SideNavItem key={tool} label={tool} size="sm" />
                    ))}
                  </VStack>
                </SideNavItem>
              </SideNavSection>
              <Divider />
              <SideNavSection title="System" isHeaderHidden>
                <SideNavItem label="Model settings" icon={Cog6ToothIcon} size="sm" onClick={openSettings} />
              </SideNavSection>
            </VStack>
          }>
          <SideNavSection title="Main" isHeaderHidden>
            <SideNavItem label="New chat" icon={PlusIcon} size="sm" onClick={() => agentActions.clearChat()} />
            <SideNavItem label="Agent" icon={ChatBubbleLeftRightIcon} size="sm" isSelected />
            <SideNavItem label="Workspace" icon={CodeBracketIcon} size="sm" onClick={onOpenWorkspace} />
            <SideNavItem label="Connectors" icon={LinkIcon} size="sm" onClick={() => setConnectorsOpen(true)} />
          </SideNavSection>

          <SideNavSection title="Sessions">
            <VStack gap={1.5}>
            {orderedSessions(state.sessions).map((session) => (
              <SideNavItem
                key={session.id}
                label={session.label}
                icon={session.pinned ? BookmarkIcon : ClockIcon}
                size="sm"
                isSelected={state.sessionId === session.id}
                {...(state.runningIds.includes(session.id) ? { endContent: <span style={runningDot} /> } : session.interrupted ? { endContent: <span style={interruptedDot} /> } : {})}
                onClick={() => agentActions.openSession(session.id)}
                actions={
                  <MoreMenu
                    label={`Options for ${session.label}`}
                    size="sm"
                    items={[
                      { label: 'Rename', icon: PencilIcon, onClick: () => setRenameTarget({ id: session.id, value: session.title ?? '' }) },
                      { label: session.pinned ? 'Unpin' : 'Pin', icon: BookmarkIcon, onClick: () => agentActions.togglePin(session.id) },
                      { label: session.locked ? 'Unlock chat' : 'Lock chat', icon: session.locked ? LockOpenIcon : LockClosedIcon, onClick: () => agentActions.toggleLock(session.id) },
                      { label: 'Share', icon: ShareIcon, onClick: () => shareSession(session.id, session.label) },
                      { label: 'Fork', icon: DocumentDuplicateIcon, onClick: () => { const forkId = agentActions.forkSession(session.id); if (forkId !== null) agentActions.openSession(forkId) } },
                      { type: 'divider' as const },
                      { label: session.archived ? 'Unarchive' : 'Archive', icon: ArchiveBoxIcon, onClick: () => agentActions.toggleArchive(session.id) },
                      { label: 'Delete', icon: TrashIcon, onClick: () => setDeleteTarget({ id: session.id, label: session.label }) },
                    ]}
                  />
                }
              />
            ))}
            {state.sessions.length === 0 ? (
              <Text type="supporting" color="secondary">No sessions yet</Text>
            ) : null}
            </VStack>
          </SideNavSection>

          <ServerThreadsSection onOpenThread={setServerThread} />

          {archivedSessions(state.sessions).length > 0 ? (
            <SideNavSection title="Archived" isHeaderHidden>
              <SideNavItem label={`Archived (${archivedSessions(state.sessions).length})`} icon={ArchiveBoxIcon} size="sm" collapsible={{ defaultIsCollapsed: true }}>
                <VStack gap={1.5}>
                  {archivedSessions(state.sessions).map((session) => (
                    <SideNavItem
                      key={session.id}
                      label={session.label}
                      size="sm"
                      isSelected={state.sessionId === session.id}
                      {...(state.runningIds.includes(session.id) ? { endContent: <span style={runningDot} /> } : session.interrupted ? { endContent: <span style={interruptedDot} /> } : {})}
                      onClick={() => agentActions.openSession(session.id)}
                      actions={
                        <MoreMenu
                          label={`Options for ${session.label}`}
                          size="sm"
                          items={[
                            { label: 'Unarchive', icon: ArchiveBoxIcon, onClick: () => agentActions.toggleArchive(session.id) },
                            { label: 'Delete', icon: TrashIcon, onClick: () => setDeleteTarget({ id: session.id, label: session.label }) },
                          ]}
                        />
                      }
                    />
                  ))}
                </VStack>
              </SideNavItem>
            </SideNavSection>
          ) : null}

        </SideNav>
      }>
      <Layout
        height="fill"
        content={
          <LayoutContent padding={0}>
            {isEmpty ? (
              <Stack style={heroWrap}>
                <div style={wavesLayer} aria-hidden="true">
                  <SlicedWaves ribbons={3} spacing={30} perspective={0.45} blur={0.6} glow={0.9} position={0.72} fade={0.35} mouseInteraction={false} />
                </div>
                <VStack gap={4} style={heroContent}>
                  <VStack gap={2}>
                    <Logo size={52} />
                    <Text type="display-2" as="h1">What should the agent do?</Text>
                    <Text type="body" color="secondary">
                      Ask anything — it answers directly, and when work needs doing it has bash, files, git, python and a live preview, all in its own workspace.
                    </Text>
                  </VStack>
                  {composer}
                  <HStack gap={2} wrap="wrap" style={{ width: '100%', opacity: 0.85 }}>
                    {SUGGESTIONS.map((suggestion) => (
                      <StackItem key={suggestion.title} style={{ flexBasis: '46%', minWidth: 'min(240px, 100%)', flexGrow: 1 }}>
                        <ClickableCard label={suggestion.title} variant="muted" padding={2} onClick={() => agentActions.setDraft(suggestion.prompt)}>
                          <VStack gap={1}>
                            <Text type="label" weight="semibold">{suggestion.title}</Text>
                            <Text type="supporting" color="secondary">{suggestion.detail}</Text>
                          </VStack>
                        </ClickableCard>
                      </StackItem>
                    ))}
                  </HStack>
                </VStack>
              </Stack>
            ) : (
              <ChatLayout density="compact" style={fill} composer={composer}>
                <ChatMessageList isStreaming={state.running}>
                  <Stack style={{ maxWidth: CONTENT_WIDTH, marginInline: 'auto', width: '100%', minWidth: 0, padding: '8px 16px 0' }}>
                    <Transcript entries={state.entries} running={state.running} workspace={state.sessionId !== null ? threadWorkspace(state.sessionId) : null} onPreview={setPreviewPath} />
                  </Stack>
                  {state.pendingSummary !== null ? (
                    <Stack style={{ maxWidth: CONTENT_WIDTH, marginInline: 'auto', width: '100%', padding: '0 16px' }}>
                    <ChatMessage sender="assistant">
                      <Card variant="muted" padding={3} maxWidth={560}>
                        <VStack gap={2}>
                          <Text type="label" weight="semibold">
                            Approve this tool call?{state.pendingCount > 1 ? ` (${state.pendingCount} waiting)` : ''}
                          </Text>
                          <Text type="supporting" style={approvalPre}>{state.pendingSummary}</Text>
                          <Text type="supporting" color="secondary">Auto-denies after 5 minutes without an answer.</Text>
                          <HStack gap={2}>
                            <Button label="Approve" variant="primary" size="sm" icon={<CheckIcon width={14} />} onClick={() => agentActions.decide(true)} />
                            <Button label="Deny" variant="ghost" size="sm" icon={<XMarkIcon width={14} />} onClick={() => agentActions.decide(false)} />
                          </HStack>
                        </VStack>
                      </Card>
                    </ChatMessage>
                    </Stack>
                  ) : null}
                </ChatMessageList>
              </ChatLayout>
            )}
          </LayoutContent>
        }
      />

      <Dialog isOpen={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null) }} purpose="form" width={420} padding={4}>
        {renameTarget !== null ? (
          <VStack gap={3}>
            <Text type="label" weight="semibold">Rename session</Text>
            <TextInput label="Title" value={renameTarget.value} onChange={(value) => setRenameTarget({ ...renameTarget, value })} />
            <HStack gap={2}>
              <Button
                label="Save"
                variant="primary"
                onClick={() => {
                  agentActions.renameSession(renameTarget.id, renameTarget.value)
                  setRenameTarget(null)
                }}
              />
              <Button label="Cancel" variant="ghost" onClick={() => setRenameTarget(null)} />
            </HStack>
          </VStack>
        ) : null}
      </Dialog>

      <FilePreviewDialog path={previewPath} onClose={() => setPreviewPath(null)} onOpenWorkspace={onOpenWorkspace} />
      {connectorsOpen ? <ConnectorsDialog onClose={() => setConnectorsOpen(false)} /> : null}
      {serverThread !== null ? <ServerThreadDialog thread={serverThread} onClose={() => setServerThread(null)} /> : null}

      <Dialog isOpen={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }} purpose="form" width={420} padding={4}>
        {deleteTarget !== null ? (
          <VStack gap={3}>
            <Text type="label" weight="semibold">Delete “{deleteTarget.label}”?</Text>
            <Text type="supporting" color="secondary">The session file is removed. This cannot be undone.</Text>
            <HStack gap={2}>
              <Button
                label="Delete"
                variant="destructive"
                onClick={() => {
                  agentActions.deleteSession(deleteTarget.id)
                  setDeleteTarget(null)
                }}
              />
              <Button label="Cancel" variant="ghost" onClick={() => setDeleteTarget(null)} />
            </HStack>
          </VStack>
        ) : null}
      </Dialog>

      <Dialog isOpen={settingsOpen} onOpenChange={setSettingsOpen} purpose="form" width={520}>
        <Layout
          header={<DialogHeader title="Model & settings" subtitle="Saved to ~/.cell/agent.json" hasDivider onOpenChange={setSettingsOpen} />}
          content={
            <LayoutContent padding={4}>
              {settingsDraft !== null ? (
                <VStack gap={3}>
                  <Selector
                    label="Provider"
                    value={settingsDraft.provider}
                    onChange={(value) => setSettingsDraft({ ...settingsDraft, provider: value })}
                    options={[
                      { value: 'meta', label: 'Meta (Muse Spark)' },
                      { value: 'anthropic', label: 'Anthropic' },
                      { value: 'openai', label: 'OpenAI' },
                      { value: 'compat', label: 'OpenAI-compatible (baseURL)' },
                    ]}
                  />
                  <TextInput label="Model" value={settingsDraft.model} onChange={(value) => setSettingsDraft({ ...settingsDraft, model: value })} />
                  {settingsDraft.provider === 'compat' ? (
                    <TextInput label="Base URL" value={settingsDraft.baseURL} onChange={(value) => setSettingsDraft({ ...settingsDraft, baseURL: value })} />
                  ) : null}
                  <TextInput label="API key" type="password" value={settingsDraft.apiKey} onChange={(value) => setSettingsDraft({ ...settingsDraft, apiKey: value })} description={settingsDraft.provider === 'meta' ? 'Required in the browser — there is no host auth file here.' : undefined} />
                  <Selector
                    label="Reasoning effort (meta)"
                    value={settingsDraft.thinking}
                    onChange={(value) => setSettingsDraft({ ...settingsDraft, thinking: value })}
                    options={EFFORTS.map((effort) => ({ value: effort, label: effort === 'off' ? 'Off' : effort[0].toUpperCase() + effort.slice(1) }))}
                  />
                  <Selector
                    label="Permission"
                    value={settingsDraft.permission}
                    onChange={(value) => setSettingsDraft({ ...settingsDraft, permission: value })}
                    options={[
                      { value: 'full', label: 'Full permissions — tools run without asking' },
                      { value: 'ask', label: 'Ask before each tool call' },
                    ]}
                  />
                  <Text type="supporting" color="secondary">{storageLine}</Text>
                  <HStack gap={2}>
                    <Button
                      label="Save config"
                      variant="primary"
                      onClick={() => {
                        agentActions.setConfig(settingsDraft)
                        agentActions.saveConfig()
                        setSettingsOpen(false)
                      }}
                    />
                    <Button label="Cancel" variant="ghost" onClick={() => setSettingsOpen(false)} />
                  </HStack>
                </VStack>
              ) : null}
            </LayoutContent>
          }
        />
      </Dialog>
    </AppShell>
  )
}
