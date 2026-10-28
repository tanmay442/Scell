import { Bash, defineCommand } from 'just-bash'
import { platform } from '../platform'
import type { Vfs } from '../vfs/types'
import { VfsBackedFs } from './vfs-fs'
import { nodeCommand } from './commands/node-cmd'
import { npmCommand, npx, pnpmCommand, runNodeEntry, type CommandResult, type ShellLike } from './commands/npm'
import { collectBins, projectRoot, GLOBAL_ROOT } from './commands/install'
import { gitCommand } from './commands/git'
import { tscCommand } from './commands/tsc-cmd'
import { cellCommand } from './commands/cell-cmd'
import { curlCommand } from './commands/curl'
import { vfsPath } from '../vfs/types'
import { pythonCommand } from './commands/python-cmd'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Shell {
  exec(cmd: string, cwd?: string, onProgress?: (line: string) => void): Promise<ShellResult>
}

function toResult(result: CommandResult | ShellResult): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

export const HOME_DIR = '/home/user'
const BASHRC = `${HOME_DIR}/.bashrc`

/** shell internals that must not leak into the persisted env */
const ENV_BLOCKLIST = new Set([
  'IFS', 'PS1', 'PS2', 'PS4', 'PPID', 'UID', 'EUID', 'RANDOM', 'SECONDS',
  'LINENO', 'SHLVL', 'PWD', 'OLDPWD', '_', 'OPTIND', 'BASH', 'BASH_VERSINFO',
  'BASHOPTS', 'SHELLOPTS', 'COMP_WORDBREAKS', 'DIRSTACK', 'HISTCMD',
])

/**
 * One long-lived just-bash instance whose filesystem is the Cell Vfs
 * (identity mapping — the shell sees a real user machine rooted at / with
 * HOME=/home/user), plus the platform commands: node (V8 isolate),
 * npm/pnpm/npx (real registry), tsc (ts-rust WASM) and git (libgit2 WASM).
 *
 * Session realism, where just-bash is per-execution: `~/.bashrc` is sourced
 * in front of every command and the environment captured after each one —
 * so exports persist across commands (like a real interactive shell),
 * .bashrc variables and aliases apply everywhere, and child processes
 * (node) inherit what the session exported.
 */
