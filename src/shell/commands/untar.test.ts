import { describe, expect, it } from 'vitest'
import { gzipSync, gunzipSync } from 'fflate'
import { untar, tarForTest } from './untar'
import { pickVersion, type RegistryMetadata } from './registry'

describe('untar', () => {
  it('round-trips files and directories through our tar writer and reader', () => {
    const fileA = new TextEncoder().encode('console.log("a")\n')
    const fileB = new Uint8Array([0, 1, 2, 255, 254, 253]) // binary must survive exactly
    const tar = tarForTest([
      { path: 'index.js', data: fileA },
      { path: 'assets/logo.bin', data: fileB },
      { path: 'empty' },
    ])
    const entries = untar(tar)
    const byPath = new Map(entries.map((e) => [e.path, e]))
    expect(byPath.get('index.js')?.type).toBe('file')
    expect(new TextDecoder().decode(byPath.get('index.js')!.data)).toBe('console.log("a")\n')
    const round = byPath.get('assets/logo.bin')!.data
    expect([...round]).toEqual([0, 1, 2, 255, 254, 253])
    expect(byPath.get('empty')?.data.byteLength).toBe(0)
  })

  it('parses npm-style tarballs after gunzip', () => {
    const tar = tarForTest([{ path: 'package.json', data: new TextEncoder().encode('{"name":"x"}') }])
    const tgz = gzipSync(tar)
    const entries = untar(gunzipSync(tgz))
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('package.json')
  })

  it('handles multi-block files exactly at block boundaries', () => {
    const big = new Uint8Array(1024)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const entries = untar(tarForTest([{ path: 'big.bin', data: big }]))
    expect(entries[0].data.byteLength).toBe(1024)
    expect(entries[0].data[1023]).toBe(big[1023])
  })
})

describe('pickVersion', () => {
  const metadata: RegistryMetadata = {
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '1.0.0': { version: '1.0.0', dist: { tarball: 'a' } },
      '1.2.3': { version: '1.2.3', dist: { tarball: 'b' } },
      '1.9.0': { version: '1.9.0', dist: { tarball: 'c' } },
      '2.0.0': { version: '2.0.0', dist: { tarball: 'd' } },
      '2.1.0-beta.1': { version: '2.1.0-beta.1', dist: { tarball: 'e' } },
    },
  }

  it('latest by default', () => {
    expect(pickVersion(metadata).version).toBe('2.0.0')
  })

  it('caret range picks the newest satisfying stable', () => {
    expect(pickVersion(metadata, '^1.0.0').version).toBe('1.9.0')
    expect(pickVersion(metadata, '~1.2.0').version).toBe('1.2.3')
    expect(pickVersion(metadata, '>=1.0.0 <2').version).toBe('1.9.0')
  })

  it('exact version', () => {
    expect(pickVersion(metadata, '1.2.3').version).toBe('1.2.3')
    expect(() => pickVersion(metadata, '9.9.9')).toThrow(/no matching version/i)
  })

  it('prereleases only when the range asks', () => {
    expect(pickVersion(metadata, '^2.0.0').version).toBe('2.0.0')
    expect(pickVersion(metadata, '>=2.0.0-0').version).toBe('2.1.0-beta.1')
  })
})
