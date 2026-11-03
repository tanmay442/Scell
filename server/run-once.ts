import { runAgent } from '../src/shell/commands/agent'
import { createDiskVfs } from './disk-vfs'
import { createNodeShell } from './node-shell'
import { ensureAgentConfig } from './bootstrap'

interface RunOnceOptions {
  words: string[]
  resumeId: string | null
  steps: number
  cwd: string
  workspace: string
  timeoutMs: number
}

function parseArgv(argv: string[]): RunOnceOptions {
  const words: string[] = []
  let resumeId: string | null = null
  let steps = Number.POSITIVE_INFINITY
  let cwd = '/home/user'
  let workspace = process.env.CELL_WORKSPACE || './cell-workspace'
  let timeoutMs = Number(process.env.CELL_TIMEOUT_MS || '600000')
  if (Number.isNaN(timeoutMs)) timeoutMs = 600000
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--resume') {
      const id = argv[++i]
      if (id === undefined || id.startsWith('--')) throw new Error('--resume needs a session id')
      resumeId = id
    } else if (arg === '--steps') {
      const raw = argv[++i]
      steps = Number(raw)
      if (!Number.isFinite(steps) || steps <= 0) throw new Error(`invalid --steps '${raw ?? ''}'`)
    } else if (arg === '--cwd') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--cwd needs a VFS path')
      cwd = value
    } else if (arg === '--workspace') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--workspace needs a directory')
      workspace = value
    } else if (arg === '--timeout-ms') {
      const raw = argv[++i]
      timeoutMs = Number(raw)
      if (Number.isNaN(timeoutMs) || timeoutMs < 0) throw new Error(`invalid --timeout-ms '${raw ?? ''}'`)
    } else {
      words.push(arg)
    }
  }
  return { words, resumeId, steps, cwd, workspace, timeoutMs }
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2))
  const vfs = createDiskVfs(opts.workspace)
  ensureAgentConfig(vfs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const args = [...opts.words]
    if (opts.resumeId !== null) args.push('--resume', opts.resumeId)
    const result = await runAgent(
      vfs,
      args,
      {
        cwd: opts.cwd,
        shell: createNodeShell(opts.workspace),
        jobShell: createNodeShell(opts.workspace),
        signal: controller.signal,
        maxSteps: opts.steps,
        onProgress: (line) => process.stderr.write(`${line}\n`),
      },
    )
    if (result.stdout !== '') process.stdout.write(result.stdout)
    if (result.stderr !== '') process.stderr.write(result.stderr)
    process.exit(result.exitCode)
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

main().catch((err) => {
  process.stderr.write(`cell run-once: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
})
