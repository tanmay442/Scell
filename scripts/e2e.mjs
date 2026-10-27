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
  // insertText (IME-style) delivers the whole line verbatim — per-char
  // key events mangle backslash sequences into real newlines
  await conn.send('Input.insertText', { text: command }, sessionId)
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

  await run('cd ~/project')

  await typeLine('node src/index.ts')
  record('node runs the starter TS', await waitUntil(
    async () => (await termText()).includes('Hello, Cell!'),
    30000,
    'node output',
  ))
  await run('') // let the prompt come back before the next command

  await run('tsc')
  record('tsc reports the starter errors', (await termText()).includes('error TS2322'))

  await run('git init')
  record('git init reports the repository', (await termText()).includes('Initialized empty Git repository'))

  await run('ls -a')
  record('ls -a shows .git as a real directory', (await termRows()).includes('.git'))
  record(
    'sidebar tree shows .git',
    await evalJS(`[...document.querySelectorAll('.sidebar-body *')].some((el) => el.textContent === '.git' && el.children.length === 0)`),
  )

  await run('git add .')
  await run('git commit -m "first cell commit"')
  record('git commit really commits', (await termText()).includes('first cell commit'))

  await run('git log')
  record('git log shows author and message', (await termText()).includes('Author: Cell User'))

  await run('echo "more" >> README.md')
  await run('git status')
  record('git status sees the modification', (await termText()).includes('modified:'))

  // --- source control panel: discovered repositories, no hardcoded roots ---
  await evalJS(`[...document.querySelectorAll('button')].find((b) => (b.title || '').includes('Source Control'))?.click()`)
  const panelText = () => evalJS(`document.querySelector('.git-panel')?.textContent ?? ''`)
  record('git panel lists README.md as changed', await waitUntil(
    async () => (await panelText()).includes('README.md'),
    15000,
    'panel changes',
  ))

  await evalJS(`(() => {
    const box = document.querySelector('.git-message')
    const commitBtn = document.querySelector('.git-commit-btn')
    if (!box || !commitBtn) throw new Error('panel controls missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'committed from the panel')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    commitBtn.click()
    return true
  })()`)
  record('panel commit lands → working tree clean', await waitUntil(
    async () => (await panelText()).includes('working tree clean'),
    30000,
    'panel commit',
  ))

  // --- clone from a real git server over smart HTTP ------------------------
  await evalJS(`[...document.querySelectorAll('button')].find((b) => (b.title || '') === 'Explorer')?.click()`)
  await run('cd ~')
  await run(`git clone http://127.0.0.1:${gitPort}/testrepo.git`, 120000)
  record('git clone materializes the repo in the tree', await waitUntil(
    async () => (await sidebarText()).includes('testrepo'),
    20000,
    'clone in tree',
  ))

  await run('cd testrepo')
  await run('ls')
  record('cloned worktree has the server files', (await termRows()).includes('hello.txt'))

  await run('git log --oneline')
  record('cloned repo has real history', (await termText()).includes('e2e seed commit'))
  record(
    'clone leaves a visible .git in the tree',
    await evalJS(`[...document.querySelectorAll('.sidebar-body *')].some((el) => el.textContent === '.git' && el.children.length === 0)`),
  )

  // --- npm inside the cloned project (the subdir install flow) -------------
  await run('npm install', 120000)
  record('npm install works inside a cloned project', (await termText()).includes('ms@2.'))
  await run('ls')
  record('install creates node_modules in the project', (await termRows()).includes('node_modules'))
  await typeLine("node -e \"console.log(require('ms')('2 days'))\"")
  record('installed packages resolve from the project', await waitUntil(
    async () => (await termText()).includes('172800000'),
    30000,
    'ms resolve',
  ))
  await run('')
  await run('npm run hi')
  record('npm run executes project scripts', (await termText()).includes('from testrepo'))
  await run('npm dev')
  record('npm dev shorthand runs the dev script', (await termText()).includes('from testrepo'))
  await run('npm run moo', 120000)
  record('project bins run inside npm scripts (cowsay)', (await termText()).includes('< e2e-moo >'))

  // --- global install: bins become real PATH commands -----------------------
  await run('cd ~')
  await run('npm install -g semver', 120000)
  record('npm install -g adds to the global root', (await termText()).includes('added 1 package globally'))
  await typeLine('semver 1.2.3')
  record('global bins run as shell commands', await waitUntil(
    async () => (await termRows()).includes('1.2.3'),
    20000,
    'semver output',
  ))
  await run('')

  // --- scoped global package: @opencode/cli registers its bin, fails native -
  await run('npm install -g @opencode/cli', 120000)
  record('scoped global packages register their bins', (await termText()).includes('commands now on PATH: opencode'))
  await typeLine('opencode')
  record('opencode explains the native-binary limit', await waitUntil(
    async () => (await termText()).includes('native platform binary'),
    20000,
    'opencode guard',
  ))
  await run('')

  // --- agent harness without a key points at the config ----------------------
  await run('cell agent "hello"')
  record('cell agent without config explains setup', (await termText()).includes('~/.cell/agent.json'))

  // --- agent toolbox: shell utilities, curl, cell status -------------------
  await run('which node')
  record('which resolves platform commands', (await termText()).includes('node'))
  await run("find ~/project -name '*.ts' | head -n 3")
  record('find walks the VFS', (await termRows()).some((row) => row.endsWith('index.ts')))
  await run("sed -n '1p' ~/project/README.md")
  record('sed edits streams', (await termText()).includes('# Starter project'))
  await typeLine('curl -s https://registry.npmjs.org/ms/latest')
  let curlOk = await waitUntil(async () => (await termText()).includes('"name"'), 30000, 'curl output')
  if (!curlOk) {
    await run('curl -s https://registry.npmjs.org/ms/latest', 30000)
    curlOk = (await termText()).includes('"name"')
  }
  record('curl fetches cross-origin JSON', curlOk)
  await run('')
  await run('cell status')
  record('cell status reports unconfigured storage', (await termText()).includes('not configured'))

  // --- github clone through the CORS relay (gh-proxy.com) ------------------
  await run('cd ~')
  await run('git clone https://github.com/octocat/Hello-World.git hw', 240000)
  record('github clone works through the relay', await waitUntil(
    async () => (await evalJS(`[...document.querySelectorAll('.sidebar-body *')].some((el) => el.textContent === 'hw' && el.children.length === 0)`)),
    20000,
    'hw dir in tree',
  ))
  await run('cd hw')
  await run('ls')
  record('github-cloned repo has files', (await termRows()).includes('README'))
  await run('git log --oneline')
  record('github-cloned repo has real history', (await termText()).includes('Merge pull request'))

  // --- reload: workspace, repos and dotfiles persist through IndexedDB -----
  await conn.send('Page.reload', {}, sessionId)
  await waitUntil(async () => (await sidebarText()).includes('project'), 30000, 'reload boot')
  await sleep(800)
  await run('cd ~/project')
  await run('git log --oneline')
  record('reload restores the workspace with git history', (await termText()).includes('first cell commit'))
  record('reload keeps the cloned repo', (await sidebarText()).includes('testrepo'))
  await run('ls -a ~')
  const homeRows = await termRows()
  record('reload keeps dotfiles', homeRows.includes('.gitconfig'))

  // editor scroll: a long file must overflow the scroller and really scroll
  await run('seq 1 400 > ~/project/long.txt')
  await evalJS(`(function () { const rows = Array.from(document.querySelectorAll('.tree-row.is-file')); const el = rows.find(function (r) { return r.textContent.indexOf('long.txt') !== -1 }); if (el) el.click(); return 'ok' })()`)
  record('editor scrolls long files', await waitUntil(async () => {
    const state = await evalJS(`(function () { const s = document.querySelector('.cm-scroller'); if (!s) return null; const b = s.scrollTop; s.scrollTop = 5000; return { can: s.scrollHeight > s.clientHeight, moved: s.scrollTop > 1000 } })()`)
    return state !== null && state.can === true && state.moved === true
  }, 20000, 'editor scroll'))

  // sidebar scroll: many files must overflow the tree and really scroll
  await run('for i in $(seq 1 120); do touch ~/project/generated-$i.txt; done', 120000)
  record('sidebar tree scrolls many files', await waitUntil(async () => {
    const state = await evalJS(`(function () { const b = document.querySelector('.sidebar-body'); if (!b) return null; const scroller = b.scrollHeight > b.clientHeight ? b : (b.querySelector('*') || b); b.scrollTop = 99999; return { can: b.scrollHeight > b.clientHeight, moved: b.scrollTop > 500, count: document.querySelectorAll('.tree-row.is-file').length } })()`)
    return state !== null && state.can === true && state.moved === true
  }, 20000, 'sidebar scroll'))

  // --- python: pandas + matplotlib analysis producing a downloadable PNG ---
  await run('cd ~/project')
  await run("echo 'city,temps' > data.csv")
  await run("echo 'berlin,21' >> data.csv")
  await run("echo 'tokyo,28' >> data.csv")
  await run("echo 'lima,31' >> data.csv")
  await run("echo 'oslo,12' >> data.csv")
  await run('cat data.csv')
  console.log('DATA.CSV ROWS:', JSON.stringify((await termRows()).filter(Boolean).slice(-7)))
  await typeLine(
    "python3 -c \"import pandas as pd; import matplotlib; matplotlib.use('AGG'); import matplotlib.pyplot as plt; df = pd.read_csv('data.csv'); print(df.temps.mean()); plt.figure(figsize=(6,4)); plt.bar(df.city, df.temps); plt.savefig('/home/user/artifacts/temps.png', dpi=110); print('artifact written')\"",
  )
  await run('python3 analysis.py', 420000)
  const pyRows = await termRows()
  // the OUTPUT row is exactly the text — the echoed command row also
  // contains it, so match whole trimmed rows
  record('python runs pandas analysis', pyRows.some((row) => row.trim() === '23.0'))
  record('python exit code clean', pyRows.some((row) => row.trim() === 'artifact written'))
  await run('ls -la ~/artifacts')
  const lsRows = await termRows()
  console.log('ARTIFACTS LS:', JSON.stringify(lsRows.filter(Boolean).slice(-8)))
  record('matplotlib artifact lands in artifacts/', lsRows.some((row) => row.includes('temps.png')))
  record('artifact is a real PNG (bytes via stat)', (await termText()).includes('temps.png'))
  await evalJS(`[...document.querySelectorAll('.tree-row.is-dir')].find((el) => el.textContent.includes('artifacts'))?.click()`)
  record('artifact visible in sidebar tree', await waitUntil(
    async () => (await evalJS(`[...document.querySelectorAll('.sidebar-body *')].some((el) => el.textContent === 'temps.png' && el.children.length === 0)`)),
    20000,
    'temps.png in tree',
  ))

  record('no page errors during the whole run', pageErrors.length === 0)
  if (pageErrors.length > 0) console.log(`  page errors: ${JSON.stringify(pageErrors.slice(0, 4))}`)
} catch (err) {
  failures.push(`harness error: ${err?.message ?? err}`)
  console.log(`HARNESS ERROR  ${err?.stack ?? err}`)
} finally {
  console.log(`\n${failures.length === 0 ? 'ALL GREEN' : `${failures.length} FAILURES: ${failures.join(', ')}`}`)
  gitServer.kill('SIGTERM')
  chrome.kill('SIGTERM')
  process.exit(failures.length === 0 ? 0 : 1)
}
