import type { Vfs } from '../../vfs/types'
import { vfsPath } from '../../vfs/types'
import { runNodeProcess } from '../../node/run'
import { TEMPLATES, templateNames } from '../../node/templates'
import { GLOBAL_ROOT, installPackages, projectRoot, rootDependencies, readManifest, writeManifest, collectBins, findBins } from './install'
import { fetchMetadata, pickVersion } from './registry'

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, code = 1): CommandResult => ({ stdout: '', stderr, exitCode: code })

export type { CommandResult, ShellLike } from './shell-types'
import type { CommandResult, ShellLike } from './shell-types'

/** session env carried into npm script shells (a real child inherits them) */
export type ScriptEnv = Map<string, string> | undefined

/**
 * npm (and pnpm, which routes here): init with templates, install from the
 * real registry, run scripts through a fresh shell, and npx for bins.
 */
export async function npmCommand(vfs: Vfs, args: string[], opts: { cwd: string; scriptShell: (cwd: string, env?: ScriptEnv) => ShellLike; flavor: 'npm' | 'pnpm'; registerLive?: (name: string) => void; progress?: (line: string) => void; env?: ScriptEnv }): Promise<CommandResult> {
  const { cwd, scriptShell, flavor, env } = opts
  const [sub = 'help', ...rest] = args

    if (sub === '--version' || sub === '-v') return ok(`${flavor === 'npm' ? '10.9.5' : '10.5.2'}\n`)

  if (sub === 'init' || sub === 'create') {
    return npmInit(vfs, rest, { cwd, flavor })
  }

  if (sub === 'install' || sub === 'i' || sub === 'add') {
    return npmInstall(vfs, rest, { cwd, registerLive: opts.registerLive, progress: opts.progress })
  }

  if (sub === 'uninstall' || sub === 'remove' || sub === 'rm' || sub === 'un') {
    return npmUninstall(vfs, rest, { cwd })
  }

  if (sub === 'run' || sub === 'run-script') {
    const script = rest[0]
    if (!script) return listScripts(vfs, cwd)
    return runScript(vfs, script, rest.slice(1), { cwd, scriptShell, env, progress: opts.progress })
  }

  if (sub === 'test') return runScript(vfs, 'test', rest, { cwd, scriptShell, env, progress: opts.progress })
  if (sub === 'start') return runScript(vfs, 'start', rest, { cwd, scriptShell, env, progress: opts.progress })
  if (sub === 'stop') return runScript(vfs, 'stop', rest, { cwd, scriptShell, env, progress: opts.progress })

  if (sub === 'ls' || sub === 'list') return npmLs(vfs, cwd)

  if (sub === 'exec' || sub === 'x') return npx(vfs, rest, { cwd })
  if (sub === 'info' || sub === 'view' || sub === 'show') return npmInfo(rest)

  // `npm dev` == `npm run dev` for anything that isn't a real subcommand —
  // npm itself has worked this way since v7; runScript's missing-script
  // error lists what does exist
  if (!['help', 'uninstall', 'remove', 'rm', 'update', 'link', 'unlink', 'pack', 'publish', 'audit', 'outdated', 'ci'].includes(sub)) {
    return runScript(vfs, sub, rest, { cwd, scriptShell, env, progress: opts.progress })
  }

  return fail(`${flavor}: '${sub}' is not implemented in Cell yet. Supported: init, install (-g), uninstall, run, test, start, ls, exec/npx, info.\n`)
}

