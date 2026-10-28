#!/usr/bin/env node
/**
 * Scribe repro: fresh profile → clone tanmay442/ye-olde-ai-scribe from github
 * through the relay → npm install → npm run dev. The tab must SURVIVE the
 * run; vercel's own errors are fine. Same proven harness as scripts/e2e.mjs.
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

const profile = mkdtempSync(join(tmpdir(), 'cell-scribe-'))
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
  await run('git clone https://github.com/tanmay442/ye-olde-ai-scribe.git scribe', 240000)
  report('clone lands', await waitUntil(async () => (await evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)).includes('scribe'), 30000, 'tree'))
  await run('cd scribe')
  await run('ls')
  report('package.json present', (await termRows() ?? []).includes('package.json'))

  // install
  await run('npm install', 180000)
  report('npm install finishes', (await termText()).includes('generative-ai'))

  // THE moment: npm run dev (vercel dev) must not take the tab down
  await run('npm run dev -- --yes', 240000)
  await sleep(5000)
  const alive = (await evalJS(`!!document.querySelector('.xterm-helper-textarea')`)) === true && crashes.length === 0
  report('tab survives npm run dev (no vercel)', alive, crashes.slice(0, 2).join(' | '))
  let tail = (await termRows() ?? []).filter(Boolean).slice(-10)
  console.log('terminal tail:', JSON.stringify(tail))

  // THE way to run this app without vercel: cell preview
  await run('cell preview')
  report('cell preview opens the panel', await waitUntil(async () => (await evalJS(`!!document.querySelector('.preview-panel')`)) === true, 15000, 'panel'))
  // SW ground truth: attach to the worker target and ask it directly
  await sleep(6000)
  try {
    const { targetInfos } = await conn.send('Target.getTargets')
    const swTarget = targetInfos.find((t) => t.type === 'service_worker')
    console.log('SW target:', swTarget ? `${swTarget.url} (${swTarget.state ?? '?'})` : 'NONE FOUND')
    if (swTarget) {
      const swSession = (await conn.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId
      const swEval = async (expression) => {
        const m = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, swSession)
        return m.result?.result?.value
      }
      console.log('SW cache keys:', JSON.stringify(await swEval(`caches.open('cell-preview-v3').then((c) => c.keys()).then((keys) => keys.map((k) => k.url))`)))
      console.log('SW registrations:', JSON.stringify(await swEval(`self.registration.scope + ' active=' + !!self.registration.active`)))
    }
  } catch (err) { console.log('SW probe error:', err.message) }
  console.log('iframe href:', JSON.stringify(await evalJS(`document.querySelector('.preview-frame')?.contentWindow?.location?.href ?? 'no-frame'`)))
  console.log('iframe body head:', JSON.stringify(await evalJS(`(document.querySelector('.preview-frame')?.contentDocument?.body?.textContent ?? 'no-doc').slice(0, 120)`)))
  report(
    'preview renders the app',
    await waitUntil(
      async () => String(await evalJS(`document.querySelector('.preview-frame')?.contentDocument?.title ?? ''`)).includes('Ye Olde'),
      15000,
      'iframe title',
    ),
  )
  // /api/chat executes the real function in the node isolate
  await evalJS(`(() => { window.__apiStatus = null; const f = document.querySelector('.preview-frame'); f.contentWindow.fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) }).then((r) => { window.__apiStatus = r.status }).catch((e) => { window.__apiStatus = 'ERR ' + e.message }); return 'started' })()`)
  report(
    'api function executes in the isolate',
    await waitUntil(async () => (await evalJS(`window.__apiStatus`)) !== null && (await evalJS(`window.__apiStatus`)) !== undefined, 120000, 'api status'),
    `status=${await evalJS(`window.__apiStatus`)}`,
  )

  // the user's actual crash: vercel installed globally, then npm run dev
  await run('npm install -g vercel', 420000)
  report('vercel installs globally (npm aliases resolve)', (await termText()).includes('vercel@'))
  await run('npm run dev -- --yes', 300000)
  await sleep(10000)
  const aliveVercel = (await evalJS(`!!document.querySelector('.xterm-helper-textarea')`)) === true && crashes.length === 0
  report('TAB SURVIVES vercel dev', aliveVercel, crashes.slice(0, 3).join(' | '))
  tail = (await termRows() ?? []).filter(Boolean).slice(-10)
  console.log('vercel tail:', JSON.stringify(tail))

  // the tab must still be USEFUL afterwards
  await run('echo still-alive')
  report('shell works after the run', (await termRows() ?? []).includes('still-alive'))

  // dependencies must SURVIVE a reload (they live in IndexedDB now)
  await conn.send('Page.reload', {}, sessionId)
  await waitUntil(async () => (await evalJS(`document.querySelector('.sidebar-body')?.textContent ?? ''`)).includes('scribe'), 40000, 'reload boot')
  await sleep(1000)
  await run('cd ~/scribe')
  await run('test -d node_modules && echo nm-present')
  report('node_modules survives reload', (await termText()).includes('nm-present'))
  await typeLine("node -e \"console.log(require('@google/generative-ai') ? 'deps-ok' : 'deps-broken')\"")
  report('installed deps still resolve after reload', await waitUntil(
    async () => (await termText()).includes('deps-ok'),
    30000,
    'deps resolve',
  ))
  await run('')

  // shell env must reach node process.env (the agent workhorse pattern)
  await run('export E2E_TOKEN=secret-987')
  await typeLine('node -e "console.log(\'tok=\' + process.env.E2E_TOKEN)"')
  report('shell exports reach node process.env', await waitUntil(
    async () => (await termText()).includes('tok=secret-987'),
    30000,
    'env in node',
  ))
  await run('')

  report('no renderer crashes', crashes.length === 0, crashes.slice(0, 3).join(' | '))
} catch (err) {
  console.log(`HARNESS ERROR  ${err?.stack ?? err}`)
  process.exitCode = 1
} finally {
  console.log(`\n${process.exitCode ? 'SCRIBE REPRO FAILED' : 'SCRIBE REPRO PASSED'}`)
  chrome.kill('SIGTERM')
  process.exit(process.exitCode ? 1 : 0)
}
