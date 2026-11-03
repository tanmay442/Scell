import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import {
  allRecipientsAllowed,
  isAllowedRecipient,
  parseEmailAddresses,
  GmailApi,
} from './agent-gmail'
import { runTool } from './agent-tools'

function vfsWithGmailConfig(config: Record<string, unknown>) {
  const vfs = createVfs()
  vfs.write('/home/user/.cell/connectors/gmail.json', JSON.stringify(config))
  return vfs
}

describe('gmail allowlist', () => {
  it('parses comma lists with display names', () => {
    expect(parseEmailAddresses('Name <allowed@example.com>, attacker@evil.com')).toEqual([
      'allowed@example.com',
      'attacker@evil.com',
    ])
  })

  it('single-address primitive is exact or @domain', () => {
    expect(isAllowedRecipient('user@example.com', ['user@example.com'])).toBe(true)
    expect(isAllowedRecipient('user@example.com', ['@example.com'])).toBe(true)
    expect(isAllowedRecipient('user@notexample.com', ['@example.com'])).toBe(false)
    expect(isAllowedRecipient('user@evil.com', [])).toBe(false)
  })

  it('multi-recipient bypass is closed: every address must be allowed', () => {
    const allowed = ['@example.com']
    const checked = allRecipientsAllowed('allowed@example.com, attacker@evil.com', '', '', allowed)
    expect(checked.ok).toBe(false)
  })

  it('cc and bcc are checked, not just to', () => {
    const allowed = ['good@example.com']
    const toOnly = allRecipientsAllowed('good@example.com', 'evil@x.com', '', allowed)
    expect(toOnly.ok).toBe(false)
    const bccOnly = allRecipientsAllowed('good@example.com', '', 'evil@x.com', allowed)
    expect(bccOnly.ok).toBe(false)
  })

  it('empty recipient set refuses', () => {
    expect(allRecipientsAllowed('', '', '', ['a@b.com']).ok).toBe(false)
  })
})

describe('gmail draft injection', () => {
  it('createDraft rejects CRLF in to/subject', async () => {
    const api = new GmailApi(
      { clientId: 'x', clientSecret: 'y', refreshToken: 'z' },
      async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    )
    await expect(api.createDraft('a@b.com\r\nBcc: evil@x.com', 'hi', 'body')).rejects.toThrow(/CRLF/)
    await expect(api.createDraft('a@b.com', 'hi\r\nBcc: evil@x.com', 'body')).rejects.toThrow(/CRLF/)
  })
})

describe('gmail_send gates', () => {
  const shell = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }

  function mockGmail(toHeader: string, cc = '', bcc = '') {
    return {
      getDraft: async () => ({
        message: {
          payload: {
            headers: [
              { name: 'To', value: toHeader },
              { name: 'Cc', value: cc },
              { name: 'Bcc', value: bcc },
            ],
          },
        },
      }),
      sendDraft: async () => ({ id: 'sent-1' }),
    }
  }

  it('refuses when draftsOnly is true (default)', async () => {
    const vfs = vfsWithGmailConfig({ enabled: true, allowSendTo: ['good@example.com'] })
    const result = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: mockGmail('good@example.com') as never },
      { id: 'c1', name: 'gmail_send', input: { draftId: 'd1' } },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/drafts-only/)
  })

  it('refuses when connector disabled', async () => {
    const vfs = vfsWithGmailConfig({ enabled: false, draftsOnly: false, allowSendTo: ['good@example.com'] })
    const result = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: mockGmail('good@example.com') as never },
      { id: 'c1', name: 'gmail_send', input: { draftId: 'd1' } },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/disabled/)
  })

  it('refuses unlisted cc even when to is allowed', async () => {
    const vfs = vfsWithGmailConfig({ enabled: true, draftsOnly: false, allowSendTo: ['good@example.com'] })
    const result = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: mockGmail('good@example.com', 'evil@x.com') as never },
      { id: 'c1', name: 'gmail_send', input: { draftId: 'd1' } },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not on the connector allowlist/)
  })

  it('sends when every recipient is allowlisted and gates pass', async () => {
    const vfs = vfsWithGmailConfig({ enabled: true, draftsOnly: false, allowSendTo: ['@example.com'] })
    const result = await runTool(
      {
        vfs,
        shell,
        cwd: '/home/user',
        skills: new Map(),
        gmail: mockGmail('a@example.com', 'b@example.com') as never,
      },
      { id: 'c1', name: 'gmail_send', input: { draftId: 'd1' } },
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/sent/)
  })

  it('gmail_draft rejects CRLF and returns exact text', async () => {
    const vfs = createVfs()
    const gmail = {
      createDraft: async () => ({ id: 'draft-1' }),
    }
    const bad = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: gmail as never },
      { id: 'c1', name: 'gmail_draft', input: { to: 'a@b.com\r\nBcc: x', subject: 'hi', body: 'b' } },
    )
    expect(bad.isError).toBe(true)
    const good = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: gmail as never },
      { id: 'c2', name: 'gmail_draft', input: { to: 'a@b.com', subject: 'hello', body: 'world' } },
    )
    expect(good.content).toMatch(/To: a@b\.com/)
    expect(good.content).toMatch(/world/)
  })

  it('gmail_search rejects empty query', async () => {
    const vfs = createVfs()
    const gmail = { listMessages: async () => ({ messages: [] }) }
    const result = await runTool(
      { vfs, shell, cwd: '/home/user', skills: new Map(), gmail: gmail as never },
      { id: 'c1', name: 'gmail_search', input: { query: '   ' } },
    )
    expect(result.isError).toBe(true)
  })
})
