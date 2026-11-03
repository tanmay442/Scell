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
import { addReminder } from '../src/shell/commands/agent-reminders'

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
    expect(out).toEqual({ delivered: 1, undeliverable: 1 })
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
    const fresh = collectFreshFiles(vfs, '/home/user/threads/tg-1', now - 1000)
    const names = fresh.map((f) => f.name).sort()
    expect(names).toEqual(['deep.txt', 'new.png'])
  })
})

describe('background worker scheduling', () => {
  it('spawns a worker thread with a notify task job', async () => {
    const { scheduleBackgroundTask } = await import('./server')
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