export async function npx(vfs: Vfs, args: string[], opts: { cwd: string; progress?: (line: string) => void }): Promise<CommandResult> {
  const nameIndex = args.findIndex((a) => !a.startsWith('-'))
  const name = nameIndex === -1 ? undefined : args[nameIndex]
  if (!name) return fail('npx: specify a package binary to run, e.g. npx cowsay hi\n')
  const binArgs = args.slice(nameIndex + 1)

  // 1. an installed bin — project-local first (walk up), then global
  const direct = findBins(vfs, opts.cwd).get(name)
  if (direct) {
    return runNodeEntry(vfs, direct, binArgs, opts.cwd, name)
  }

  // 2. treat it as a package: install it, then run its (newly exposed) bin
  const root = projectRoot(vfs, opts.cwd) ?? opts.cwd
  const before = new Set(findBins(vfs, opts.cwd).keys())
  try {
    await installPackages(vfs, [{ name }], root, opts.progress)
  } catch (err) {
    return fail(`npx: could not install ${name}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  const binsAfter = findBins(vfs, opts.cwd)
  const fresh = [...binsAfter.keys()].filter((key) => !before.has(key))
  const binPath = binsAfter.get(name) ?? (fresh.length === 1 ? binsAfter.get(fresh[0]) : undefined)
  if (!binPath) {
    return fail(`npx: package ${name} installed but exposes no runnable bin\n`)
  }
  return runNodeEntry(vfs, binPath, binArgs, opts.cwd, name)
}

/** Run a package bin through the node sandbox (native binaries are caught honestly). */
export async function runNodeEntry(vfs: Vfs, entry: string, argv: string[], cwd: string, displayName?: string): Promise<CommandResult> {
  // ESM-only CLIs (top-level await / import-export syntax) cannot run in the
  // CommonJS sandbox — fail fast with the reason instead of a SyntaxError
  // installed files are byte-stored — read() returns null for them
  const entryBytes = vfs.readBytes(entry)
  const entrySource = entryBytes === null ? null : new TextDecoder('utf-8', { fatal: false }).decode(entryBytes.subarray(0, 4096))
  if (entrySource !== null && looksLikeEsm(entrySource)) {
    return {
      stdout: '',
      stderr: `${displayName ?? vfsPath.basename(entry)}: this CLI is an ES module (top-level await or import/export) and cannot run in Cell's CommonJS isolate yet.\nFor static apps and Vercel-style api/ functions, use: cell preview\n`,
      exitCode: 1,
    }
  }
  // native platform binaries (e.g. opencode's bin/opencode.exe) can never run
  // inside a browser isolate — say so instead of executing garbage
  if (/\.(exe|node|wasm)$/i.test(entry) || !looksLikeJs(vfs, entry)) {
    return {
      stdout: '',
      stderr: `${displayName ?? vfsPath.basename(entry)}: this package ships a native platform binary, which no browser can execute (there is no WASM build).\nFor an agent harness that does run here, see: cell agent --help\n`,
      exitCode: 1,
    }
  }
  const result = await runNodeProcess(vfs, { entry, argv, cwd })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

/** ESM markers: static import/export statements or a top-level await. */
function looksLikeEsm(source: string): boolean {
  if (/^\s*(import\s+[^(]|import\s+["']|export\s+(default|const|function|class|\{))/m.test(source)) return true
  if (/^await\s/m.test(source)) return true
  return false
}

function looksLikeJs(vfs: Vfs, entry: string): boolean {
  const bytes = vfs.readBytes(entry)
  if (bytes === null) return false
  // null bytes mean a real binary — never execute the bytes as text
  for (let i = 0; i < Math.min(bytes.length, 512); i++) {
    if (bytes[i] === 0) return false
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512))
  if (/^#!.*\bnode\b/.test(head)) return true
  return /^\s*(#!.*\n)?\s*(\/\/|\/\*|"use strict"|import |export |const |let |var |require\(|async |function |!function\(|\(\s*function)/m.test(head)
}

async function npmInit(vfs: Vfs, args: string[], opts: { cwd: string; flavor: 'npm' | 'pnpm' }): Promise<CommandResult> {
  const { cwd } = opts
  const yes = args.includes('-y') || args.includes('--yes') || args.includes('-f')
  const positional = args.filter((a) => !a.startsWith('-'))
  const templateName = positional[0]

  if (templateName) {
    if (TEMPLATES[templateName]) {
      const projectName = positional[1] ?? vfsPathBasename(cwd)
      for (const [path, content] of Object.entries(TEMPLATES[templateName].files(projectName))) {
        vfs.write(inDir(cwd, path), content)
      }
      return ok(`created ${templateName} project '${projectName}' in ${cwd}\n\ntry:\n  node index.js\n  npm test\n`)
    }
    // custom template: create-<name> package executed non-interactively
    const pkg = templateName.startsWith('create-') ? templateName : `create-${templateName}`
    const customArgs = [pkg, ...positional.slice(1), '--yes']
    const result = await npx(vfs, customArgs, { cwd })
    return {
      stdout: `${result.stdout}template '${templateName}' ran via ${pkg}\n`,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }
  }

  if (!yes && vfs.read(inDir(cwd, '/package.json')) !== null) {
    return fail('npm ERR! package.json already exists (use -y to overwrite)\n')
  }
  const name = vfsPathBasename(cwd)
  const manifest = {
    name,
    version: '1.0.0',
    main: 'index.js',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    license: 'ISC',
  }
  writeManifest(vfs, manifest, inDir(cwd, '/package.json'))
  return ok(`Wrote to ${inDir(cwd, '/package.json')}\n\n${JSON.stringify(manifest, null, 2)}\n`)
}

async function npmInstall(vfs: Vfs, args: string[], opts: { cwd: string; registerLive?: (name: string) => void; progress?: (line: string) => void }): Promise<CommandResult> {
  const { cwd } = opts
  const global = args.includes('-g') || args.includes('--global')
  const saveDev = args.includes('--save-dev') || args.includes('-D')
  const saveExact = args.includes('--save-exact') || args.includes('-E')
  const pkgs = args.filter((a) => !a.startsWith('-'))

  if (global) {
    if (pkgs.length === 0) {
      return fail('npm ERR! -g needs at least one package\n')
    }
    const requests = pkgs.map((pkg) => {
      const at = pkg.lastIndexOf('@')
      return { name: at > 0 ? pkg.slice(0, at) : pkg, range: at > 0 ? pkg.slice(at + 1) : undefined }
    })
    // older builds nested one node_modules too deep — heal that in place
    if (vfs.isDir(`${GLOBAL_ROOT}/node_modules`)) vfs.delete(`${GLOBAL_ROOT}/node_modules`)
    const report = await installPackages(vfs, requests, GLOBAL_ROOT, opts.progress)
    const freshBins = [...collectBins(vfs, GLOBAL_ROOT).keys()]
    for (const bin of freshBins) opts.registerLive?.(bin)
    const lines = [...report.warnings, `added ${report.added.length} package${report.added.length === 1 ? '' : 's'} globally to ~/.local/lib/node_modules`]
    for (const item of report.added.slice(0, 8)) lines.push(`  + ${item.name}@${item.version}`)
    if (freshBins.length > 0) lines.push(`commands now on PATH: ${freshBins.join(', ')}`)
    return ok(`${lines.join('\n')}\n`)
  }

  const root = projectRoot(vfs, cwd)
  if (root === null) {
    return fail(`npm ERR! no package.json in ${cwd} or any parent — run \`npm init -y\` first (npm ERR! enoent)\n`)
  }

  if (pkgs.length === 0) {
    const deps = rootDependencies(vfs, root)
    if (deps.length === 0) {
      return fail(`npm ERR! package.json at ${root} declares no dependencies — nothing to do\n`)
    }
    const report = await installPackages(vfs, deps, root, opts.progress)
    return finishInstall(report, 'up to date', root)
  }

  const requests: { name: string; range?: string }[] = []
  for (const pkg of pkgs) {
    const at = pkg.lastIndexOf('@')
    const name = at > 0 ? pkg.slice(0, at) : pkg
    const range = at > 0 ? pkg.slice(at + 1) : undefined
    if (!name) return fail(`npm ERR! Invalid package name: ${pkg}\n`)
    requests.push({ name, range })
  }

  const manifestPath = `${root}/package.json`
  const manifest = readManifest(vfs, manifestPath)
  if (!manifest) {
    return fail(`npm ERR! no package.json in ${root} — run \`npm init -y\` first (npm ERR! enoent)\n`)
  }

  const report = await installPackages(vfs, requests, root, opts.progress)

  // record the resolved versions in package.json
  for (const { name, range } of requests) {
    const metadata = await fetchMetadata(name)
    const resolved = report.added.find((a) => a.name === name && !a.nested)?.version ?? pickVersion(metadata, range).version
    const spec = saveExact ? resolved : `^${resolved}`
    const key = saveDev ? 'devDependencies' : 'dependencies'
    const bucket = (manifest[key] as Record<string, string> | undefined) ?? {}
    bucket[name] = spec
    manifest[key] = bucket
  }
  writeManifest(vfs, manifest, manifestPath)

  return finishInstall(report, 'installed', root)
}

async function npmUninstall(vfs: Vfs, args: string[], opts: { cwd: string }): Promise<CommandResult> {
  const global = args.includes('-g') || args.includes('--global')
  const pkgs = args.filter((a) => !a.startsWith('-'))
  if (pkgs.length === 0) return fail('npm ERR! uninstall needs a package name\n')
  const root = global ? GLOBAL_ROOT : (projectRoot(vfs, opts.cwd) ?? '/')
  const removed: string[] = []
  for (const name of pkgs) {
    const dir = `${root}/node_modules/${name}`
    if (vfs.exists(dir)) {
      vfs.delete(dir)
      removed.push(name)
    }
  }
  if (!global && removed.length > 0) {
    const manifestPath = `${root}/package.json`
    const manifest = readManifest(vfs, manifestPath)
    if (manifest) {
      for (const name of removed) {
        for (const key of ['dependencies', 'devDependencies']) {
          const bucket = manifest[key] as Record<string, string> | undefined
          if (bucket) delete bucket[name]
        }
      }
      writeManifest(vfs, manifest, manifestPath)
    }
  }
  if (removed.length === 0) return fail(`npm ERR! not installed: ${pkgs.join(', ')}\n`)
  return ok(`removed ${removed.length} package${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}\n`)
}

function finishInstall(report: { added: { name: string; version: string; nested: boolean }[]; warnings: string[]}, verb: string, cwd: string): CommandResult {
  const lines = [...report.warnings]
  const root = report.added.filter((a) => !a.nested)
  const nested = report.added.filter((a) => a.nested)
  if (root.length > 0) {
    lines.push(`added ${root.length} package${root.length === 1 ? '' : 's'} in ${cwd}`)
    for (const item of root) lines.push(`  + ${item.name}@${item.version}`)
  } else {
    lines.push(`${verb}, nothing to do`)
  }
  if (nested.length > 0) lines.push(`  (${nested.length} nested transitive package${nested.length === 1 ? '' : 's'})`)
  return ok(`${lines.join('\n')}\n`)
}

function listScripts(vfs: Vfs, cwd: string): CommandResult {
  const manifest = readManifest(vfs, `${projectRoot(vfs, cwd) ?? cwd}/package.json`)
  const scripts = (manifest?.scripts as Record<string, string> | undefined) ?? {}
  const names = Object.keys(scripts)
  if (names.length === 0) return ok('no scripts available\n')
  return ok(`Scripts available:\n${names.map((n) => `  ${n}\n    ${scripts[n]}`).join('\n')}\n`)
}

async function runScript(vfs: Vfs, script: string, extraArgs: string[], opts: { cwd: string; scriptShell: (cwd: string, env?: ScriptEnv) => ShellLike; env?: ScriptEnv; progress?: (line: string) => void }): Promise<CommandResult> {
  const { cwd } = opts
  const shell = opts.scriptShell(cwd, opts.env)
  const manifest = readManifest(vfs, `${projectRoot(vfs, cwd) ?? cwd}/package.json`)
  if (!manifest) return fail(`npm ERR! no package.json in ${cwd}\n`)
  const scripts = (manifest.scripts as Record<string, string> | undefined) ?? {}
  const command = scripts[script]
  if (!command) {
    const available = Object.keys(scripts)
    return fail(`npm ERR! Missing script: "${script}"${available.length ? `\n\navailable: ${available.join(', ')}` : ''}\n`)
  }
  const parts: string[] = []
  const pre = scripts[`pre${script}`]
  const post = scripts[`post${script}`]
  if (pre) parts.push(pre)
  parts.push(command)
  if (post) parts.push(post)
  const full = `${parts.join(' && ')}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}`

  // scripts run through a fresh shell so nested node/npm/npx/tsc calls work
  const result = await shell.exec(full, cwd, opts.progress)
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

function npmLs(vfs: Vfs, cwd: string): CommandResult {
  const root = projectRoot(vfs, cwd) ?? cwd
  const modules = `${root}/node_modules`
  if (!vfs.isDir(modules)) return ok(`${vfsPathBasename(root)}@ ${root}\n(empty — nothing installed)\n`)
  const manifest = readManifest(vfs, `${root}/package.json`)
  const lines = [`${(manifest?.name as string) ?? vfsPathBasename(root)}@${(manifest?.version as string) ?? '0.0.0'} ${root}`]
  const declared = rootDependencies(vfs, root)
  for (const name of vfs.readDir(modules)) {
    const pkgManifest = readManifest(vfs, `${modules}/${name}/package.json`)
    const version = (pkgManifest?.version as string) ?? '?'
    const wanted = declared.find((d) => d.name === name)?.range ?? 'extraneous'
    lines.push(`├── ${name}@${version} (${wanted})`)
  }
  return ok(`${lines.join('\n')}\n`)
}

async function npmInfo(args: string[]): Promise<CommandResult> {
  const name = args.find((a) => !a.startsWith('-'))
  if (!name) return fail('npm info <package>\n')
  const metadata = await fetchMetadata(name)
  const latest = metadata['dist-tags']?.latest ?? Object.keys(metadata.versions).pop() ?? '?'
  const version = metadata.versions[latest]
  const lines = [
    `${name}@${latest} | ${Object.keys(version.dependencies ?? {}).length} dependencies | MIT-or-other`,
    `dist.tarball: ${version.dist.tarball}`,
    `versions: ${Object.keys(metadata.versions).slice(-8).join(', ')}${Object.keys(metadata.versions).length > 8 ? ', …' : ''}`,
  ]
  if (version.bin) lines.push(`bin: ${JSON.stringify(version.bin)}`)
  return ok(`${lines.join('\n')}\n`)
}

function inDir(cwd: string, p: string): string {
  return cwd === '/' ? p : `${cwd}${p.startsWith('/') ? p : `/${p}`}`
}

function vfsPathBasename(cwd: string): string {
  const n = cwd.replace(/\/+$/, '')
  return n === '' ? 'workspace' : n.slice(n.lastIndexOf('/') + 1)
}

export const pnpmCommand = (vfs: Vfs, args: string[], opts: { cwd: string; scriptShell: (cwd: string, env?: ScriptEnv) => ShellLike; registerLive?: (name: string) => void; progress?: (line: string) => void; env?: ScriptEnv }) =>
  args[0] === 'dlx'
    ? npx(vfs, args.slice(1), { cwd: opts.cwd })
    : npmCommand(vfs, args, { ...opts, flavor: 'pnpm' })