export function createShell(vfs?: Vfs, opts?: { extraBins?: Map<string, string>; seedEnv?: Record<string, string> }): Shell {
  const v = vfs ?? platform().vfs
  const fs = new VfsBackedFs(v)
  const baseEnv: Record<string, string> = {
    HOME: HOME_DIR,
    USER: 'user',
    LOGNAME: 'user',
    SHELL: '/bin/bash',
    PATH: `${HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    HOSTNAME: 'cell',
    SHLVL: '1',
  }
  const bash = new Bash({ fs, cwd: HOME_DIR, env: baseEnv })

  /** environment carried across commands: session exports + last .bashrc state */
  // script shells start from the caller's session env (like a real child
  // process), then accumulate their own exports from there
  const sessionEnv: Record<string, string> = { ...(opts?.seedEnv ?? {}) }
  const hasBashrc = () => v.isFile(BASHRC)
  const bashrcPrefix = () => (hasBashrc() ? `. ${BASHRC} >/dev/null 2>&1; ` : '')

  // Progress sink for long commands (git clone, npm install): the terminal
  // passes a live-line writer per exec; platform commands report phases
  // through it while their buffered stdout/stderr still arrive at the end.
  // Save/restore keeps nested shells and sequential execs from clobbering.
  let liveProgress: ((line: string) => void) | undefined
  // per-exec nonce for the env-dump marker: the dump rides in-band in
  // stdout, so a fixed marker lets command output forge session env vars —
  // a random nonce per exec makes that unguessable
  let liveNonce = ''
  const randomHex = (): string =>
    [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')

  const shell: Shell = {
    async exec(cmd, cwd, onProgress) {
      const prev = liveProgress
      liveProgress = onProgress
      const nonce = randomHex()
      const prevNonce = liveNonce
      liveNonce = nonce
      try {
      const options = { cwd: cwd ?? HOME_DIR, env: sessionEnv }
      // the environment capture runs IN-BAND (a separate exec would already
      // have its env restored): brace the user's command, keep its exit code,
      // then dump. The dump line is stripped from stdout.
      const sourceLine = bashrcPrefix()
      const wrapped =
        `${sourceLine}{ ${cmd}\n}; __cell_rc=$?; __cell_env_dump ${nonce} $__cell_rc`
      const result = await bash.exec(wrapped, options)
      // the dump may CONCATENATE onto the command's own output (no trailing
      // newline) — find the marker anywhere and cut to its end of line
      const marker = `__CELL_ENV__:${nonce}:`
      let stdout = result.stdout
      const markerAt = stdout.lastIndexOf(marker)
      if (markerAt !== -1) {
        const lineEnd = stdout.indexOf('\n', markerAt)
        const dumpText = lineEnd === -1 ? stdout.slice(markerAt) : stdout.slice(markerAt, lineEnd)
        stdout = lineEnd === -1 ? stdout.slice(0, markerAt) : stdout.slice(0, markerAt) + stdout.slice(lineEnd + 1)
        try {
          const parsed = JSON.parse(dumpText.slice(marker.length)) as Record<string, unknown>
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== 'string' || ENV_BLOCKLIST.has(key)) continue
            if (key.startsWith('BASH_ALIAS_') || key.startsWith('__cell_') || key === '?') continue
            // the .bashrc re-sourcing prepends PATH every exec — dedupe
            sessionEnv[key] = key === 'PATH' ? [...new Set(value.split(':'))].filter(Boolean).join(':') : value
          }
        } catch {
          // env capture is best-effort
        }
      }
      return { stdout, stderr: result.stderr, exitCode: result.exitCode }
      } finally {
        liveProgress = prev
        liveNonce = prevNonce
      }
    },
  }

  // A fresh shell for nested calls (npm run <script> runs its own bash).
  const nestedShell = (): Shell => createShell(vfs, opts)

  const register = (
    name: string,
    fn: (args: string[], ctx: { cwd: string; env: Map<string, string>; stdin?: unknown; progress?: (line: string) => void }) => Promise<CommandResult> | CommandResult,
  ) => {
    bash.registerCommand(
      defineCommand(name, async (args: string[], ctx: { cwd?: string; env?: Map<string, string>; stdin?: unknown }) => {
        try {
          return toResult(await fn(args, { cwd: ctx.cwd ?? HOME_DIR, env: ctx.env ?? new Map(), stdin: ctx.stdin, progress: liveProgress }))
        } catch (err) {
          const detail =
            err instanceof Error
              ? (err.stack ?? err.message).split('\n').slice(0, 4).join(' | ')
              : `${String(err)} keys=${Object.keys(err ?? {}).join(',')}`
          return { stdout: '', stderr: `${name}: ${detail}\n`, exitCode: 1 }
        }
      }),
    )
  }

  // -- session plumbing ------------------------------------------------------

  // env capture: a JSON dump of the current shell environment
  bash.registerCommand(
    defineCommand('__cell_env_dump', async (args, ctx) => {
      const entries: Record<string, string> = {}
      for (const [key, value] of ctx.env ?? new Map<string, string>()) entries[key] = value
      // args: <nonce> <rc> — the nonce binds this dump to its exec so
      // forged markers in command output are never honored
      const nonce = args[0] ?? ''
      const rc = Number.parseInt(args[1] ?? '0', 10)
      return {
        stdout: `__CELL_ENV__:${nonce}:${JSON.stringify(entries)}\n`,
        stderr: '',
        exitCode: Number.isFinite(rc) ? rc : 0,
      }
    }),
  )

  // -- system-plausibility commands (the container-detection tells) ----------

  register('uname', (args) => {
    const all = args.includes('-a')
    const kernel = '6.8.0-cell'
    if (args.includes('-r')) return { stdout: `${kernel}\n`, stderr: '', exitCode: 0 }
    if (args.includes('-s') || args.length === 0) return { stdout: 'Linux\n', stderr: '', exitCode: 0 }
    if (args.includes('-m')) return { stdout: 'x86_64\n', stderr: '', exitCode: 0 }
    return {
      stdout: all ? `Linux cell ${kernel} #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n` : 'Linux\n',
      stderr: '',
      exitCode: 0,
    }
  })

  register('id', (_args, { env }) => {
    const uid = env.get('UID') ?? '1000'
    return { stdout: `uid=1000(user) gid=1000(user) groups=1000(user),27(sudo),docker(999)\n`, stderr: '', exitCode: 0 }
  })

  register('groups', () => ({ stdout: 'user sudo docker\n', stderr: '', exitCode: 0 }))

  register('hostname', (_args, { env }) => ({
    stdout: `${env.get('HOSTNAME') ?? 'cell'}\n`,
    stderr: '',
    exitCode: 0,
  }))

  register('uptime', () => {
    const bootSeconds = Math.max(60, Math.floor(performance.now() / 1000))
    const hh = Math.floor(bootSeconds / 3600)
    const mm = Math.floor((bootSeconds % 3600) / 60)
    const now = new Date().toTimeString().slice(0, 8)
    return {
      stdout: ` ${now} up ${hh}:${mm},  1 user,  load average: 0.31, 0.24, 0.19\n`,
      stderr: '',
      exitCode: 0,
    }
  })

  register('df', (args) => {
    const lines = [
      'Filesystem      Size  Used Avail Use% Mounted on',
      '/dev/sda1       100G   31G   70G  31% /',
      'tmpfs           6.3G     0  6.3G   0% /dev/shm',
      'tmpfs           6.3G  288K  6.3G   1% /run',
    ]
    const out = args.includes('-h') || args.length === 0 ? lines.join('\n') : lines.join('\n')
    return { stdout: `${out}\n`, stderr: '', exitCode: 0 }
  })

  register('free', (args) => {
    const g = args.includes('-g')
    const total = g ? 16 : 15874
    const used = g ? 6 : 6214
    const freeMem = g ? 4 : 4102
    const shared = g ? 1 : 318
    const buff = g ? 6 : 5558
    const avail = g ? 9 : 9214
    const swap = g ? 2 : 2048
    const rows = g
      ? [
          '               total        used        free      shared  buff/cache   available',
          `Mem:           ${total}        ${used}        ${freeMem}         ${shared}        ${buff}        ${avail}`,
          `Swap:          ${swap}           0        ${swap}`,
        ]
      : [
          '               total        used        free      shared  buff/cache   available',
          `Mem:        ${total}       ${used}       ${freeMem}        ${shared}       ${buff}       ${avail}`,
          `Swap:        ${swap}           0        ${swap}`,
        ]
    void args
    return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 }
  })

  register('ps', (args) => {
    const aux = args.some((a) => a.includes('a'))
    const rows = aux
      ? [
          'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
          'user         1  0.0  0.1  16756  9832 ?        Ss   09:12   0:01 /bin/bash',
          'user        42  0.2  0.4 881244 52140 ?        Sl   09:13   0:02 node cell-runtime',
          `user       ${Math.floor(Math.random() * 900) + 100}  0.0  0.0   5828  3980 ?        R+   ${new Date().toTimeString().slice(0, 5)}   0:00 ps aux`,
        ]
      : [
          '    PID TTY          TIME CMD',
          '     42 ?        00:00:02 bash',
        ]
    return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 }
  })

  // -- which: platform commands are real commands on PATH --------------------

  const PLATFORM_COMMANDS: Record<string, string> = {
    node: '/usr/local/bin/node',
    npm: '/usr/local/bin/npm',
    npx: '/usr/local/bin/npx',
    pnpm: '/usr/local/bin/pnpm',
    pnpx: '/usr/local/bin/pnpx',
    tsc: '/usr/local/bin/tsc',
    git: '/usr/bin/git',
    cell: '/usr/local/bin/cell',
    curl: '/usr/bin/curl',
  }

  bash.registerCommand(
    defineCommand('which', async (args, ctx) => {
      const results: string[] = []
      let exit = 0
      for (const name of args.filter((a) => !a.startsWith('-'))) {
        const platformPath = PLATFORM_COMMANDS[name]
        if (platformPath !== undefined) {
          results.push(platformPath)
          continue
        }
        // file lookup across PATH
        const pathEnv = ctx.env?.get('PATH') ?? baseEnv.PATH
        let found = ''
        for (const dir of pathEnv.split(':')) {
          const candidate = `${dir}/${name}`
          if (await fs.exists(candidate)) {
            found = candidate
            break
          }
        }
        if (found !== '') results.push(found)
        else exit = 1
      }
      return { stdout: results.length > 0 ? `${results.join('\n')}\n` : '', stderr: '', exitCode: exit }
    }),
  )

  register('whereis', (args) => {
    const name = args[0]
    const known = PLATFORM_COMMANDS[name]
    if (name === undefined) return { stdout: '', stderr: '', exitCode: 1 }
    const bin = known ?? ''
    return { stdout: `${name}: ${bin} ${bin.replace('/bin/', '/share/man/man1/').replace(/\.[a-z]+$/, '')}.1.gz\n`, stderr: '', exitCode: 0 }
  })

  register('man', async (args) => {
    const page = args.find((a) => !a.startsWith('-'))
    // the name is interpolated into a shell line — reject anything that is
    // not a plain command name so `man "x; evil"` cannot execute
    if (page !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(page)) {
      const result = await bash.exec(`${page} --help 2>&1`, { cwd: HOME_DIR, env: sessionEnv })
      if (result.exitCode === 0 && result.stdout.trim() !== '') {
        return { stdout: result.stdout, stderr: '', exitCode: 0 }
      }
    }
    return { stdout: '', stderr: `No manual entry for ${page ?? ''}\n`, exitCode: 1 }
  })

  register('kill', (args) => {
    const pids = args.filter((a) => !a.startsWith('-'))
    if (pids.length === 0) return { stdout: '', stderr: 'kill: usage: kill [-sig] pid …\n', exitCode: 1 }
    for (const pid of pids) {
      const n = Number.parseInt(pid, 10)
      if (Number.isFinite(n) && n > 1) continue
      return { stdout: '', stderr: `kill: (${pid}): No such process\n`, exitCode: 1 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  })

  register('tty', () => ({ stdout: '/dev/pts/0\n', stderr: '', exitCode: 0 }))

  register('nproc', () => ({ stdout: '4\n', stderr: '', exitCode: 0 }))

  register('umask', (args) => {
    if (args.length === 0) return { stdout: '0022\n', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 0 }
  })

  register('chown', (args) => {
    const files = args.slice(1).filter((a) => !a.startsWith('-') && !/^[0-9]+:[0-9]+$/.test(a) && !/^[a-z_]+:[a-z_]+$/.test(a))
    for (const file of files) {
      if (!await_check(file)) return { stdout: '', stderr: `chown: cannot access '${file}': No such file or directory\n`, exitCode: 1 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  })

  register('realpath', (args, { cwd }) => {
    const out: string[] = []
    for (const target of args.filter((a) => !a.startsWith('-'))) {
      const resolved = vfsPath.normalize(target.startsWith('/') ? target : `${cwd}/${target}`)
      if (v.exists(resolved) || v.exists(vfsPath.dirname(resolved))) out.push(resolved)
      else return { stdout: '', stderr: `realpath: No such file or directory '${target}'\n`, exitCode: 1 }
    }
    return { stdout: `${out.join('\n')}\n`, stderr: '', exitCode: 0 }
  })

  // xargs: just-bash's builtin lacks -n/-I/-L/-0 — this shim reads stdin
  // and re-invokes each batch through the shell (GNU default: all args at
  // once, one invocation)
  bash.registerCommand(
    defineCommand('xargs', async (args, ctx) => {
      const stdinText = typeof ctx.stdin === 'string' ? ctx.stdin : ''
      const useNull = args.includes('-0') || args.includes('--null')
      const items = (useNull ? stdinText.split('\0') : stdinText.split('\n'))
        .map((line) => (useNull ? line : line.trim()))
        .filter((line) => line !== '')
      if (items.length === 0) return { stdout: '', stderr: '', exitCode: 0 }
      let repl: string | null = null
      // null = GNU default: everything in a single invocation
      let maxArgs: number | null = null
      const rest: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '-I' || arg.startsWith('-I')) {
          repl = arg === '-I' ? (args[++i] ?? '{}') : arg.slice(2)
        } else if (arg === '-n' || arg.startsWith('-n')) {
          maxArgs = Number.parseInt(arg === '-n' ? (args[++i] ?? '1') : arg.slice(2), 10) || 1
        } else if (arg === '-L' || arg.startsWith('-L')) {
          maxArgs = Number.parseInt(arg === '-L' ? (args[++i] ?? '1') : arg.slice(2), 10) || 1
        } else if (arg === '-0' || arg === '--null' || arg === '-r' || arg === '--no-run-if-empty') {
          // handled by the stdin split / empty behavior
        } else {
          rest.push(arg)
        }
      }
      // -I implies one line per invocation; quote appended args so spaces
      // survive the re-parse
      const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
      const base = rest.join(' ')
      const batches: string[][] = repl !== null
        ? items.map((item) => [item])
        : maxArgs === null
          ? [items]
          : items.flatMap((_, i, all) => (i % maxArgs! === 0 ? [all.slice(i, i + maxArgs!)] : []))
      let stdout = ''
      let stderr = ''
      let exit = 0
      for (const batch of batches) {
        const line = repl !== null
          ? base.replaceAll(repl, batch.join(' '))
          : `${base} ${batch.map(quote).join(' ')}`.trim()
        const result = await bash.exec(line, { cwd: ctx.cwd, env: sessionEnv })
        stdout += result.stdout
        stderr += result.stderr
        if (result.exitCode !== 0) exit = result.exitCode
      }
      return { stdout, stderr, exitCode: exit }
    }),
  )

  function await_check(file: string): boolean {
    const resolved = vfsPath.normalize(file.startsWith('/') ? file : `${HOME_DIR}/${file}`)
    return v.exists(resolved) || v.isFile(resolved) || v.isDir(resolved)
  }

  register('less', async (args, { cwd }) => {
    // non-interactive pager: behaves like cat
    const targets = args.filter((a) => !a.startsWith('-'))
    let out = ''
    for (const target of targets) {
      try {
        const resolved = target.startsWith('/') ? target : `${cwd}/${target}`
        out += await fs.readFile(vfsPath.normalize(resolved))
      } catch {
        return { stdout: '', stderr: `less: ${target}: No such file or directory\n`, exitCode: 1 }
      }
    }
    if (targets.length === 0 && args.includes('-')) out = '(stdin)'
    return { stdout: out, stderr: '', exitCode: 0 }
  })

  // -- platform commands ------------------------------------------------------

  const shellEnvOf = (env: Map<string, string>): Record<string, string> => {
    const merged: Record<string, string> = {}
    for (const [key, value] of env) {
      if (!ENV_BLOCKLIST.has(key)) merged[key] = value
    }
    return merged
  }

  register('node', (args, { cwd, env }) => nodeCommand(v, args, { cwd, env: shellEnvOf(env) }))
  register('tsc', (args, { cwd }) => tscCommand(v, args, { cwd }))
  register('git', (args, { cwd, progress }) => gitCommand(v, args, { cwd, progress }))
  // npm scripts run in their own shell WITH the project's node_modules/.bin
  // on PATH — that is what makes `npm dev` → `vercel dev` work for real.
  // The script shell seeds from the caller's session env like a real child.
  const scriptShell = (cwd: string, seed?: Map<string, string>): ShellLike =>
    createShell(v, { extraBins: collectBins(v, projectRoot(v, cwd) ?? cwd), seedEnv: seed !== undefined ? shellEnvOf(seed) : undefined })
  register('npm', (args, { cwd, env, progress }) => npmCommand(v, args, { cwd, scriptShell, flavor: 'npm', registerLive, progress, env }))
  register('pnpm', (args, { cwd, env, progress }) => pnpmCommand(v, args, { cwd, scriptShell, registerLive, progress, env }))
  register('npx', (args, { cwd, progress }) => npx(v, args, { cwd, progress }))
  register('pnpx', (args, { cwd, progress }) => npx(v, args, { cwd, progress }))
  register('cell', (args, { cwd, progress }) => cellCommand(v, args, { cwd, shell: nestedShell(), onProgress: progress }))
  const pythonRegister = (args: string[], ctx: { cwd: string; env: Map<string, string>; stdin?: unknown; progress?: (line: string) => void }) =>
    pythonCommand(v, args, { cwd: ctx.cwd, env: ctx.env, stdin: typeof ctx.stdin === 'string' ? ctx.stdin : undefined, progress: ctx.progress })
  register('curl', (args, { cwd }) => curlCommand(v, args, { cwd }))

  register('python', (args, ctx) => pythonRegister(args, { ...ctx, stdin: typeof ctx.stdin === 'string' ? ctx.stdin : undefined, progress: ctx.progress }))
  register('pip', (args, ctx) => pipRegister(args, ctx))
  register('pip3', (args, ctx) => pipRegister(args, ctx))
  const pipRegister = async (args: string[], ctx: { cwd: string }): Promise<CommandResult> =>
    pythonCommand(v, ['-c',
      args[0] === 'install' && args.length > 1
        ? `import micropip\nawait micropip.install(${JSON.stringify(args.slice(1))})\nprint('installed: ' + ' '.join(${JSON.stringify(args.slice(1))}))`
        : args[0] === 'list'
          ? "import pyodide; [print(f'{k}=={v}') for k, v in pyodide.loadedPackages.items()]"
          : `import sys\nprint('usage: pip install <package> | pip list', file=sys.stderr); sys.exit(1)`,
    ], { cwd: ctx.cwd })
  register('python3', (args, ctx) => pythonRegister(args, { ...ctx, stdin: typeof ctx.stdin === 'string' ? ctx.stdin : undefined, progress: ctx.progress }))

  // global package bins (~/.local/lib/node_modules) are real PATH commands:
  // registered at shell creation for bins installed in earlier sessions, and
  // re-registered live when `npm install -g` adds new ones
  const registeredBins = new Set<string>()
  const registerBin = (binName: string, entry: string) => {
    const key = `${binName}::${entry}`
    if (registeredBins.has(key)) return
    registeredBins.add(key)
    register(binName, (args, { cwd }) => runNodeEntry(v, entry, args, cwd, binName))
  }
  for (const [binName, entry] of collectBins(v, GLOBAL_ROOT)) {
    registerBin(binName, entry)
  }
  for (const [binName, entry] of opts?.extraBins ?? []) {
    registerBin(binName, entry)
  }
  const registerLive = (binName: string) => {
    const entry = collectBins(v, GLOBAL_ROOT).get(binName)
    if (entry !== undefined) registerBin(binName, entry)
  }

  return shell
}
