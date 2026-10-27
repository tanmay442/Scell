import type { Vfs } from '../../vfs/types'
import { langService } from '../../lang/service'
import type { CommandResult } from './npm'

/**
 * `tsc` — the same ts-rust WASM compiler the editor uses, as a CLI.
 * File-ish arguments are resolved against the caller's cwd and remapped into
 * the compiler's /project root; with no arguments the language worker
 * discovers the project's tsconfig itself (the workspace may hold several
 * projects anywhere under ~).
 */
export async function tscCommand(_vfs: Vfs, args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
  if (args[0] === '--version' || args[0] === '-v') {
    return { stdout: 'Version 7.1.0-beta (ts-rust — the Rust port of TypeScript 7, WASM)\n', stderr: '', exitCode: 0 }
  }
  const service = langService()
  if (!service) {
    return { stdout: '', stderr: 'tsc: language service not started\n', exitCode: 1 }
  }

  const cwd = opts?.cwd ?? '/home/user'
  const isFileish = (a: string, i: number) =>
    /\.(ts|tsx|mts|cts|json)$/.test(a) || (i > 0 && args[i - 1] === '-p' && !a.startsWith('-'))
  const mapped = args.map((a, i) => {
    if (a.startsWith('-')) return a
    if (a.startsWith('/')) return `/project${a}`
    if (isFileish(a, i)) return `/project${cwd}/${a}`.replace(/\/{2,}/g, '/')
    return a
  })
  const runArgs = args.length > 0 ? mapped : []
  const result = await service.tscRun(runArgs)

  const lines: string[] = []
  let errors = 0
  for (const d of result.diagnostics) {
    const file = d.fileName
      ? d.fileName.replace(/^\/project/, '').replace(new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
      : ''
    const pos = d.startPosition ? `(${d.startPosition.line + 1},${d.startPosition.character + 1})` : ''
    const severity = d.category === 1 ? 'error' : d.category === 0 ? 'warning' : 'message'
    if (d.category === 1) errors++
    lines.push(`${file}${pos}: ${severity} TS${d.code}: ${d.text}`)
  }
  const text = lines.join('\n')
  const summary = errors > 0 ? `Found ${errors} error${errors === 1 ? '' : 's'}.` : ''
  return {
    stdout: text ? `${text}\n${summary ? `\n${summary}\n` : ''}` : summary ? `${summary}\n` : '',
    stderr: '',
    exitCode: errors > 0 ? 1 : result.exitCode,
  }
}
