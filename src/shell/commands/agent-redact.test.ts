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

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('hello world, no keys here')).toBe('hello world, no keys here')
  })

  it('redactJson walks objects and arrays', () => {
    const out = redactJson({ a: ['x LLM_abcdefgh12345678 y'], b: { c: 'sk-ant-abc123XYZ456' } })
    expect(JSON.stringify(out)).not.toContain('LLM_abcdefgh')
    expect(JSON.stringify(out)).not.toContain('sk-ant-abc')
  })
})
