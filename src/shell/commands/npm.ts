import type { Vfs } from '../../vfs/types'
import { runNodeProcess } from '../../node/run'
import { TEMPLATES, templateNames } from '../../node/templates'
import { installPackages, rootDependencies, readManifest, writeManifest, collectBins } from './install'
import { fetchMetadata, pickVersion } from './registry'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, code = 1): CommandResult => ({ stdout: '', stderr, exitCode: code })

export interface ShellLike {
  exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/**
 * npm (and pnpm, which routes here): init with templates, install from the
 * real registry, run scripts through a fresh shell, and npx for bins.
 */
export async function npmCommand(vfs: Vfs, args: string[], opts: { cwd: string; shell: ShellLike; flavor: 'npm' | 'pnpm' }): Promise<CommandResult> {
  const { cwd, shell, flavor } = opts
  const [sub = 'help', ...rest] = args

    if (sub === '--version' || sub === '-v') return ok(`${flavor === 'npm' ? '10.9.5' : '10.5.2'} (cell)\n`)

  if (sub === 'init' || sub === 'create') {
    return npmInit(vfs, rest, { cwd, flavor })
  }

  if (sub === 'install' || sub === 'i' || sub === 'add') {
    return npmInstall(vfs, rest, { cwd })
  }

  if (sub === 'run' || sub === 'run-script') {
    const script = rest[0]
    if (!script) return listScripts(vfs, cwd)
    return runScript(vfs, script, rest.slice(1), { cwd, shell })
  }

  if (sub === 'test') return runScript(vfs, 'test', rest, { cwd, shell })
  if (sub === 'start') return runScript(vfs, 'start', rest, { cwd, shell })
  if (sub === 'stop') return runScript(vfs, 'stop', rest, { cwd, shell })

  if (sub === 'ls' || sub === 'list') return npmLs(vfs, cwd)

  if (sub === 'exec' || sub === 'x') return npx(vfs, rest, { cwd })
  if (sub === 'info' || sub === 'view' || sub === 'show') return npmInfo(rest)

  // pnpm shorthand: `pnpm dev` == `pnpm run dev`
  if (flavor === 'pnpm' && !['help', 'uninstall', 'remove', 'rm', 'update', 'link', 'unlink', 'pack', 'publish', 'audit', 'outdated', 'ci'].includes(sub)) {
    return runScript(vfs, sub, rest, { cwd, shell })
  }

  return fail(`${flavor}: '${sub}' is not implemented in Cell yet. Supported: init, install, run, test, start, ls, exec/npx, info.\n`)
}

export async function npx(vfs: Vfs, args: string[], opts: { cwd: string }): Promise<CommandResult> {
  const name = args[0]
  if (!name) return fail('npx: specify a package binary to run, e.g. npx cowsay hi\n')
  const binArgs = args.slice(1)

  // 1. an installed bin?
  const bins = collectBins(vfs)
  const direct = bins.get(name)
  if (direct) {
    return runNodeEntry(vfs, direct, binArgs, opts.cwd)
  }

  // 2. treat it as a package: install it, then run its (newly exposed) bin
  const before = new Set(collectBins(vfs).keys())
  try {
    await installPackages(vfs, [{ name }])
  } catch (err) {
    return fail(`npx: could not install ${name}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  const binsAfter = collectBins(vfs)
  const fresh = [...binsAfter.keys()].filter((key) => !before.has(key))
  const binPath = binsAfter.get(name) ?? (fresh.length === 1 ? binsAfter.get(fresh[0]) : undefined)
  if (!binPath) {
    return fail(`npx: package ${name} installed but exposes no runnable bin\n`)
  }
  return runNodeEntry(vfs, binPath, binArgs, opts.cwd)
}

async function runNodeEntry(vfs: Vfs, entry: string, argv: string[], cwd: string): Promise<CommandResult> {
  const result = await runNodeProcess(vfs, { entry, argv, cwd })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
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

async function npmInstall(vfs: Vfs, args: string[], opts: { cwd: string }): Promise<CommandResult> {
  const { cwd } = opts
  const saveDev = args.includes('--save-dev') || args.includes('-D')
  const saveExact = args.includes('--save-exact') || args.includes('-E')
  const pkgs = args.filter((a) => !a.startsWith('-'))

  if (pkgs.length === 0) {
    const deps = rootDependencies(vfs)
    if (deps.length === 0) {
      return fail('npm ERR! no package.json found — run `npm init` first\n')
    }
    const report = await installPackages(vfs, deps)
    return finishInstall(report, 'up to date', cwd)
  }

  const requests: { name: string; range?: string }[] = []
  for (const pkg of pkgs) {
    const at = pkg.lastIndexOf('@')
    const name = at > 0 ? pkg.slice(0, at) : pkg
    const range = at > 0 ? pkg.slice(at + 1) : undefined
    if (!name) return fail(`npm ERR! Invalid package name: ${pkg}\n`)
    requests.push({ name, range })
  }

  const manifest = readManifest(vfs, inDir(cwd, '/package.json'))
  if (!manifest) {
    return fail(`npm ERR! no package.json in ${cwd} — run \`npm init -y\` first (npm ERR! enoent)\n`)
  }

  const report = await installPackages(vfs, requests)

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
  writeManifest(vfs, manifest, inDir(cwd, '/package.json'))

  return finishInstall(report, 'installed', cwd)
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
  const manifest = readManifest(vfs, inDir(cwd, '/package.json'))
  const scripts = (manifest?.scripts as Record<string, string> | undefined) ?? {}
  const names = Object.keys(scripts)
  if (names.length === 0) return ok('no scripts available\n')
  return ok(`Scripts available:\n${names.map((n) => `  ${n}\n    ${scripts[n]}`).join('\n')}\n`)
}

async function runScript(vfs: Vfs, script: string, extraArgs: string[], opts: { cwd: string; shell: ShellLike }): Promise<CommandResult> {
  const { cwd, shell } = opts
  const manifest = readManifest(vfs, inDir(cwd, '/package.json'))
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
  const result = await shell.exec(full, `/workspace${cwd === '/' ? '' : cwd}`)
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

function npmLs(vfs: Vfs, cwd: string): CommandResult {
  const root = inDir(cwd, '/node_modules')
  if (!vfs.isDir(root)) return ok(`${vfsPathBasename(cwd)}@ ${cwd}\n(empty — nothing installed)\n`)
  const manifest = readManifest(vfs, inDir(cwd, '/package.json'))
  const lines = [`${(manifest?.name as string) ?? vfsPathBasename(cwd)}@${(manifest?.version as string) ?? '0.0.0'} ${cwd}`]
  const declared = rootDependencies(vfs)
  for (const name of vfs.readDir(root)) {
    const pkgManifest = readManifest(vfs, `${root}/${name}/package.json`)
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

export const pnpmCommand = (vfs: Vfs, args: string[], opts: { cwd: string; shell: ShellLike }) =>
  args[0] === 'dlx'
    ? npx(vfs, args.slice(1), { cwd: opts.cwd })
    : npmCommand(vfs, args, { ...opts, flavor: 'pnpm' })
