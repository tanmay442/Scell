/**
 * AWS Signature Version 4 for S3-compatible object storage, on WebCrypto
 * only — no SDK. Signs method + path + query + headers + payload hash; the
 * host header is part of the signature but left to the browser to send.
 */

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return toHex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data) as unknown as ArrayBuffer))
}

export interface SigV4Params {
  method: string
  /** URI-encoded canonical path, e.g. /bucket/cell/snap.tar.gz */
  canonicalPath: string
  /** already URI-encoded, sorted query string without '?' (may be '') */
  canonicalQuery: string
  host: string
  /** hex sha256 of the payload ('' hashes the empty string) */
  payloadHash: string
  /** ISO basic, e.g. 20130524T000000Z */
  amzDate: string
  /** e.g. 20130524 */
  dateStamp: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
}

/** The SigV4 signing-key chain and final signature over a StringToSign. */
export async function deriveSignature(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
  stringToSign: string,
): Promise<string> {
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  return toHex(await hmac(kSigning, stringToSign))
}

/** The Authorization header value (also returns the signed x-amz headers). */
export async function signRequest(params: SigV4Params): Promise<{ authorization: string }> {
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders =
    `host:${params.host}\n` + `x-amz-content-sha256:${params.payloadHash}\n` + `x-amz-date:${params.amzDate}\n`
  const canonicalRequest = [
    params.method,
    params.canonicalPath,
    params.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join('\n')
  const scope = `${params.dateStamp}/${params.region}/${params.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', params.amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')
  const signature = await deriveSignature(params.secretAccessKey, params.dateStamp, params.region, params.service, stringToSign)
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
}

/** uri-encode per AWS rules (everything but A-Za-z0-9-._~) */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let out = ''
  for (const ch of value) {
    if (/[A-Za-z0-9-._~]/.test(ch)) out += ch
    else if (ch === '/' && !encodeSlash) out += ch
    else out += [...encoder.encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  }
  return out
}

export async function s3Fetch(
  config: S3Config,
  method: string,
  key: string,
  options: { body?: Uint8Array; query?: Record<string, string>; contentType?: string } = {},
): Promise<Response> {
  const base = config.endpoint.replace(/\/+$/, '')
  const host = new URL(base).host
  const prefix = config.prefix ?? 'cell/'
  const fullKey = key === '' ? prefix : `${prefix}${key}`
  const path = `/${config.bucket}/${fullKey}`
    .split('/')
    .map((segment, i) => (i === 0 ? segment : awsUriEncode(segment, false)))
    .join('/')
  const queryEntries = Object.entries(options.query ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const canonicalQuery = queryEntries
    .map(([name, value]) => `${awsUriEncode(name)}=${awsUriEncode(value)}`)
    .join('&')
  const now = new Date()
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array(0))
  const { authorization } = await signRequest({
    method,
    canonicalPath: path,
    canonicalQuery,
    host,
    payloadHash,
    amzDate,
    dateStamp,
    region: config.region,
    service: 's3',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })
  const url = `${base}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`
  const headers: Record<string, string> = {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  }
  if (options.contentType) headers['Content-Type'] = options.contentType
  return fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : (options.body as unknown as BodyInit),
  })
}
