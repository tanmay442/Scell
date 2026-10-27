import type { Vfs } from '../vfs/types'
import { runNodeProcess } from '../node/run'
import { transpileEsmJs } from '../node/transform'
import { vfsPath } from '../vfs/types'

/**
 * Executes Vercel-style serverless functions (api/*.js, ESM,
 * `export default (req, res) => {}`) inside the node sandbox, one process per
 * request — the same isolation model real serverless uses. The function is
 * transpiled ESM→CommonJS through ts-rust first; its dependencies resolve
 * from the project's node_modules like any node program here.
 */

export interface ApiRequest {
  method: string
  path: string
  /** raw request body, if any */
  body: string | null
}

export interface ApiResponse {
  status: number
  contentType: string
  body: string
}

const driverPath = (projectDir: string) => `${projectDir}/.cell-build/__driver.js`
const MARKER = '__CELL_API_RESULT__'

function driverSource(entry: string, request: ApiRequest): string {
  const query: Record<string, string> = {}
  const qIndex = request.path.indexOf('?')
  if (qIndex >= 0) {
    for (const pair of request.path.slice(qIndex + 1).split('&')) {
      const [key, value = ''] = pair.split('=')
      if (key) query[decodeURIComponent(key)] = decodeURIComponent(value)
    }
  }
  return `
const mod = require(${JSON.stringify(entry)})
const handler = mod.default ?? mod
if (typeof handler !== 'function') {
  console.error(${JSON.stringify(`${vfsPath.basename(entry)}: no default export function`)})
  process.exit(1)
}
const req = {
  method: ${JSON.stringify(request.method)},
  url: ${JSON.stringify(request.path)},
  query: ${JSON.stringify(query)},
  headers: { 'content-type': 'application/json' },
  body: ${JSON.stringify(request.body)},
}
let status = 200
let contentType = 'application/json'
let done = ''
const res = {
  status(code) { status = code; return res },
  setHeader(name, value) { if (String(name).toLowerCase() === 'content-type') contentType = value; return res },
  json(payload) { done = JSON.stringify(payload); },
  send(text) { done = String(text); },
  end(text) { if (text !== undefined && text !== null) done += String(text) },
}
Promise.resolve()
  .then(() => handler(req, res))
  .catch((err) => {
    status = 500
    done = JSON.stringify({ error: err && err.message ? err.message : String(err) })
  })
  .then(() => {
    console.log(${JSON.stringify(MARKER)} + JSON.stringify({ status, contentType, body: done }))
  })
`
}

/** Run one api function call. Returns null when the function doesn't exist. */
export async function runApiFunction(
  vfs: Vfs,
  projectDir: string,
  request: ApiRequest,
): Promise<ApiResponse | { error: string }> {
  const cleanPath = request.path.split('?')[0].replace(/\/+$/, '')
  const apiFile = `${projectDir}${cleanPath}.js`
  if (!vfs.isFile(apiFile)) {
    return { error: `no function at ${cleanPath}.js` }
  }

  const transform = await transpileEsmJs(vfs, apiFile)
  if (!transform.ok) {
    return { error: transform.errorText ?? `could not load ${apiFile}` }
  }

  const driver = driverSource(transform.entry, request)
  const result = await runNodeProcess(
    vfs,
    {
      entry: driverPath(projectDir),
      argv: [],
      cwd: projectDir,
      timeoutMs: 90_000,
      filesOverride: { ...transform.emitted, [driverPath(projectDir)]: driver },
    },
  )

  const markerAt = result.stdout.lastIndexOf(MARKER)
  if (markerAt === -1) {
    const why = result.stderr.trim().split('\n').slice(0, 3).join(' | ') || `exit ${result.exitCode}`
    return { error: `${vfsPath.basename(apiFile)} failed: ${why}` }
  }
  try {
    const parsed = JSON.parse(result.stdout.slice(markerAt + MARKER.length)) as ApiResponse
    return parsed
  } catch {
    return { error: `${vfsPath.basename(apiFile)} returned a malformed response` }
  }
}
