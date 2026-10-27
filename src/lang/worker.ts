/// <reference lib="webworker" />
import { tsc } from './tsc-wasm/browser.js'
import type { TsRustDiagnostic } from './types'

const PROJECT = '/project'
const WASM_URL = '/wasm/ts_rust.wasm'

/** Shallowest user tsconfig (node_modules copies don't count). */
function findTsconfig(files: Record<string, string>): { path: string; synthesized: boolean } | null {
  const candidates = Object.keys(files)
    .filter((key) => key.endsWith('/tsconfig.json') && !key.includes('/node_modules/'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  if (candidates.length > 0) return { path: candidates[0], synthesized: false }
  return null
}

function tsconfigDir(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/'))
  return dir === '' ? '/' : dir
}

const FALLBACK_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM'],
      jsx: 'react-jsx',
      allowJs: true,
      skipLibCheck: true,
    },
    include: ['**/*'],
  },
  null,
  2,
)}\n`

interface CheckRequest {
  type: 'check'
  id: number
  files: Record<string, string>
}

interface TscRequest {
  type: 'tsc'
  id: number
  args: string[]
  files: Record<string, string>
}

type WorkerRequest = CheckRequest | TscRequest

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'check') {
    const files = { ...msg.files }
    const tsconfig = findTsconfig(files)
    if (!tsconfig) {
      files[`${PROJECT}/tsconfig.json`] = FALLBACK_TSCONFIG
    }
    const projectDir = tsconfig ? tsconfigDir(tsconfig.path) : PROJECT
    try {
      const result = await tsc(['-p', projectDir], {
        files,
        diagnostics: 'json',
        wasm: WASM_URL,
      })
      const response: { type: 'diagnostics'; id: number; diagnostics: TsRustDiagnostic[] } = {
        type: 'diagnostics',
        id: msg.id,
        diagnostics: result.diagnostics ?? [],
      }
      self.postMessage(response)
    } catch (err) {
      const response: { type: 'error'; id: number; message: string } = {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? `${err.message}${'stderr' in err ? `: ${(err as Error & { stderr: string }).stderr}` : ''}` : String(err),
      }
      self.postMessage(response)
    }
    return
  }
  if (msg.type === 'tsc') {
    try {
      const files = { ...msg.files }
      let runArgs = msg.args
      if (runArgs.length === 0) {
        // bare `tsc`: check the project whose tsconfig the workspace holds
        // (paths in the files map are /project-prefixed real VFS paths)
        const tsconfig = findTsconfig(files)
        if (tsconfig) {
          runArgs = ['-p', tsconfigDir(tsconfig.path)]
        } else {
          files[`${PROJECT}/tsconfig.json`] = FALLBACK_TSCONFIG
          runArgs = ['-p', PROJECT]
        }
      }
      const result = await tsc(runArgs, {
        files,
        diagnostics: 'json',
        wasm: WASM_URL,
      })
      self.postMessage({
        type: 'tsc-result',
        id: msg.id,
        exitCode: result.exitCode,
        diagnostics: result.diagnostics ?? [],
        files: [...(result.files ?? new Map<string, string>())] as [string, string][],
      })
    } catch (err) {
      self.postMessage({
        type: 'tsc-error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
