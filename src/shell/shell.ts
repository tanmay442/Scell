import { Bash, defineCommand } from 'just-bash'
import { platform } from '../platform'
import type { Vfs } from '../vfs/types'
import { VfsBackedFs } from './vfs-fs'
import { nodeCommand } from './commands/node-cmd'
import { npmCommand, npx, pnpmCommand, runNodeEntry, type CommandResult } from './commands/npm'
import { collectBins, GLOBAL_ROOT } from './commands/install'
import { gitCommand } from './commands/git'
import { tscCommand } from './commands/tsc-cmd'
import { cellCommand } from './commands/cell-cmd'
import { curlCommand } from './commands/curl'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Shell {
  exec(cmd: string, cwd?: string): Promise<ShellResult>
}

function toResult(result: CommandResult | ShellResult): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

export const HOME_DIR = '/home/user'

/**
 * One long-lived just-bash instance whose filesystem is the Cell Vfs
 * (identity mapping — the shell sees a real user machine rooted at / with
 * HOME=/home/user), plus the platform commands: node (V8 isolate),
 * npm/pnpm/npx (real registry), tsc (ts-rust WASM) and git (libgit2 WASM).
 */
export function createShell(vfs?: Vfs): Shell {
  const fs = new VfsBackedFs(vfs ?? platform().vfs)
  const bash = new Bash({
    fs,
    cwd: HOME_DIR,
    env: {
      HOME: HOME_DIR,
      USER: 'user',
      SHELL: '/bin/bash',
      PATH: '/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
    },
  })

  const shell: Shell = {
    async exec(cmd, cwd) {
      const result = await bash.exec(cmd, { cwd: cwd ?? HOME_DIR })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    },
  }

  // A fresh shell for nested calls (npm run <script> runs its own bash).
  const nestedShell = (): Shell => createShell(vfs ?? platform().vfs)

  const register = (name: string, fn: (args: string[], ctx: { cwd: string }) => Promise<CommandResult> | CommandResult) => {
    bash.registerCommand(
      defineCommand(name, async (args: string[], ctx: { cwd?: string }) => {
        try {
          return toResult(await fn(args, { cwd: ctx.cwd ?? HOME_DIR }))
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

  register('node', (args, { cwd }) => nodeCommand(vfs ?? platform().vfs, args, { cwd }))
  register('tsc', (args, { cwd }) => tscCommand(vfs ?? platform().vfs, args, { cwd }))
  register('git', (args, { cwd }) => gitCommand(vfs ?? platform().vfs, args, { cwd }))
  register('npm', (args, { cwd }) =>
    npmCommand(vfs ?? platform().vfs, args, { cwd, shell: nestedShell(), flavor: 'npm', registerLive }),
  )
  register('pnpm', (args, { cwd }) => pnpmCommand(vfs ?? platform().vfs, args, { cwd, shell: nestedShell(), registerLive }))
  register('npx', (args, { cwd }) => npx(vfs ?? platform().vfs, args, { cwd }))
  register('pnpx', (args, { cwd }) => npx(vfs ?? platform().vfs, args, { cwd }))
  register('cell', (args, { cwd }) => cellCommand(vfs ?? platform().vfs, args, { cwd, shell: nestedShell() }))
  register('curl', (args, { cwd }) => curlCommand(vfs ?? platform().vfs, args, { cwd }))

  // global package bins (~/.local/lib/node_modules) are real PATH commands:
  // registered at shell creation for bins installed in earlier sessions, and
  // re-registered live when `npm install -g` adds new ones
  const registeredBins = new Set<string>()
  const registerGlobalBin = (binName: string, entry: string) => {
    if (registeredBins.has(binName)) return
    registeredBins.add(binName)
    register(binName, (args, { cwd }) => runNodeEntry(vfs ?? platform().vfs, entry, args, cwd, binName))
  }
  for (const [binName, entry] of collectBins(vfs ?? platform().vfs, GLOBAL_ROOT)) {
    registerGlobalBin(binName, entry)
  }
  const registerLive = (binName: string) => {
    const entry = collectBins(vfs ?? platform().vfs, GLOBAL_ROOT).get(binName)
    if (entry !== undefined) registerGlobalBin(binName, entry)
  }

  return shell
}
