/// <reference lib="webworker" />
import { tsc } from './tsc-wasm/browser.js'
import type { TsRustDiagnostic } from './types'

const PROJECT = '/project'
const WASM_URL = '/wasm/ts_rust.wasm'

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

self.onmessage = async (event: MessageEvent<CheckRequest>) => {
  const msg = event.data
  if (msg.type !== 'check') return
  const files = { ...msg.files }
  if (!files[`${PROJECT}/tsconfig.json`]) {
    files[`${PROJECT}/tsconfig.json`] = FALLBACK_TSCONFIG
  }
  try {
    const result = await tsc(['-p', PROJECT], {
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
}
