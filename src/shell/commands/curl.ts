import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import type { CommandResult } from './npm'

/**
 * `curl` — just-bash's browser build ships no curl, so Cell provides one on
 * fetch: methods, headers, bodies, timeouts, -o downloads (binary-safe into
 * the VFS). Cross-origin rules are the browser's; failures say so honestly.
 */

interface CurlOptions {
  silent: boolean
  includeHeaders: boolean
  method: string
  headers: Record<string, string>
  data?: string
  output?: string
  maxTime: number
}

function parseArgs(args: string[], cwd: string): { options: CurlOptions; url: string } | { error: string } {
  const options: CurlOptions = {
    silent: false,
    includeHeaders: false,
    method: 'GET',
    headers: {},
    maxTime: 30,
  }
  let url = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-s' || arg === '--silent') options.silent = true
    else if (arg === '-i' || arg === '--include') options.includeHeaders = true
    else if (arg === '-X' || arg === '--request') options.method = args[++i] ?? ''
    else if (arg === '-H' || arg === '--header') {
      const header = args[++i] ?? ''
      const idx = header.indexOf(':')
      if (idx > 0) options.headers[header.slice(0, idx).trim()] = header.slice(idx + 1).trim()
    } else if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-binary') {
      options.data = args[++i] ?? ''
      if (options.method === 'GET') options.method = 'POST'
      if (!Object.keys(options.headers).some((name) => name.toLowerCase() === 'content-type')) {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i]
    } else if (arg === '--max-time' || arg === '-m') {
      const seconds = parseInt(args[++i] ?? '', 10)
      if (Number.isFinite(seconds) && seconds > 0) options.maxTime = seconds
    } else if (arg === '-L' || arg === '--location' || arg === '-f' || arg === '--fail' || arg === '--compressed') {
      // fetch follows redirects, and status handling is curl's own
    } else if (arg.startsWith('-')) {
      return { error: `curl: unsupported option ${arg}\n` }
    } else {
      url = url || arg
    }
  }
  if (!url) return { error: 'curl: try \'curl <url>\'\n' }
  if (options.output) options.output = vfsPath.normalize(`${cwd}/${options.output}`)
  return { options, url }
}

export async function curlCommand(vfs: Vfs, args: string[], opts: { cwd: string }): Promise<CommandResult> {
  const parsed = parseArgs(args, opts.cwd)
  if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 }

  const { options, url } = parsed
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.data === undefined ? undefined : options.data,
      signal: AbortSignal.timeout(options.maxTime * 1000),
    })
  } catch (err) {
    const reason =
      err instanceof Error && /timeout/i.test(err.name) ? 'request timed out' : 'network/CORS failure — the browser can only reach origins that allow it'
    return { stdout: '', stderr: `curl: (1) ${reason}: ${url}\n`, exitCode: 1 }
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (options.output) {
    vfs.writeBytes(options.output, bytes)
    const header = options.includeHeaders ? `${statusLine(response)}\n` : ''
    return { stdout: `${header}`, stderr: '', exitCode: response.ok ? 0 : 0 }
  }

  const contentType = response.headers.get('content-type') ?? ''
  const isText = /^text\/|json|javascript|xml|urlencoded|^application\/(yaml|toml)/i.test(contentType) || bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) || bytes.length === 0
  const body = isText
    ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    : `${bytes.byteLength} bytes (binary) — use -o <file> to save`
  const head = options.includeHeaders
    ? `${statusLine(response)}\n${[...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n`
    : ''
  return { stdout: head + body, stderr: '', exitCode: 0 }
}

function statusLine(response: Response): string {
  return `HTTP/1.1 ${response.status} ${response.statusText}`
}
