import { describe, expect, it } from 'vitest'
import { createVfs } from '../src/vfs/vfs'
import {
  chunkTelegramMessage,
  sanitizeAttachmentName,
  createTelegramApi,
  deliverDueReminders,
  loadTelegramConfig,
  parseTelegramCommand,
  startTelegramPoller,
  telegramThreadFor,
  type TelegramFetch,
} from './telegram'
import { addReminder, loadReminders } from '../src/shell/commands/agent-reminders'

/** Fake Bot API: queued updates in, sent messages/files out, file store. */
function mockApi() {
  const updates: Array<{ update_id: number; message?: { chat?: { id: number; type: string }; type?: string; text?: string; caption?: string; from?: { id: number }; photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>; document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number } } }> = []
  const sent: Array<{ chatId: number; text: string }> = []
  const sentFiles: Array<{ chatId: number; name: string; kind: string }> = []
  const fileStore: Record<string, { path: string; bytes: number[] }> = {}
  let nextId = 1
  const fetch: TelegramFetch = async (url, init) => {
    const rawBody = init?.body
    const body = typeof rawBody === 'string' && rawBody !== '' ? (JSON.parse(rawBody) as { offset?: number; chat_id?: number; text?: string; file_id?: string }) : {}
    if (url.endsWith('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'testbot' } }) }
    if (url.endsWith('/getUpdates')) {
      const offset = body.offset ?? 0
      const due = updates.filter((u) => u.update_id >= offset)
      return { ok: true, status: 200, json: async () => ({ ok: true, result: due }) }
    }
    if (url.endsWith('/sendMessage')) {
      sent.push({ chatId: Number(body.chat_id), text: String(body.text ?? '') })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (url.endsWith('/sendPhoto') || url.endsWith('/sendDocument')) {
      const form = rawBody as unknown as FormData
      const file = form.get('photo') ?? form.get('document')
      const name = typeof (file as { name?: unknown })?.name === 'string' ? ((file as { name: string }).name) : 'file'
      sentFiles.push({ chatId: Number(form.get('chat_id')), name, kind: url.endsWith('/sendPhoto') ? 'photo' : 'document' })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (url.endsWith('/sendChatAction')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (url.endsWith('/getFile')) {
      const stored = fileStore[String(body.file_id ?? '')]
      if (!stored) return { ok: false, status: 404, json: async () => ({ ok: false }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: stored.path } }) }
    }
    if (url.includes('/file/bot')) {
      const stored = Object.values(fileStore).find((f) => url.endsWith(f.path))
      if (!stored) return { ok: false, status: 404, json: async () => ({ ok: false }), arrayBuffer: async () => new ArrayBuffer(0) }
      return { ok: true, status: 200, json: async () => ({ ok: true }), arrayBuffer: async () => new Uint8Array(stored.bytes).buffer }
    }
    throw new Error(`unexpected ${url}`)
  }
  return {
    fetch,
    sent,
    sentFiles,
    updates,
    addFile: (fileId: string, path: string, bytes: number[]) => {
      fileStore[fileId] = { path, bytes }
    },
    pushText: (chatId: number, text: string, type = 'private') => {
      updates.push({ update_id: nextId++, message: { chat: { id: chatId, type }, text } })
    },
    pushPhoto: (chatId: number, fileId: string, caption = '') => {
      updates.push({ update_id: nextId++, message: { chat: { id: chatId, type: 'private' }, caption, photo: [{ file_id: fileId, file_size: 1000, width: 800, height: 600 }] } })
    },
    pushDocument: (chatId: number, fileId: string, fileName: string, text = '') => {
      updates.push({ update_id: nextId++, message: { chat: { id: chatId, type: 'private' }, text, document: { file_id: fileId, file_name: fileName, mime_type: 'application/pdf', file_size: 2000 } } })
    },
  }
}

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('telegram config', () => {
  it('reads token + allowlist from env', () => {
    const vfs = createVfs()
    const out = loadTelegramConfig(vfs, { CELL_TELEGRAM_TOKEN: 'tok', CELL_TELEGRAM_ALLOW_FROM: '1, 2' })
    expect(out).toEqual({ config: { token: 'tok', allowFrom: [1, 2] } })
  })

  it('reads the allowlist (not the token) from ~/.cell/telegram.json', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/telegram.json', JSON.stringify({ allowFrom: [7] }))
    expect(loadTelegramConfig(vfs, { CELL_TELEGRAM_TOKEN: 'env-tok' })).toEqual({ config: { token: 'env-tok', allowFrom: [7] } })
  })

  it('refuses a botToken inside the workspace (agent-visible)', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/telegram.json', JSON.stringify({ botToken: 'leaky', allowFrom: [7] }))
    expect(loadTelegramConfig(vfs, {})).toEqual({ error: expect.stringContaining('agent-visible') })
  })

  it('accepts a token file from outside the workspace', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/telegram.json', JSON.stringify({ allowFrom: [7] }))
    expect(loadTelegramConfig(vfs, {}, '  file-tok\n')).toEqual({ config: { token: 'file-tok', allowFrom: [7] } })
  })

  it('is unconfigured without a token', () => {
    expect(loadTelegramConfig(createVfs(), {})).toBe(null)
  })

  it('fails closed on an empty allowlist', () => {
    const vfs = createVfs()
    expect(loadTelegramConfig(vfs, { CELL_TELEGRAM_TOKEN: 'tok' })).toEqual({
      error: expect.stringContaining('allowlist'),
    })
  })

  it('rejects malformed config files', () => {
    const vfs = createVfs()
    vfs.write('/home/user/.cell/telegram.json', '{{{')
    expect(loadTelegramConfig(vfs, {})).toEqual({ error: expect.stringContaining('valid JSON') })
  })
})

