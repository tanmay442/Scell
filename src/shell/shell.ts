import { Bash, defineCommand, type CustomCommand } from 'just-bash'
import { platform } from '../platform'
import type { Vfs } from '../vfs/types'
import { VfsBackedFs } from './vfs-fs'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Shell {
  exec(cmd: string, cwd?: string): Promise<ShellResult>
  registerCommand(name: string, fn: (args: string[]) => Promise<ShellResult> | ShellResult): void
}

const BASH_CWD_ROOT = '/workspace'

/**
 * One long-lived just-bash instance whose filesystem is the Cell Vfs.
 * Shell state (env, cwd) resets per exec by design in just-bash — callers
 * pass cwd explicitly, which is also how a terminal emulator does it.
 */
export function createShell(vfs?: Vfs): Shell {
  const fs = new VfsBackedFs(vfs ?? platform().vfs)
  const bash = new Bash({
    fs,
    cwd: BASH_CWD_ROOT,
    env: {
      HOME: '/home/user',
      USER: 'cell',
      SHELL: '/bin/bash',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
    },
  })

  return {
    async exec(cmd, cwd) {
      const result = await bash.exec(cmd, { cwd: cwd ?? BASH_CWD_ROOT })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    },
    registerCommand(name, fn) {
      const command: CustomCommand = defineCommand(name, async (args) => {
        const r = await fn(args)
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
      })
      bash.registerCommand(command)
    },
  }
}
