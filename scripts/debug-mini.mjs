#!/usr/bin/env node
/**
 * Cell e2e — drives the real UI in headless Chrome over raw CDP (no deps):
 * types into xterm, reads terminal rows, sidebar text and the git panel,
 * clicks real buttons. Run with the dev server up on :5199 and the git
 * server from scripts/git-http-server.mjs.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'http://localhost:5199/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function record(name, ok) {
  if (!ok) {
    failures.push(name)
    termRows().then((rows) => console.log(`  tail: ${JSON.stringify(rows.slice(-10))}`)).catch(() => {})
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// ---- CDP client on the builtin WebSocket ----------------------------------
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

// ---- launch chrome ---------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'cell-e2e-profile-'))
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
await conn.send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
  sessionId,
)

const pageErrors = []
conn.on((message) => {
  if (message.sessionId !== sessionId) return
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.text ?? 'exception')
  if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') pageErrors.push(message.params.entry.text)
})

async function evalJS(expression) {
  const response = await conn.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
  )
  if (response.exceptionDetails) throw new Error(`page eval failed: ${response.exceptionDetails.text}`)
  return response.result?.value
}

const termText = () => evalJS(`document.querySelector('.terminal')?.textContent ?? ''`)
const termRows = () => evalJS(`[...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.trim())`)
const sidebarText = () => evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true
    } catch {
      // page mid-render — keep polling
    }
    await sleep(350)
  }
  console.log(`  (timeout waiting for: ${label})`)
  return false
}

// real OS keycodes — xterm's key evaluator interprets them
const KEY_CODES = {
  ' ': 32, '`': 192, '~': 192, '-': 189, '_': 189, '=': 187, '+': 187,
  '[': 219, '{': 219, ']': 221, '}': 221, '\\': 220, '|': 220,
  ';': 186, ':': 186, "'": 222, '"': 222, ',': 188, '<': 188, '.': 190, '>': 190, '/': 191, '?': 191,
  '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
}
const keyCodeFor = (ch) =>
  KEY_CODES[ch] ?? (/[0-9]/.test(ch) ? ch.charCodeAt(0) : /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0))

async function typeLine(command) {
  await evalJS(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  for (const ch of command) {
    const params = {
      type: 'keyDown',
      key: ch,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: keyCodeFor(ch),
    }
    if (ch === ' ') params.code = 'Space'
    else if (/[a-z]/i.test(ch)) params.code = `Key${ch.toUpperCase()}`
    await conn.send('Input.dispatchKeyEvent', params, sessionId)
    await conn.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: ch, windowsVirtualKeyCode: keyCodeFor(ch) },
      sessionId,
    )
  }
  await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
  await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
}

/** Type a command, then wait until output settles and the prompt returns. */
async function run(command, timeoutMs = 60000) {
  const before = (await termRows()).join('\u0001')
  await typeLine(command)
  let joined = before
  let stable = 0
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(400)
    const now = (await termRows()).join('\u0001')
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

// ---- git server ------------------------------------------------------------
const gitServer = spawn('node', ['scripts/git-http-server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
const gitPort = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('git server did not start')), 20000)
  gitServer.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const match = /GITSERVER (\d+)/.exec(buffer)
    if (match) {
      clearTimeout(timer)
      resolve(parseInt(match[1], 10))
    }
  })
})

// ---- the run ---------------------------------------------------------------
try {
  record('app boots', await waitUntil(async () => (await evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)).includes('project'), 40000, 'boot'))
  record('terminal attaches', await waitUntil(async () => (await evalJS(`!!document.querySelector('.xterm-helper-textarea')`)) === true, 20000, 'textarea'))

  await typeLine('curl -s https://registry.npmjs.org/ms/latest')
  await sleep(8000)
  console.log('CURL ROWS:', JSON.stringify((await termRows()).filter(Boolean).slice(-6)))

  await run('mkdir -p /home/user/artifacts')
  await typeLine("python3 -c \"import matplotlib; matplotlib.use('AGG'); import matplotlib.pyplot as plt; plt.figure(); plt.plot([1,2],[3,4]); plt.savefig('/home/user/artifacts/dbg.png', dpi=100); print('saved-ok')\"")
  await waitUntil(async () => (await termText()).includes('saved-ok'), 420000, 'python matplotlib')
  await sleep(3000)
  await run('find / -name dbg.png 2>/dev/null')
  await sleep(1500)
  console.log('PY ROWS:', JSON.stringify((await termRows()).filter(Boolean).slice(-16)))
  await run('ls -la /home/user/artifacts')
  await sleep(1500)
  console.log('LS ROWS:', JSON.stringify((await termRows()).filter(Boolean).slice(-6)))
  console.log(`\n${failures.length === 0 ? 'DEBUG DONE' : failures.join(',')}`)
  chrome.kill('SIGTERM')
  process.exit(0)
} catch (err) {
  console.log('HARNESS ERROR', err)
  chrome.kill('SIGTERM')
  process.exit(1)
}