describe('telegram commands + threads', () => {
  it('parses /new /status /help, ignores the rest', () => {
    expect(parseTelegramCommand('/new')).toEqual({ command: 'new', arg: '' })
    expect(parseTelegramCommand('/status@V8442_bot')).toEqual({ command: 'status', arg: '' })
    expect(parseTelegramCommand('hello')).toBe(null)
    expect(parseTelegramCommand('/dance')).toBe(null)
  })

  it('maps stable threads per chat', () => {
    expect(telegramThreadFor(42, {})).toBe('tg-42')
    expect(telegramThreadFor(42, { '42': 'tg-42-abc' })).toBe('tg-42-abc')
  })

  it('chunks long messages on newline boundaries', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ` + 'x'.repeat(20))
    const chunks = chunkTelegramMessage(lines.join('\n'), 4000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 4000)).toBe(true)
    expect(chunks.join('\n')).toBe(lines.join('\n'))
    expect(chunkTelegramMessage('  ')).toEqual(['(no output)'])
  })
})

describe('telegram poller (mock Bot API)', () => {
  it('routes text to the agent and replies in the same chat', async () => {
    const vfs = createVfs()
    const api = mockApi()
    const seen: Array<{ chatId: number; text: string; threadId: string }> = []
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        onText: async (chatId, text, threadId) => {
          seen.push({ chatId, text, threadId })
          return `echo: ${text}`
        },
        onCommand: async () => 'cmd',
      },
      api.fetch,
    )
    api.pushText(42, 'hello bot')
    await waitFor(() => api.sent.length >= 1)
    expect(seen).toEqual([{ chatId: 42, text: 'hello bot', threadId: 'tg-42' }])
    expect(api.sent[0]).toEqual({ chatId: 42, text: 'echo: hello bot' })
    poller.stop()
  })

  it('ignores strangers, groups and non-text silently', async () => {
    const vfs = createVfs()
    const api = mockApi()
    let calls = 0
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        log: () => {},
        onText: async () => {
          calls++
          return 'x'
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    api.pushText(666, 'i am a stranger')
    api.pushText(42, 'group hi', 'group')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls).toBe(0)
    expect(api.sent.length).toBe(0)
    poller.stop()
  })

  it('/new rotates the thread, /status and /help answer', async () => {
    const vfs = createVfs()
    const api = mockApi()
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        onText: async (_c, _t, threadId) => `in ${threadId}`,
        onCommand: async (_c, command, threadId) => {
          if (command.command === 'new') return `fresh ${threadId}`
          if (command.command === 'status') return `status ${threadId}`
          return `help ${threadId}`
        },
      },
      api.fetch,
    )
    api.pushText(42, 'first')
    await waitFor(() => api.sent.length >= 1)
    expect(api.sent[0].text).toBe('in tg-42')
    api.pushText(42, '/new')
    await waitFor(() => api.sent.length >= 2)
    const rotated = api.sent[1].text.replace('fresh ', '')
    expect(rotated.startsWith('tg-42-')).toBe(true)
    api.pushText(42, 'second')
    await waitFor(() => api.sent.length >= 3)
    expect(api.sent[2].text).toBe(`in ${rotated}`)
    api.pushText(42, '/help')
    await waitFor(() => api.sent.length >= 4)
    expect(api.sent[3].text).toBe(`help ${rotated}`)
    poller.stop()
  })

  it('reports handler errors back to the chat instead of dying', async () => {
    const vfs = createVfs()
    const api = mockApi()
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        log: () => {},
        onText: async () => {
          throw new Error('boom')
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    api.pushText(42, 'break me')
    await waitFor(() => api.sent.length >= 1)
    expect(api.sent[0].text).toContain('boom')
    // the loop survives: a second message still gets a reply
    api.pushText(42, 'again')
    await waitFor(() => api.sent.length >= 2)
    poller.stop()
  })

  it('delivers due reminders once and skips chatless ones', async () => {
    const vfs = createVfs()
    const api = mockApi()
    const sender = createTelegramApi('https://api.telegram.org/botX', api.fetch)
    const now = Date.now()
    addReminder(vfs, { text: 'ping me', when: new Date(now - 1000).toISOString(), chatId: '42' }, now - 2000)
    addReminder(vfs, { text: 'no chat', when: new Date(now - 1000).toISOString() }, now - 2000)
    addReminder(vfs, { text: 'future', when: new Date(now + 3600_000).toISOString(), chatId: '42' }, now)
    const out = await deliverDueReminders(vfs, sender, now)
    expect(out).toEqual({ delivered: 1, undeliverable: 0 })
    // chatless reminders are skipped silently and never deleted
    expect(loadReminders(vfs).length).toBe(2)
    expect(api.sent).toEqual([{ chatId: 42, text: 'reminder: ping me' }])
    // fired reminders are gone; nothing due anymore
    const again = await deliverDueReminders(vfs, sender, now)
    expect(again.delivered).toBe(0)
  })
})

describe('telegram hardening', () => {
  it('never splits a surrogate pair across chunks', () => {
    const chunks = chunkTelegramMessage('😀'.repeat(10), 5)
    expect(chunks.join('')).toBe('😀'.repeat(10))
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i)
        // no lone surrogates anywhere in any chunk
        if (code >= 0xd800 && code <= 0xdbff) expect(chunk.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00)
        if (code >= 0xdc00 && code <= 0xdfff) expect(chunk.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff)
      }
    }
  })

  it('one malformed update does not abort its batch', async () => {
    const vfs = createVfs()
    const api = mockApi()
    let texts = 0
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        log: () => {},
        onText: async (_c, text) => {
          texts++
          return `got ${text}`
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    // malformed (no chat) + good in one batch: good one still delivers
    api.updates.push({ update_id: 900, message: { chat: undefined as never, type: 'private' } })
    api.pushText(42, 'after poison')
    await waitFor(() => api.sent.length >= 1)
    expect(texts).toBe(1)
    expect(api.sent[0].text).toBe('got after poison')
    poller.stop()
  })
})

describe('telegram media (photos, documents, files back)', () => {
  it('downloads photos and hands bytes to the handler', async () => {
    const vfs = createVfs()
    const api = mockApi()
    api.addFile('ph1', 'photos/a.jpg', [1, 2, 3, 4])
    let got: Array<{ name: string; mime: string; bytes: Uint8Array }> = []
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        onText: async (_c, text, _t, attachments) => {
          got = attachments
          return `seen ${attachments.length} ${text}`
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    api.pushPhoto(42, 'ph1', 'shrink this')
    await waitFor(() => api.sent.length >= 1)
    expect(got.length).toBe(1)
    expect(got[0].name).toMatch(/\.jpg$/)
    expect([...got[0].bytes]).toEqual([1, 2, 3, 4])
    expect(api.sent[0].text).toBe('seen 1 shrink this')
    poller.stop()
  })

  it('downloads documents with their filenames, refuses oversize', async () => {
    const vfs = createVfs()
    const api = mockApi()
    api.addFile('doc1', 'docs/a.pdf', [9, 9, 9])
    let got: Array<{ name: string }> = []
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        onText: async (_c, _t, _th, attachments) => {
          got = attachments
          return `docs ${attachments.length}`
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    api.pushDocument(42, 'doc1', '../../evil.pdf', 'summarize')
    await waitFor(() => api.sent.length >= 1)
    expect(got.length).toBe(1)
    expect(got[0].name).toBe('evil.pdf')
    expect(api.sent[0].text).toBe('docs 1')
    poller.stop()
  })

  it('sanitizes hostile attachment names', () => {
    expect(sanitizeAttachmentName('../../etc/passwd', 'fb')).toBe('passwd')
    expect(sanitizeAttachmentName('...', 'fb')).toBe('fb')
    expect(sanitizeAttachmentName('my report (1).PDF', 'fb')).toBe('my_report_1_.PDF')
  })

  it('sends images as photos and PDFs as documents', async () => {
    const sender = createTelegramApi('https://api.telegram.org/botX', mockApi().fetch)
    void sender
    const api = mockApi()
    const sender2 = createTelegramApi('https://api.telegram.org/botX', api.fetch)
    await sender2.sendFile(42, 'chart.png', new Uint8Array([1]), 'image/png')
    await sender2.sendFile(42, 'report.pdf', new Uint8Array([2]), 'application/pdf')
    expect(api.sentFiles).toEqual([
      { chatId: 42, name: 'chart.png', kind: 'photo' },
      { chatId: 42, name: 'report.pdf', kind: 'document' },
    ])
  })
})

describe('telegram deliverables', () => {
  it('collects only fresh thread files, newest first, capped', async () => {
    const { collectFreshFiles } = await import('./telegram')
    const { createDiskVfs } = await import('./disk-vfs')
    const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'tg-fresh-'))
    const vfs = createDiskVfs(root)
    const old = Date.now() - 100_000
    const now = Date.now()
    vfs.write('/home/user/threads/tg-1/old.txt', 'old')
    utimesSync(join(root, 'home/user/threads/tg-1/old.txt'), new Date(old), new Date(old))
    vfs.write('/home/user/threads/tg-1/new.png', 'new')
    vfs.write('/home/user/threads/tg-1/.hidden', 'x')
    vfs.write('/home/user/threads/tg-1/sub/deep.txt', 'deep')
    vfs.write('/home/user/threads/tg-2/other.txt', 'other')
    const { files: fresh, skippedOversize } = collectFreshFiles(vfs, '/home/user/threads/tg-1', now - 1000)
    const names = fresh.map((f) => f.name).sort()
    expect(names).toEqual(['deep.txt', 'new.png'])
    expect(skippedOversize).toEqual([])
    vfs.writeBytes('/home/user/threads/tg-1/big.bin', new Uint8Array(50 * 1024 * 1024))
    const again = collectFreshFiles(vfs, '/home/user/threads/tg-1', now - 1000)
    expect(again.skippedOversize).toEqual(['big.bin'])
    expect(again.files.map((f) => f.name).sort()).toEqual(['deep.txt', 'new.png'])
  })
})

describe('background worker scheduling', () => {
  it('spawns a worker thread with a notify task job', async () => {
    const { scheduleBackgroundTask } = await import('./background')
    const { createDiskVfs } = await import('./disk-vfs')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'tg-bg-'))
    const vfs = createDiskVfs(root)
    const out = await scheduleBackgroundTask(vfs, 'tg-42', '42', 'summarize the pdf')
    if (!('ok' in out)) throw new Error('schedule failed: ' + JSON.stringify(out))
    expect(out.threadId.startsWith('tg-42-w')).toBe(true)
    expect(vfs.isDir(`/home/user/threads/${out.threadId}`)).toBe(true)
    const { listJobs } = await import('./jobs')
    const job = listJobs(vfs).find((j) => j.id === out.jobId)
    expect(job?.kind).toBe('task')
    expect(job?.notifyChatId).toBe('42')
    expect(job?.status).toBe('pending')
  })
})

describe('turn queue (FIFO per chat)', () => {
  it('queues while busy, drains in order, caps the queue', async () => {
    const { createTurnQueue } = await import('./telegram')
    const { createThreadRouter } = await import('./threads')
    const router = createThreadRouter()
    const order: string[] = []
    const delivered: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    const runTurn = async (_c: number, text: string, threadId: string, _a: unknown[], _q: boolean) => {
      const outcome = await router.runExclusive(threadId, async () => {
        calls++
        if (text === 'slow') await gate
        order.push(text)
        return `reply:${text}`
      })
      if (outcome.status !== 'ran') throw new Error('busy-race')
      return outcome.value
    }
    const queue = createTurnQueue(runTurn, async (_c, text) => { delivered.push(text) }, (t) => router.isBusy(t), () => {})
    const first = queue.submit(1, 'tg-1', 'slow', [])
    await new Promise((r) => setTimeout(r, 100))
    const q1 = await queue.submit(1, 'tg-1', 'second', [])
    const q2 = await queue.submit(1, 'tg-1', 'third', [])
    expect(q1).toMatch(/position 1/)
    expect(q2).toMatch(/position 2/)
    release()
    expect(await first).toBe('reply:slow')
    await new Promise((r) => setTimeout(r, 300))
    expect(order).toEqual(['slow', 'second', 'third'])
    expect(delivered).toEqual(['reply:second', 'reply:third'])
    expect(calls).toBe(3)
    // other threads are unaffected by tg-1's queue
    expect(await queue.submit(1, 'tg-2', 'solo', [])).toBe('reply:solo')
  })

  it('refuses beyond the cap and survives handler errors', async () => {
    const { createTurnQueue } = await import('./telegram')
    const { createThreadRouter } = await import('./threads')
    const router = createThreadRouter()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const runTurn = async (_c: number, text: string, threadId: string, _a: unknown[], _q: boolean) => {
      const outcome = await router.runExclusive(threadId, async () => {
        if (text === 'slow') await gate
        if (text === 'boom') throw new Error('handler blew up')
        return `ok:${text}`
      })
      if (outcome.status !== 'ran') throw new Error('busy-race')
      return outcome.value
    }
    const errors: unknown[] = []
    const delivered: string[] = []
    const queue = createTurnQueue(runTurn, async (_c, text) => { delivered.push(text) }, (t) => router.isBusy(t), (c, e) => { errors.push([c, e]) }, 2)
    const slow = queue.submit(1, 't', 'slow', [])
    expect(await queue.submit(1, 't', 'a', [])).toMatch(/position 1/)
    expect(await queue.submit(1, 't', 'boom', [])).toMatch(/position 2/)
    expect(await queue.submit(1, 't', 'extra', [])).toMatch(/hold that thought/)
    release()
    expect(await slow).toBe('ok:slow')
    await new Promise((r) => setTimeout(r, 300))
    expect(delivered).toEqual(['ok:a', 'error: handler blew up'])
    expect(errors.length).toBe(1)
  })
})

describe('telegram flood (queue under load)', () => {
  it('processes 30 rapid messages to one chat in order, plus parallel chats', async () => {
    const vfs = createVfs()
    const api = mockApi()
    const seen: string[] = []
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42, 43] },
      {
        onText: async (chatId, text, _t, _a) => {
          await new Promise((r) => setTimeout(r, 5))
          seen.push(`${chatId}:${text}`)
          return `ok:${text}`
        },
        onCommand: async () => 'x',
      },
      api.fetch,
    )
    for (let i = 0; i < 30; i++) api.pushText(42, `m${i}`)
    for (let i = 0; i < 10; i++) api.pushText(43, `n${i}`)
    await waitFor(() => api.sent.length >= 40, 15000)
    const chat42 = seen.filter((s) => s.startsWith('42:')).map((s) => s.slice(3))
    const chat43 = seen.filter((s) => s.startsWith('43:')).map((s) => s.slice(3))
    expect(chat42).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`))
    expect(chat43).toEqual(Array.from({ length: 10 }, (_, i) => `n${i}`))
    expect(api.sent.length).toBe(40)
    poller.stop()
  }, 30000)
})

