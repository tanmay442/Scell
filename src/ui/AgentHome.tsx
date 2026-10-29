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
} from '@heroicons/react/24/outline'
import { agentActions, agentStore, COMPACT_AT_CHARS, type AgentConfigForm, type ChatEntry, type SessionInfo } from './agent-store'
import { platform } from '../platform'
import { Logo } from './Logo'
import SlicedWaves from './SlicedWaves'

const SUGGESTIONS: { title: string; detail: string; prompt: string }[] = [
  { title: 'Fix the build', detail: 'Run the checks, find what fails, fix it', prompt: 'Run the project checks (typecheck/tests) in ~/project, fix what fails, and verify.' },
  { title: 'Make a chart', detail: 'Python + matplotlib into ~/artifacts', prompt: 'Look at the data files in ~/project, pick the most interesting one, and save a matplotlib chart of it to ~/artifacts.' },
  { title: 'Build a page', detail: 'A small web app, verified with the preview', prompt: 'Create a small useful web page in ~/project, then verify it with cell preview and report any bundler errors.' },
  { title: 'Explain this workspace', detail: 'What is here and what can be built', prompt: 'Explore this workspace and tell me what is here, what state it is in, and what could be built or fixed next.' },
]

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

/** Fold result entries into their tool entry (adjacent, same call). */
function mergeToolResults(entries: readonly ChatEntry[]): ChatEntry[] {
  const out: (ChatEntry & { resultText?: string })[] = []
  for (const entry of entries) {
    const prev = out[out.length - 1]
    if (entry.kind === 'result' && prev?.kind === 'tool') {
      out[out.length - 1] = { ...prev, resultText: entry.text }
      continue
    }
    out.push(entry)
  }
  return out
}

type DisplayItem =
  | { kind: 'single'; entry: ChatEntry & { resultText?: string } }
  | { kind: 'tools'; id: number; entries: (ChatEntry & { resultText?: string })[] }

function groupItems(entries: readonly ChatEntry[]): DisplayItem[] {
  const merged = mergeToolResults(entries)
  const items: DisplayItem[] = []
  for (const entry of merged) {
    const last = items[items.length - 1]
    if (entry.kind === 'tool' && last?.kind === 'tools') {
      last.entries.push(entry)
      continue
    }
    if (entry.kind === 'tool') {
      items.push({ kind: 'tools', id: entry.id, entries: [entry] })
      continue
    }
    items.push({ kind: 'single', entry })
  }
  return items
}

const visualFrame: CSSProperties = {
  width: '100%',
  border: 'none',
  background: 'transparent',
  display: 'block',
}

/**
 * Interactive HTML visual, embedded so it reads as part of the thread:
 * no border, no card background, and the frame grows to the content
 * height (the chat scrolls; the visual never scrolls internally).
 * Sandboxed to scripts only — the content reports its height back
 * through postMessage, verified against the frame's own window.
 */
function HtmlVisual({ path, html }: { path?: string; html?: string }) {
  const content = html ?? (path !== undefined ? (platform().vfs.read(path) ?? '') : '')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(200)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const reported = (event.data as { __cellVisualHeight?: unknown })?.__cellVisualHeight
      if (typeof reported === 'number' && reported > 0) setHeight(Math.min(2400, Math.ceil(reported)))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (content === '') return null
  const baseStyle = '<style>html,body{background:transparent!important;margin:0;padding:0;color:#ECECEC;font-family:system-ui,sans-serif}::-webkit-scrollbar{width:0;height:0}</style>'
  const reporter = '<script>function __cellReport(){try{parent.postMessage({__cellVisualHeight:document.documentElement.scrollHeight},"*")}catch(e){}}window.addEventListener("load",__cellReport);if(window.ResizeObserver){new ResizeObserver(__cellReport).observe(document.documentElement)}</' + '<' + '/script>'
  const withBase = content.includes('<head>')
    ? content.replace('<head>', `<head>${baseStyle}`)
    : content.includes('<html')
      ? content.replace(/<html[^>]*>/, (tag) => `${tag}${baseStyle}`)
      : `${baseStyle}${content}`
  const srcDoc = withBase.includes('</body>') ? withBase.replace('</body>', `${reporter}</body>`) : `${withBase}${reporter}`
  return (
    <Stack style={{ width: '100%' }}>
      {path !== undefined ? (
        <Text type="supporting" color="secondary" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11 }}>{path}</Text>
      ) : null}
      <iframe ref={frameRef} title={path ?? 'visual'} sandbox="allow-scripts" srcDoc={srcDoc} style={{ ...visualFrame, height }} />
    </Stack>
  )
}

