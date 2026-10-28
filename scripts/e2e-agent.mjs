#!/usr/bin/env node
/**
 * Cell agent e2e — drives the real UI in headless Chrome over raw CDP (no
 * deps), gates on CELL_AGENT_LIVE_KEY, and skips cleanly without it:
 *
 *   CELL_AGENT_LIVE_KEY=LLM_… node scripts/e2e-agent.mjs
 *
 * Flow: boot → write ~/.cell/agent.json (meta provider + live key) →
 * `cell agent "reply with exactly: e2e-agent-ok" --steps 5` → transcript in
 * the terminal contains e2e-agent-ok and a saved session exists.
 *
 * Needs the dev server on :5199 (`pnpm dev`, override with APP_URL).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE_KEY = process.env.CELL_AGENT_LIVE_KEY ?? ''
if (LIVE_KEY === '') {
  console.log('SKIP  e2e:agent needs CELL_AGENT_LIVE_KEY (no live key — nothing to run against)')
  process.exit(0)
}

const APP = process.env.APP_URL ?? 'http://localhost:5199/'
const CHROME = process.env.CHROME_BIN ?? 'google-chrome-stable'

try {
  const probe = await fetch(APP)
  await probe.arrayBuffer().catch(() => {})
} catch {
  console.error(`e2e:agent: dev server not reachable at ${APP} — run \`pnpm dev\` first (override with APP_URL)`)
  process.exit(1)
}
{
  const check = spawnSync(CHROME, ['--version'], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error(`e2e:agent: chrome not runnable as '${CHROME}' — install google-chrome-stable (override with CHROME_BIN)`)
    process.exit(1)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function record(name, ok) {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

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

const profile = mkdtempSync(join(tmpdir(), 'cell-e2e-agent-profile-'))
const chrome = spawn(CHROME, [
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
    await sleep(500)
  }
  console.log(`  (timeout waiting for: ${label})`)
  return false
}

async function typeLine(command) {
  await evalJS(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  await conn.send('Input.insertText', { text: command }, sessionId)
  await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
  await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
}

async function run(command, timeoutMs = 60000) {
  const before = (await termRows()).join('')
  await typeLine(command)
  let joined = before
  let stable = 0
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(400)
    const now = (await termRows()).join('')
    if (now === joined) stable++
    else stable = 0
    joined = now
    if (stable >= 5 && joined !== before) {
      const rows = joined.split('')
      const lastNonEmpty = [...rows].reverse().find((row) => row.trim() !== '') ?? ''
      if (lastNonEmpty.trimEnd().endsWith('$')) break
    }
  }
  await sleep(200)
}

try {
  record('fresh boot seeds ~/project in the tree', await waitUntil(
    async () => (await sidebarText()).includes('project'),
    30000,
    'boot',
  ))
  record('terminal is attached and interactive', await waitUntil(
    async () => evalJS(`!!document.querySelector('.xterm-helper-textarea')`),
    20000,
    'xterm textarea',
  ))

  // configure the meta provider with the live key, exactly like a user
  // would: single-quoted echo keeps the JSON (and the key) verbatim
  const agentJson = JSON.stringify({ provider: 'meta', model: 'muse-spark-1.3-contributor', apiKey: LIVE_KEY })
  await run(`mkdir -p ~/.cell`)
  await run(`echo '${agentJson}' > ~/.cell/agent.json`)
  await run('cat ~/.cell/agent.json')
  record('meta provider configured in ~/.cell/agent.json', (await termText()).includes('"meta"'))

  await typeLine(`cell agent "reply with exactly: e2e-agent-ok" --steps 5`)
  record('trivial question answers through the meta transport', await waitUntil(
    async () => (await termText()).includes('e2e-agent-ok'),
    300000,
    'e2e-agent-ok in transcript',
  ))
  await run('', 30000)
  record('transcript names the meta model', (await termText()).includes('meta/muse-spark-1.3-contributor'))
  await run('ls ~/.cell/sessions')
  record('run persisted a session', await waitUntil(
    async () => (await termText()).includes('agent-'),
    30000,
    'session file',
  ))
  record('no page errors during the run', pageErrors.length === 0)
  if (pageErrors.length > 0) console.log(`  page errors: ${JSON.stringify(pageErrors.slice(0, 4))}`)
} catch (err) {
  failures.push(`harness error: ${err?.message ?? err}`)
  console.log(`HARNESS ERROR  ${err?.stack ?? err}`)
} finally {
  console.log(`\n${failures.length === 0 ? 'ALL GREEN' : `${failures.length} FAILURES: ${failures.join(', ')}`}`)
  chrome.kill('SIGTERM')
  process.exit(failures.length === 0 ? 0 : 1)
}