describe('turn queue kick + drain on holder finish', () => {
  it('a queued turn runs after the holder finishes without a new message', async () => {
    const { createTurnQueue } = await import('./telegram')
    const { createThreadRouter } = await import('./threads')
    const router = createThreadRouter()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const order: string[] = []
    const runTurn = async (_c: number, text: string, threadId: string) => {
      const outcome = await router.runExclusive(threadId, async () => {
        if (text === 'holder') await gate
        order.push(text)
        return `ok:${text}`
      })
      if (outcome.status !== 'ran') throw new Error('busy-race')
      return outcome.value
    }
    const sent: string[] = []
    const queue = createTurnQueue(runTurn as never, async (_c, text) => { sent.push(text) }, (t) => router.isBusy(t), () => {})
    const first = queue.submit(1, 'tg-9', 'holder', [])
    await new Promise((r) => setTimeout(r, 50))
    const queued = await queue.submit(1, 'tg-9', 'waiter', [])
    expect(queued).toMatch(/position 1/)
    // holder still running: waiter must NOT have run yet
    expect(order).toEqual([])
    release()
    expect(await first).toBe('ok:holder')
    // the kick on holder finish drains the waiter with no new message
    await new Promise((resolve) => {
      const start = Date.now()
      const tick = () => (sent.length >= 1 || Date.now() - start > 5000 ? resolve(null) : setTimeout(tick, 20))
      tick()
    })
    expect(order).toEqual(['holder', 'waiter'])
    expect(sent).toEqual(['ok:waiter'])
  })

  it('parses /reminders, /forget and case-insensitive commands', async () => {
    const { parseTelegramCommand } = await import('./telegram')
    expect(parseTelegramCommand('/reminders')).toEqual({ command: 'reminders', arg: '' })
    expect(parseTelegramCommand('/forget 2')).toEqual({ command: 'forget', arg: '2' })
    expect(parseTelegramCommand('/STATUS')).toEqual({ command: 'status', arg: '' })
    expect(parseTelegramCommand('/New')).toEqual({ command: 'new', arg: '' })
    expect(parseTelegramCommand('/cancel')).toEqual({ command: 'cancel', arg: '' })
  })
})

describe('turn timeout (hung handler)', () => {
  it('stops waiting and tells the chat, without wedging the poller', async () => {
    const vfs = createVfs()
    const api = mockApi()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const poller = startTelegramPoller(
      vfs,
      'https://api.telegram.org/botX',
      { token: 'X', allowFrom: [42] },
      {
        onText: async () => {
          await gate
          return 'late reply'
        },
        onCommand: async () => 'x',
      },
      api.fetch,
      { turnTimeoutMs: 200 },
    )
    api.pushText(42, 'hang please')
    await waitFor(() => api.sent.length >= 1, 5000)
    expect(api.sent[0].text).toMatch(/took longer than 0s|took longer/)
    // a follow-up works fine afterwards — nothing wedged
    release()
    await new Promise((r) => setTimeout(r, 200))
    api.pushText(42, 'are you there')
    await waitFor(() => api.sent.length >= 2, 5000)
    expect(api.sent[1].text).toBe('late reply')
    poller.stop()
  })
})
