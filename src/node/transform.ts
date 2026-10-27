import type { Vfs } from '../vfs/types'
import { langService } from '../lang/service'
import type { TsRustDiagnostic } from '../lang/types'
import { vfsPath } from '../vfs/types'

const TS_EXTS = new Set(['ts', 'tsx', 'mts', 'cts'])

export function isTypeScript(path: string): boolean {
  return TS_EXTS.has(vfsPath.ext(path))
}

export interface TransformResult {
  ok: boolean
  /** entry after transform (a .js path) */
  entry: string
  /** emitted js files keyed by VFS path */
  emitted: Record<string, string>
  /** original ts paths to hide from the sandbox */
  hidden: string[]
  /** formatted diagnostics if the transform produced nothing usable */
  errorText?: string
}

function formatDiagnostics(diags: TsRustDiagnostic[]): string {
  const lines: string[] = []
  let errors = 0
  for (const d of diags) {
    if (d.category !== 1) continue
    errors++
    const pos = d.startPosition ? `(${d.startPosition.line + 1},${d.startPosition.character + 1})` : ''
    const file = d.fileName ? d.fileName.replace(/^\/project/, '') : ''
    lines.push(`${file}${pos}: error TS${d.code}: ${d.text}`)
  }
  if (errors === 0 && diags.length > 0) {
    return `tsc: ${diags.length} diagnostic(s), none blocking emit`
  }
  return errors > 0 ? `${lines.join('\n')}\n\n${errors} error${errors === 1 ? '' : 's'} while transforming` : ''
}

/**
 * TS → CommonJS via ts-rust (the Rust tsc, in WASM). Node-style transpile:
 * diagnostics never block execution — if emit produced output we run it,
 * exactly like ts-node's transpile-only mode.
 */
export async function transformEntry(vfs: Vfs, entry: string): Promise<TransformResult> {
  const service = langService()
  if (!service) {
    return { ok: false, entry, emitted: {}, hidden: [], errorText: 'node: language service not started' }
  }
  // nodenext: with no "type": "module" in package.json every .ts is CJS
  // mode — extensionless relative imports allowed, emit is require() calls.
  // rootDir is pinned so the emitted tree mirrors the project 1:1.
  const result = await service.tscRun([
    `/project${entry}`,
    '--outDir',
    '/__emit',
    '--rootDir',
    '/project',
    '--module',
    'nodenext',
    '--target',
    'ES2020',
    '--esModuleInterop',
    '--skipLibCheck',
  ])

  const emitted: Record<string, string> = {}
  for (const [path, content] of result.files) {
    if (!path.startsWith('/__emit/')) continue
    const rel = path.slice('/__emit/'.length)
    const jsPath = `/${rel.replace(/\.(ts|tsx|mts|cts)$/, '.js')}`
    emitted[jsPath] = content
  }

  const jsEntry = entry.replace(/\.(ts|tsx|mts|cts)$/, '.js')
  if (emitted[jsEntry] === undefined) {
    return {
      ok: false,
      entry: jsEntry,
      emitted,
      hidden: [],
      errorText: formatDiagnostics(result.diagnostics) || `node: could not transform '${entry}' (tsc exit ${result.exitCode})`,
    }
  }

  const hidden = vfs.listAllFiles().filter((p) => TS_EXTS.has(vfsPath.ext(p)))
  return { ok: true, entry: jsEntry, emitted, hidden }
}
