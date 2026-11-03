import { describe, expect, it } from 'vitest'
import { createVfs } from '../src/vfs/vfs'
import { saveSession } from '../src/shell/commands/agent-sessions'
import { listThreads, readThread } from './threads-read'

function seed(vfs: ReturnType<typeof createVfs>) {
  vfs.mkdir('/home/user/threads/tg-42')
  vfs.mkdir('/home/user/threads/tg-42-wabc123')
  vfs.mkdir('/home/user/threads/agent-plain')
  vfs.write('/home/user/threads/tg-42/notes.txt', 'hi')
  saveSession(vfs, {
    id: 'agent-aaa',
    startedAt: '2026-01-01T00:00:00.000Z',
    provider: 'meta',
    model: 'm',
    prompt: 'hello',
    transcript: ['agent ▸ hello', 'model: x', 'hi there'],
    turns: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi there' }],
    steps: 1,
    title: 'Hello chat',
  })
  vfs.write('/home/user/.cell/sessions/agent-aaa.thread', 'tg-42\n')
  // sidecar without a session file: listed, no crash
  vfs.write('/home/user/.cell/sessions/agent-ghost.thread', 'tg-42-wabc123\n')
}

describe('threads-read', () => {
  it('lists telegram, worker and run threads with kinds', () => {
    const vfs = createVfs()
    seed(vfs)
    const listed = listThreads(vfs)
    if ('error' in listed) throw new Error('unexpected error')
    const summaries: import('./threads-read').ThreadSummary[] = listed
    expect(summaries.map((t) => [t.threadId, t.kind])).toEqual([
      ['agent-plain', 'run'],
      ['tg-42', 'telegram'],
      ['tg-42-wabc123', 'worker'],
    ])
    const tg = summaries.find((t) => t.threadId === 'tg-42')!
    expect(tg.sessionId).toBe('agent-aaa')
    expect(tg.title).toBe('Hello chat')
    expect(tg.messages).toBe(2)
    const worker = summaries.find((t) => t.threadId === 'tg-42-wabc123')!
    expect(worker.sessionId).toBeNull()
    expect((() => { const l = listThreads(vfs, ['tg-42']); if ('error' in l) throw new Error('x'); return l })().find((t) => 'busy' in t && t.threadId === 'tg-42')).toMatchObject({ busy: true })
  })

  it('reads transcripts capped with receipt, plus newest-first files', () => {
    const vfs = createVfs()
    seed(vfs)
    vfs.write('/home/user/threads/tg-42/uploads/a.pdf', 'x'.repeat(10))
    const detail = readThread(vfs, 'tg-42')
    if ('error' in detail || 'code' in detail) throw new Error('unexpected error')
    expect(detail.transcript[0]).toBe('hi there')
    expect(detail.files.map((f) => f.name).sort()).toEqual(['notes.txt', 'uploads/a.pdf'])
    expect(detail.foldersTruncated).toBe(false)
  })

  it('rejects bad ids and missing workspaces with HTTP codes', () => {
    const vfs = createVfs()
    seed(vfs)
    expect(readThread(vfs, '../x')).toEqual({ error: expect.any(String), code: 400 })
    expect(readThread(vfs, 'tg-nope')).toEqual({ error: expect.any(String), code: 410 })
    expect(readThread(createVfs(), 'tg-42')).toEqual({ error: expect.any(String), code: 410 })
  })
})
