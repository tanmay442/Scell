#!/usr/bin/env node
/**
 * GDG benchmark: fresh profile → clone tanmay442/gdg-hbtu from github
 * through the relay → npm install (~200 packages) → cell preview must
 * bundle & mount the React app in the preview iframe. Same proven
 * harness as scripts/e2e-scribe.mjs.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'http://localhost:5199/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    } else {
      for (const listener of listeners) listener(message)
    }
  }
  return {
    ready: new Promise((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('websocket error'))
    }),
    send(method, params = {}, sessionId) {
      const message = { id: ++nextId, method, params }
      if (sessionId) message.sessionId = sessionId
      ws.send(JSON.stringify(message))
      return new Promise((resolve, reject) => pending.set(message.id, { resolve, reject }))
    },
    on(listener) {
      listeners.push(listener)
    },
  }
}

const profile = mkdtempSync(join(tmpdir(), 'cell-gdg-'))
const chrome = spawn('google-chrome-stable', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('chrome did not expose DevTools')), 25000)
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk.toString()
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)
    if (match) {
      clearTimeout(timer)
      resolve(match[1])
    }
  })
})

const conn = connect(wsUrl)
await conn.ready
const { targetId } = await conn.send('Target.createTarget', { url: APP })
const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
await conn.send('Runtime.enable', {}, sessionId)
await conn.send('Page.enable', {}, sessionId)
await conn.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)

const crashes = []
conn.on((message) => {
  if (message.sessionId !== sessionId) return
  if (message.method === 'Inspector.targetCrashed') crashes.push('targetCrashed')
  if (message.method === 'Runtime.exceptionThrown') crashes.push('exc: ' + String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text).slice(0, 200))
})

async function evalJS(expression) {
  const response = await conn.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).catch(() => null)
  if (!response || response.exceptionDetails) return undefined
  return response.result?.value
}

const termRows = () => evalJS(`[...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.trim())`)
const termText = () => evalJS(`document.querySelector('.terminal')?.textContent ?? ''`)

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true
    } catch {
      // keep polling
    }
    await sleep(400)
  }
  console.log(`  (timeout waiting for: ${label})`)
  return false
}

async function typeLine(command) {
  await evalJS(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  for (const ch of command) {
    const params = {
      type: 'keyDown',
      key: ch,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: KEY_CODES[ch] ?? (/^[0-9]$/.test(ch) ? ch.charCodeAt(0) : ch.toUpperCase().charCodeAt(0)),
    }
    if (ch === ' ') params.code = 'Space'
    else if (/[a-z]/i.test(ch)) params.code = `Key${ch.toUpperCase()}`
    await conn.send('Input.dispatchKeyEvent', params, sessionId)
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: KEY_CODES[ch] ?? ch.toUpperCase().charCodeAt(0) }, sessionId)
  }
  await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
  await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
}

const KEY_CODES = {
  ' ': 32, '`': 192, '~': 192, '-': 189, '_': 189, '=': 187, '+': 187,
  '[': 219, '{': 219, ']': 221, '}': 221, '\\': 220, '|': 220,
  ';': 186, ':': 186, "'": 222, '"': 222, ',': 188, '<': 188, '.': 190, '>': 190, '/': 191, '?': 191,
  '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
}

async function run(command, timeoutMs = 60000) {
  const before = (await termRows() ?? []).join('\u0001')
  await typeLine(command)
  let joined = before
  let stable = 0
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(400)
    if (crashes.length > 0) return
    const now = (await termRows() ?? []).join('\u0001')
    if (now === joined) stable++
    else stable = 0
    joined = now
    if (stable >= 5 && joined !== before) {
      const rows = joined.split('\u0001')
      const lastNonEmpty = [...rows].reverse().find((row) => row.trim() !== '') ?? ''
      if (lastNonEmpty.trimEnd().endsWith('$')) break
    }
  }
  await sleep(200)
}

function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

try {
  // boot
  report('app boots', await waitUntil(async () => (await evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)).includes('project'), 40000, 'boot'))
  report('terminal attaches', await waitUntil(async () => (await evalJS(`!!document.querySelector('.xterm-helper-textarea')`)) === true, 20000, 'textarea'))

  // clone the real repo through the github relay
  await run('git clone https://github.com/tanmay442/gdg-hbtu.git gdg', 240000)
  report('clone lands', await waitUntil(async () => (await evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)).includes('gdg'), 30000, 'tree'))
  await run('cd gdg')
  await run('ls')
  const rowsAfterLs = (await termRows() ?? [])
  report('package.json present', rowsAfterLs.includes('package.json'))
  report('src present', rowsAfterLs.includes('src'))

  // install (~200 packages; the summary prints + name@version lines)
  await run('npm install', 600000)
  report(
    'npm install finishes',
    await waitUntil(async () => {
      const text = (await termText()) ?? ''
      return text.includes('react@19') || text.includes('vite@7')
    }, 60000, 'npm install summary'),
  )

  // THE moment: cell preview must bundle & mount the React app in the iframe
  await run('cell preview')
  report('cell preview opens the panel', await waitUntil(async () => (await evalJS(`!!document.querySelector('.preview-panel')`)) === true, 30000, 'panel'))
  // diagnostics: what is the panel doing?
  for (let i = 0; i < 8; i++) {
    await sleep(8000)
    console.log(`PANEL+${(i + 1) * 10}s:`, String(await evalJS(`(() => { const p = document.querySelector('.preview-panel'); if (!p) return 'no panel'; const err = p.querySelector('.preview-error')?.textContent ?? ''; const frame = p.querySelector('.preview-frame'); const status = p.querySelector('.preview-status')?.textContent ?? ''; return JSON.stringify({ boot: String(frame?.contentWindow?.__cellBoot ?? 'none').slice(0, 120), status: status.slice(0, 120), error: err.slice(0, 300), frame: !!frame, title: frame?.contentDocument?.title ?? null, root: frame ? (frame.contentDocument?.getElementById('root')?.children?.length ?? -1) : -1, errs: (frame?.contentWindow?.__cellErrors ?? []).slice(0, 6), reactKeys: frame ? Object.keys(frame.contentDocument?.getElementById('root') ?? {}).slice(0, 8) : [], bodyKids: frame ? frame.contentDocument?.body?.children?.length : -1, scripts: frame ? frame.contentDocument?.scripts?.length : -1, scriptSrcs: frame ? Array.from(frame.contentDocument?.scripts ?? []).map(function (s) { var t = s.textContent || ''; try { new Function(t); var parse = 'parses' } catch (e) { var parse = 'SYNTAX:' + e.message } return (s.getAttribute('src') ? 'src=' + s.getAttribute('src').slice(0, 30) : 'inline') + ':' + t.length + ':' + parse + ':rawClose=' + t.includes('</' + 'script') }) : [], bodyTail: frame ? (frame.contentDocument?.body?.innerHTML ?? '').slice(-200) : '' }) })()`)))
  }
  report(
    'preview renders the app',
    await waitUntil(
      async () => String(await evalJS(`document.querySelector('.preview-frame')?.contentDocument?.title ?? ''`)).includes('GDG HBTU'),
      90000,
      'iframe title',
    ),
  )
  report(
    'react mounts',
    await waitUntil(
      async () => (await evalJS(`((document.querySelector('.preview-frame')?.contentDocument?.getElementById('root')?.children?.length) ?? 0) > 0`)) === true,
      90000,
      'root children',
    ),
  )

  // the tab must still be USEFUL afterwards, with no crashes along the way
  await run('echo benchmark-done')
  report('shell works after the run', (await termRows() ?? []).includes('benchmark-done'))
  report('no renderer crashes', crashes.length === 0, crashes.slice(0, 3).join(' | '))
} catch (err) {
  console.log(`HARNESS ERROR  ${err?.stack ?? err}`)
  process.exitCode = 1
} finally {
  console.log(`\n${process.exitCode ? 'GDG BENCHMARK FAILED' : 'GDG BENCHMARK PASSED'}`)
  chrome.kill('SIGTERM')
  process.exit(process.exitCode ? 1 : 0)
}
