/// <reference lib="webworker" />
import { runPython, type PythonPayload } from './runner'

/**
 * The python runtime worker: loads Pyodide once (core from /vendor/pyodide,
 * data-science wheels on demand from the CDN via the lockfile), then serves
 * run requests with the same payload/write-back contract as the node
 * runtime. A wedged script is handled by the host: it terminates this
 * worker and reports a timeout.
 */

import { version as PYODIDE_VERSION } from 'pyodide/package.json'
/** wheels ALWAYS load relative to indexURL inside pyodide — so the primary
 * boot is the full CDN distribution (core + all data-science wheels). The
 * vendored copy under /vendor/pyodide/ is the offline fallback: a working
 * core whose packages are limited to micropip-installed pure wheels. */
const CDN_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
const LOCAL_INDEX_URL = '/vendor/pyodide/'

let pyodidePromise: Promise<any> | null = null

async function bootPyodide(indexURL: string): Promise<any> {
  // vite rewrites dynamic imports with a ?import suffix and then fails to
  // transform the vendor lib — fetch the source and import it as a blob
  const response = await fetch(`${indexURL}pyodide.mjs`)
  if (!response.ok) throw new Error(`pyodide loader fetch failed: ${response.status}`)
  const blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }))
  const module = await import(/* @vite-ignore */ blobUrl)
  return module.loadPyodide({
    indexURL,
    // pyodide's own diagnostics (fetch failures etc.) ride the status lane
    stdout: (text: string) => self.postMessage({ type: 'status', id: 0, text }),
    stderr: (text: string) => self.postMessage({ type: 'status', id: 0, text }),
  })
}

async function getPyodide(): Promise<any> {
  pyodidePromise ??= (async () => {
    try {
      return await bootPyodide(CDN_INDEX_URL)
    } catch (err) {
      self.postMessage({
        type: 'status',
        id: 0,
        text: `CDN unreachable (${err instanceof Error ? err.message : String(err)}) — booting the vendored core; data-science packages are unavailable until the CDN is reachable`,
      })
      return bootPyodide(LOCAL_INDEX_URL)
    }
  })().catch((err: unknown) => {
    pyodidePromise = null
    throw err
  })
  return pyodidePromise
}

interface RunRequest {
  type: 'run'
  id: number
  payload: PythonPayload
  code: string
  entry: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin?: Uint8Array
}

self.onmessage = async (event: MessageEvent<RunRequest>) => {
  const msg = event.data
  if (msg.type !== 'run') return
  try {
    const pyodide = await getPyodide()
    const result = await runPython(pyodide, {
      code: msg.code,
      entry: msg.entry,
      argv: msg.argv,
      cwd: msg.cwd,
      env: msg.env,
      payload: msg.payload,
      stdin: msg.stdin,
      onStatus: (text) => self.postMessage({ type: 'status', id: msg.id, text }),
      onOut: (stream, text) => self.postMessage({ type: 'out', id: msg.id, stream, text }),
    })
    for (const file of result.written) {
      self.postMessage({ type: 'vfs-write', id: msg.id, path: file.path, bytes: file.bytes }, [
        file.bytes.buffer as ArrayBuffer,
      ])
    }
    for (const path of result.deleted) {
      self.postMessage({ type: 'vfs-delete', id: msg.id, path })
    }
    self.postMessage({ type: 'exit', id: msg.id, code: result.exitCode })
  } catch (err) {
    self.postMessage({
      type: 'out',
      id: msg.id,
      stream: 'stderr',
      text: `python: ${err instanceof Error ? err.message : String(err)}\n`,
    })
    self.postMessage({ type: 'exit', id: msg.id, code: 1 })
  }
}
