import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { buildRunPayload } from './run'

describe('buildRunPayload', () => {
  it('packs text, binary and overrides into one transferable buffer', () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/a.js', 'console.log("a")\n')
    vfs.writeBytes('/home/user/project/logo.png', new Uint8Array([0x89, 0x50, 0x00, 0xff]))
    vfs.write('/home/user/project/.git/objects/pack/x.pack', 'ignored-by-hide')
    vfs.write('/home/user/empty.txt', '')

    const payload = buildRunPayload(
      vfs,
      ['/home/user/project/.git/objects/pack/x.pack'],
      { '/home/user/project/a.js': 'console.log("overridden")' },
    )

    const decoder = new TextDecoder('utf-8', { fatal: false })
    const files = new Map<string, string>()
    for (const [path, offset, length] of payload.index) {
      files.set(path, decoder.decode(payload.buffer.subarray(offset, offset + length)))
    }

    expect(files.get('/home/user/project/a.js')).toBe('console.log("overridden")')
    expect(files.get('/home/user/empty.txt')).toBe('')
    expect(files.get('/home/user/project/logo.png')).toBe('\uFFFDP\u0000\uFFFD') // lossy binary: only invalid bytes degrade
    expect(files.has('/home/user/project/.git/objects/pack/x.pack')).toBe(false)
    // one contiguous buffer, offsets tight
    expect(payload.buffer.byteLength).toBe(payload.index.reduce((sum, [, , length]) => sum + length, 0))
    let maxEnd = 0
    for (const [, offset, length] of payload.index) maxEnd = Math.max(maxEnd, offset + length)
    expect(maxEnd).toBe(payload.buffer.byteLength)
  })

  it('handles an empty workspace', () => {
    const payload = buildRunPayload(createVfs())
    expect(payload.index).toEqual([])
    expect(payload.buffer.byteLength).toBe(0)
  })
})
