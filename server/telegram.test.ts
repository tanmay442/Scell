import { describe, expect, it } from 'vitest'
import { createVfs } from '../src/vfs/vfs'
import {
  chunkTelegramMessage,
  createTelegramApi,
  deliverDueReminders,
  loadTelegramConfig,
  parseTelegramCommand,
  startTelegramPoller,
  telegramThreadFor,
  type TelegramFetch,
} from './telegram'
import { addReminder } from '../src/shell/commands/agent-reminders'

/** Fake Bot API: queued updates in, sent messages out. */
function mockApi() {
  const updates: Array<{ update_id: number; message?: { chat?: { id: number; type: string }; type?: string; text?: string; from?: { id: number } } }> = []
  const sent: Array<{ chatId: number; text: string }> = []
  let nextId = 1
  const fetch: TelegramFetch = async (url, init) => {
    const body = init?.body !== undefined ? (JSON.parse(init.body) as { offset?: number; chat_id?: number; text?: string }) : {}
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
    if (url.endsWith('/sendChatAction')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    throw new Error(`unexpected ${url}`)
  }
  return {
    fetch,
    sent,
    updates,
    pushText: (chatId: number, text: string, type = 'private') => {
      updates.push({ update_id: nextId++, message: { chat: { id: chatId, type }, text } })
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
