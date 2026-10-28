import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { VfsBackedFs } from './vfs-fs'

/** P1-4: >> on binaries must round-trip exactly, not corrupt via lossy UTF-8 */
describe('vfs-fs appendFile', () => {
  it('appends bytes to binaries without corruption', async () => {
    const vfs = createVfs()
    const fs = new VfsBackedFs(vfs)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])
    await fs.writeFile('/img.bin', png)
    await fs.appendFile('/img.bin', new Uint8Array([0x00, 0x01, 0x80, 0xff]))
    expect(vfs.readBytes('/img.bin')).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01, 0x80, 0xff]),
    )
  })

  it('appends text to text files so read() keeps working', async () => {
    const vfs = createVfs()
    const fs = new VfsBackedFs(vfs)
    await fs.writeFile('/note.txt', 'hello')
    await fs.appendFile('/note.txt', ' world')
    expect(vfs.read('/note.txt')).toBe('hello world')
  })
})
