import { describe, expect, it } from 'vitest'
import { redactSecrets, redactJson } from './agent-redact'

describe('key redaction', () => {
  it('masks Meta LLM_ keys', () => {
    expect(redactSecrets('Bearer LLM_abcdefgh12345678 ok')).not.toContain('LLM_abcdefgh12345678')
    expect(redactSecrets('key=LLM_abcdefgh12345678')).toContain('[redacted]')
  })

  it('masks anthropic and generic sk- keys', () => {
    expect(redactSecrets('sk-ant-abc123XYZ456')).toContain('[redacted]')
    expect(redactSecrets('sk-proj-abc123XYZ')).toContain('[redacted]')
  })

  it('masks Bearer tokens and JSON apiKey fields', () => {
    expect(redactSecrets('Authorization: Bearer tok1234567890')).toContain('Bearer …[redacted]')
    expect(redactSecrets('{"apiKey": "supersecretvalue"}')).toContain('…[redacted]')
    expect(redactSecrets('{"apiKey": "supersecretvalue"}')).not.toContain('supersecretvalue')
  })

  it('masks GitHub, Slack, AWS, Google and xAI tokens', () => {
    expect(redactSecrets('token ghp_1234567890abcdefghijklmnopqrstuvwxyz')).not.toContain('ghp_1234')
    expect(redactSecrets('token gho_1234567890abcdefghijklmnopqrstuvwxyz')).not.toContain('gho_1234')
    expect(redactSecrets('github_pat_abcdefghij1234567890')).not.toContain('github_pat_abc')
    expect(redactSecrets('xoxb-1234-abcdefg-hijkl')).not.toContain('xoxb-1234')
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redactSecrets('AIzaSyAbcdefgh1234567890')).not.toContain('AIzaSyAb')
    expect(redactSecrets('xai-abc123XYZ456')).not.toContain('xai-abc')
    // ordinary words with similar prefixes are untouched
    expect(redactSecrets('the ghouls gather')).toBe('the ghouls gather')
  })

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('hello world, no keys here')).toBe('hello world, no keys here')
  })

  it('redactJson walks objects and arrays', () => {
    const out = redactJson({ a: ['x LLM_abcdefgh12345678 y'], b: { c: 'sk-ant-abc123XYZ456' } })
    expect(JSON.stringify(out)).not.toContain('LLM_abcdefgh')
    expect(JSON.stringify(out)).not.toContain('sk-ant-abc')
  })
})

describe('telegram token redaction', () => {
  it('masks bot tokens and bot API URLs', () => {
    expect(redactSecrets('token 123456789:AAH-53YvVrCtQHWg5f5H3rpcc5P-RgFDkmQ end')).not.toContain('AAH-53YvVrCt')
    expect(redactSecrets('https://api.telegram.org/bot123456789:AAH-53YvVrCtQHWg5f5H3rpcc5P-RgFDkmQ/sendMessage')).not.toContain('AAH-')
    expect(redactSecrets('meet at 10:30 tomorrow')).toBe('meet at 10:30 tomorrow')
  })
})