/** Split assistant text into markdown and ```html fenced parts. */
function splitHtmlBlocks(text: string): { kind: 'md' | 'html'; text: string }[] {
  const parts: { kind: 'md' | 'html'; text: string }[] = []
  const fence = /```html\s*\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) parts.push({ kind: 'md', text: text.slice(last, match.index) })
    parts.push({ kind: 'html', text: match[1] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'md', text: text.slice(last) })
  return parts.length > 0 ? parts : [{ kind: 'md', text }]
}

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

const Transcript = memo(function Transcript({ entries, running }: { entries: readonly ChatEntry[]; running: boolean }) {
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
              <HtmlVisual path={entry.text} />
            </ChatMessage>
          )
        }
        return (
          <ChatMessage key={entry.id} sender="assistant">
            {splitHtmlBlocks(entry.text).map((part, partIndex) =>
              part.kind === 'html' ? (
                <HtmlVisual key={partIndex} html={part.text} />
              ) : (
                <ChatMessageBubble key={partIndex} variant="ghost">
                  <Markdown density="compact">{part.text}</Markdown>
                </ChatMessageBubble>
              ),
            )}
          </ChatMessage>
        )
      })}
      {running ? <ChatSystemMessage>Working…</ChatSystemMessage> : null}
    </>
  )
})

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
  const form = state.config
  const needsKey = form.apiKey.trim() === '' && form.provider !== 'compat'
  const modelLabel = MODEL_PRESETS.find((preset) => preset.provider === form.provider && preset.model === form.model)?.label ?? (form.model || form.provider)

  const attachFiles = async (files: FileList | null) => {
    if (files === null) return
    for (const file of [...files]) {
      try {
        const text = await file.text()
        const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (truncated)` : text
        agentActions.setDraft(`${agentStore.get().draft}\n\n[file: ${file.name}]\n\`\`\`\n${clipped}\n\`\`\``)
      } catch {
        agentActions.appendDraft(`[file: ${file.name} — could not read as text]`)
      }
    }
  }

  return (
    <>
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
        placeholder="Ask anything. @ files, $ skills, / commands"
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
    </>
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AgentConfigForm | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null)
  const form = state.config

  useEffect(() => {
    agentActions.refresh()
    agentActions.ensureTitles()
  }, [])

  const openSettings = () => {
    setSettingsDraft({ ...state.config })
    setSettingsOpen(true)
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
            <SideNavItem label="Connectors (soon)" icon={LinkIcon} size="sm" isDisabled />
          </SideNavSection>

          <SideNavSection title="Sessions">
            <VStack gap={1.5}>
            {orderedSessions(state.sessions).map((session) => (
              <SideNavItem
                key={session.id}
                label={session.label}
                icon={session.pinned ? BookmarkIcon : ClockIcon}
                size="sm"
                isSelected={state.resumeTarget === session.id}
                onClick={() => agentActions.openSession(session.id)}
                actions={
                  <MoreMenu
                    label={`Options for ${session.label}`}
                    size="sm"
                    items={[
                      { label: 'Rename', icon: PencilIcon, onClick: () => setRenameTarget({ id: session.id, value: session.label }) },
                      { label: session.pinned ? 'Unpin' : 'Pin', icon: BookmarkIcon, onClick: () => agentActions.togglePin(session.id) },
                      { label: session.locked ? 'Unlock chat' : 'Lock chat', icon: session.locked ? LockOpenIcon : LockClosedIcon, onClick: () => agentActions.toggleLock(session.id) },
                      { label: 'Share', icon: ShareIcon, onClick: () => shareSession(session.id, session.label) },
                      { label: 'Fork', icon: DocumentDuplicateIcon, onClick: () => agentActions.forkSession(session.id) },
                      { type: 'divider' as const },
                      { label: session.archived ? 'Unarchive' : 'Archive', icon: ArchiveBoxIcon, onClick: () => agentActions.toggleArchive(session.id) },
                      { label: 'Delete', icon: TrashIcon, onClick: () => agentActions.deleteSession(session.id) },
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

          {archivedSessions(state.sessions).length > 0 ? (
            <SideNavSection title="Archived" isHeaderHidden>
              <SideNavItem label={`Archived (${archivedSessions(state.sessions).length})`} icon={ArchiveBoxIcon} size="sm" collapsible={{ defaultIsCollapsed: true }}>
                <VStack gap={1.5}>
                  {archivedSessions(state.sessions).map((session) => (
                    <SideNavItem
                      key={session.id}
                      label={session.label}
                      size="sm"
                      isSelected={state.resumeTarget === session.id}
                      onClick={() => agentActions.openSession(session.id)}
                      actions={
                        <MoreMenu
                          label={`Options for ${session.label}`}
                          size="sm"
                          items={[
                            { label: 'Unarchive', icon: ArchiveBoxIcon, onClick: () => agentActions.toggleArchive(session.id) },
                            { label: 'Delete', icon: TrashIcon, onClick: () => agentActions.deleteSession(session.id) },
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
                      It works in this workspace: bash, files, git, npm, python charts, live preview.
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
                    <Transcript entries={state.entries} running={state.running} />
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
