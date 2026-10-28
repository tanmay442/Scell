/**
 * node:zlib shim for just-bash's browser bundle (its gzip/gunzip/zcat
 * commands). Backed by fflate — sync, pure JS, ~8 KB. Wired in through the
 * `node:zlib` alias in vite.config.ts for both dev and build.
 */
import { gunzipSync as fflateGunzip, gzipSync as fflateGzip } from 'fflate'

export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
}

export function gzipSync(data: Uint8Array, opts: { level?: number; maxOutputLength?: number } = {}): Uint8Array {
  const level = opts.level !== undefined && opts.level >= 0 && opts.level <= 9 ? (Math.round(opts.level) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) : undefined
  const out = fflateGzip(data, level !== undefined ? { level } : {})
  if (opts.maxOutputLength !== undefined && out.length > opts.maxOutputLength) {
    throw new Error(`zlib: gzip output ${out.length} exceeds maxOutputLength ${opts.maxOutputLength}`)
  }
  return out
}

export function gunzipSync(data: Uint8Array, opts: { maxOutputLength?: number } = {}): Uint8Array {
  const out = fflateGunzip(data)
  if (opts.maxOutputLength !== undefined && out.length > opts.maxOutputLength) {
    throw new Error(`zlib: gunzip output ${out.length} exceeds maxOutputLength ${opts.maxOutputLength}`)
  }
  return out
}
