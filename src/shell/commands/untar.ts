/**
 * Minimal POSIX tar reader for npm tarballs: regular files, directories and
 * pax extended headers (npm uses pax for long paths). Everything else
 * (hardlinks, symlinks, devices) is skipped — package tarballs don't carry
 * them, and executing one would be a supply-chain hazard anyway.
 */

export interface TarEntry {
  path: string
  data: Uint8Array
  mode: number
  type: 'file' | 'dir'
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset + length
  for (let i = offset; i < offset + length; i++) {
    if (block[i] === 0) {
      end = i
      break
    }
  }
  let out = ''
  for (let i = offset; i < end; i++) out += String.fromCharCode(block[i])
  return out
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  if (text === '') return 0
  // GNU base-256 encoding for huge values: high bit of first byte set
  if (block[offset] & 0x80) {
    let value = 0
    for (let i = offset + 1; i < offset + length; i++) {
      if (block[i] === 0) break
      value = value * 256 + block[i]
    }
    return value
  }
  return parseInt(text, 8)
}

export function untar(buffer: Uint8Array, options?: { stripFirstSegment?: boolean }): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let paxPath: string | null = null

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // end-of-archive

    const name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)
    const typeFlag = String.fromCharCode(header[156] || 0x30)
    const prefix = readString(header, 345, 155)
    const magic = readString(header, 257, 6)

    let path = magic.startsWith('ustar') && prefix ? `${prefix}/${name}` : name
    offset += 512

    if (typeFlag === 'x' || typeFlag === 'g') {
      // pax extended header: parse "len key=value\n" records for path
      const data = buffer.subarray(offset, offset + size)
      const text = new TextDecoder('latin1').decode(data)
      for (const match of text.matchAll(/(\d+) ([^=]+)=([^\n]*)\n/g)) {
        if (match[2] === 'path') paxPath = match[3]
      }
      offset += Math.ceil(size / 512) * 512
      continue
    }

    if (paxPath !== null) {
      path = paxPath
      paxPath = null
    }

    // npm strips the tarball's first segment (package/, or the @types name);
    // workspace snapshots carry absolute paths and must keep them
    const clean = options?.stripFirstSegment === true
      ? path.replace(/^\.\//, '').split('/').slice(1).join('/')
      : path.replace(/^\.\//, '')

    if (typeFlag === '0' || typeFlag === '7' || typeFlag === '\0') {
      const data = buffer.subarray(offset, offset + size)
      if (clean) {
        entries.push({ path: clean, data: new Uint8Array(data), mode, type: 'file' })
      }
    } else if (typeFlag === '5') {
      // directories are implied by file paths in the VFS; nothing to do
    }
    // '1' hardlink, '2' symlink, others: deliberately unsupported

    offset += Math.ceil(size / 512) * 512
  }

  return entries
}

/** Tar writer for tests — produces the same format the reader accepts. */
export function tarForTest(entries: { path: string; data?: Uint8Array; type?: 'file' | 'dir' }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  const checknum = (n: number) => n.toString(8).padStart(6, '0') + '\0 '
  const writeHeader = (name: string, size: number, typeFlag: string, mode: number) => {
    const header = new Uint8Array(512)
    const put = (text: string, offset: number, length: number) => {
      for (let i = 0; i < text.length && i < length; i++) header[offset + i] = text.charCodeAt(i)
    }
    put(`package/${name}`, 0, 100)
    put(mode.toString(8).padStart(7, '0') + '\0', 100, 8)
    put(size.toString(8).padStart(11, '0') + ' ', 124, 12)
    put('ustar\0' + '00', 257, 8)
    header[156] = typeFlag.charCodeAt(0)
    // checksum is the byte sum with the checksum field itself counted as spaces
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    put(checknum(checksum), 148, 8)
    blocks.push(header)
  }
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0)
    writeHeader(entry.path, data.byteLength, entry.type === 'dir' ? '5' : '0', 0o644)
    if (data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
      padded.set(data)
      blocks.push(padded)
    }
  }
  blocks.push(new Uint8Array(1024))
  let total = 0
  for (const block of blocks) total += block.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.byteLength
  }
  return out
}

/**
 * Tar writer for whole-workspace snapshots: absolute VFS paths, arbitrary
 * bytes. Long paths (>100 chars) go through pax extended headers, the same
 * mechanism npm tarballs use — our reader supports both.
 */
export function tarFiles(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  const checknum = (n: number) => n.toString(8).padStart(6, '0') + '\0 '
  const writeHeader = (name: string, size: number, typeFlag: string, paxName?: string) => {
    const header = new Uint8Array(512)
    const put = (text: string, offset: number, length: number) => {
      for (let i = 0; i < text.length && i < length; i++) header[offset + i] = text.charCodeAt(i)
    }
    put(name.slice(0, 100), 0, 100)
    put('0000644\0', 100, 8)
    put('0000000\0', 108, 8)
    put('0000000\0', 116, 8)
    put(size.toString(8).padStart(11, '0') + '\0', 124, 12)
    put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12)
    put('        ', 148, 8)
    put('ustar\0' + '00', 257, 8)
    header[156] = typeFlag.charCodeAt(0)
    if (paxName !== undefined) {
      // pax record: "<len> path=<name>\n" — len counts the whole record
      // including its own digits; find the fixed point (always exists)
      let text = ''
      for (let len = paxName.length + 10; len < paxName.length + 30; len++) {
        text = `${len} path=${paxName}\n`
        if (text.length === len) break
      }
      const padded = new Uint8Array(Math.ceil(text.length / 512) * 512)
      for (let i = 0; i < text.length; i++) padded[i] = text.charCodeAt(i)
      writeHeader('././@PaxHeader', text.length, 'x')
      blocks.push(padded)
    }
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    put(checknum(checksum), 148, 8)
    blocks.push(header)
  }
  for (const file of files) {
    if (file.path.length > 100) writeHeader(file.path.slice(-99), file.data.byteLength, '0', file.path)
    else writeHeader(file.path, file.data.byteLength, '0')
    if (file.data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(file.data.byteLength / 512) * 512)
      padded.set(file.data)
      blocks.push(padded)
    }
  }
  blocks.push(new Uint8Array(1024))
  let total = 0
  for (const block of blocks) total += block.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.byteLength
  }
  return out
}
