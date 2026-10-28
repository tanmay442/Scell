import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import { runNodeProcess, nodeBinaryReport } from '../../node/run'
import { transformEntry, isTypeScript } from '../../node/transform'
import type { CommandResult } from './npm'

const HOME = '/home/user'

/**
 * `node` — executes JS (and TS, via the ts-rust WASM transform) from the
 * VFS inside a fresh V8 isolate with Node-flavored globals.
 */
export async function nodeCommand(vfs: Vfs, args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CommandResult> {
  const { cwd, env: shellEnv } = opts

  if (args[0] === '-v' || args[0] === '--version') {
    return { stdout: `${nodeBinaryReport()}\n`, stderr: '', exitCode: 0 }
  }

  if (args[0] === '-e' || args[0] === '--eval') {
    const code = args[1]
    if (code === undefined) return { stdout: '', stderr: 'node: -e requires a script string\n', exitCode: 1 }
    const evalPath = `${opts.cwd === '/' ? '' : opts.cwd}/.cell-eval.js`
    vfs.write(evalPath, code)
    const result = await runNodeProcess(vfs, { entry: evalPath, argv: [], cwd: opts.cwd, env: shellEnv })
    vfs.delete(evalPath)
    return result
  }

  const entryArg = args[0]
  if (!entryArg || entryArg.startsWith('-')) {
    return {
      stdout: '',
      stderr: `node: missing entry file\nusage: node <file.js|file.ts> [args...] | node -e "code" | node -v\n`,
      exitCode: 1,
    }
  }

  let entry = vfsPath.normalize(entryArg.startsWith('/') ? entryArg : `${cwd === '/' ? '' : cwd}/${entryArg}`)
  if (!vfs.exists(entry)) {
    return {
      stdout: '',
      stderr: `node: cannot find module '${entryArg}' (looked in ${cwd})\n`,
      exitCode: 1,
    }
  }
  // directories load like real node: package.json main, else index.js
  if (vfs.isDir(entry)) {
    const manifestRaw = vfs.read(`${entry}/package.json`)
    let main: string | null = null
    if (manifestRaw !== null) {
      try {
        const manifest = JSON.parse(manifestRaw) as { main?: unknown }
        if (typeof manifest.main === 'string') main = manifest.main
      } catch {
        // ignore a broken manifest, fall through to index.js
      }
    }
    const candidates = [
      ...(main !== null ? [`${entry}/${main}`] : []),
      `${entry}/index.js`,
      `${entry}/index.json`,
    ]
    const resolved = candidates.find((candidate) => vfs.isFile(candidate))
    if (resolved === undefined) {
      return {
        stdout: '',
        stderr: `node: cannot find module '${entryArg}' (directory has no index.js)\n`,
        exitCode: 1,
      }
    }
    entry = vfsPath.normalize(resolved)
  }

  if (isTypeScript(entry)) {
    const transformed = await transformEntry(vfs, entry)
    if (!transformed.ok) {
      return { stdout: '', stderr: `${transformed.errorText}\n`, exitCode: 1 }
    }
    const result = await runNodeProcess(vfs, {
      entry: transformed.entry,
      argv: args.slice(1),
      cwd,
      env: shellEnv,
      filesOverride: transformed.emitted,
      hidePaths: transformed.hidden,
      timeoutMs: 120_000,
    })
    return result
  }

  const result = await runNodeProcess(vfs, { entry, argv: args.slice(1), cwd, env: shellEnv, timeoutMs: 120_000 })
  return result
}
