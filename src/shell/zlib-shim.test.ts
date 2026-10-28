import { describe, expect, it } from 'vitest'
import { gunzipSync, gzipSync } from './zlib-shim'

describe('zlib caps (P1-11)', () => {
  it('round-trips small payloads', () => {
    const data = new TextEncoder().encode('hello cell')
    expect(gunzipSync(gzipSync(data))).toEqual(data)
  })

  it('enforces maxOutputLength on gunzip', () => {
    const data = new TextEncoder().encode('x'.repeat(1000))
    const zipped = gzipSync(data)
    expect(() => gunzipSync(zipped, { maxOutputLength: 10 })).toThrow(/maxOutputLength/)
    expect(gunzipSync(zipped, { maxOutputLength: 1000 })).toEqual(data)
  })

  it('enforces maxOutputLength on gzip', () => {
    const data = new TextEncoder().encode('x'.repeat(1000))
    expect(() => gzipSync(data, { maxOutputLength: 1 })).toThrow(/maxOutputLength/)
  })
})
