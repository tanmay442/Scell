import type { Vfs } from '../../vfs/types'
import { projectRoot } from './install'

/**
 * Slash commands: ~/.cell/commands/*.md (plus <project>/.cell/commands/
 * overrides) expanded into the prompt before the model sees it. A file
 * `commit.md` makes `/commit` shorthand for its body; trailing words after
 * the command name are appended as arguments.
 *
 * Seeds (commit, preview) ship via starter.ts and as code fallbacks here so
 * older homes still resolve them.
 */

const COMMANDS_DIR = '/home/user/.cell/commands'

/** Slash names are bare stems — never paths, never traversal (P1-7). */
const SLASH_NAME = /^[A-Za-z0-9_-]+$/

export function isSafeCommandName(name: string): boolean {
  return SLASH_NAME.test(name)
}

export const BUILTIN_COMMANDS: Record<string, string> = {
  commit: 'Review `git status` and `git diff`, stage the files that belong together, and commit with a clear imperative message. Verify with `git log --oneline -3`.',
  preview: 'Run `cell preview` for this project and verify it bundles and renders. Report bundler errors and fix missing installs.',
}

function readDirSafe(vfs: Vfs, dir: string): string[] {
  try {
    return vfs.isDir(dir) ? vfs.readDir(dir) : []
  } catch {
    return []
  }
}

export function loadCommand(vfs: Vfs, cwd: string, name: string): string | null {
  if (!isSafeCommandName(name)) return null
  const root = projectRoot(vfs, cwd)
  if (root !== null) {
    const projectFile = `${root}/.cell/commands/${name}.md`
    const raw = vfs.read(projectFile)
    if (raw !== null) return raw
  }
  const homeFile = `${COMMANDS_DIR}/${name}.md`
  const raw = vfs.read(homeFile)
  if (raw !== null) return raw
  return BUILTIN_COMMANDS[name] ?? null
}

export function listCommands(vfs: Vfs, cwd: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_COMMANDS))
  for (const name of readDirSafe(vfs, COMMANDS_DIR)) {
    if (name.endsWith('.md')) names.add(name.slice(0, -3))
  }
  const root = projectRoot(vfs, cwd)
  if (root !== null) {
    for (const name of readDirSafe(vfs, `${root}/.cell/commands`)) {
      if (name.endsWith('.md')) names.add(name.slice(0, -3))
    }
  }
  return [...names].sort()
}

/** Expand a leading /command into its full prompt. Non-slash prompts pass through. */
export function expandSlashCommand(vfs: Vfs, cwd: string, prompt: string): { prompt: string; command?: string } {
  if (!prompt.startsWith('/')) return { prompt }
  const space = prompt.indexOf(' ')
  const name = (space === -1 ? prompt.slice(1) : prompt.slice(1, space)).trim()
  if (name === '') return { prompt }
  const rest = space === -1 ? '' : prompt.slice(space + 1).trim()
  const body = loadCommand(vfs, cwd, name)
  if (body === null) return { prompt }
  return { prompt: rest === '' ? body : `${body}\n\n${rest}`, command: name }
}
