import { describe, expect, it } from 'vitest'
import { Bash } from 'just-bash'
import { VfsBackedFs } from './vfs-fs'
import { createVfs } from '../vfs'

describe('probe env mutation', () => {
  it('does bash.exec mutate the passed env object on export', async () => {
    const vfs = createVfs()
    const fs = new VfsBackedFs(vfs)
    const bash = new Bash({ fs: fs as never, cwd: '/home/user', env: { FOO: 'bar' } })
    const box: Record<string, string> = { FOO: 'bar' }
    const r1 = await bash.exec('export NEWVAR=hello; X=plain; echo done', { cwd: '/home/user', env: box as never })
    console.log('PROBE r1:', JSON.stringify(r1.stdout), 'exit:', r1.exitCode)
    console.log('PROBE box after:', JSON.stringify(box))
    // second exec with the SAME box: does it see NEWVAR?
    const r2 = await bash.exec('echo "nv=$NEWVAR x=$X"', { cwd: '/home/user', env: box as never })
    console.log('PROBE r2:', JSON.stringify(r2.stdout))
    expect(true).toBe(true)
  })

  it('custom dump command in a second exec sees prior exports', async () => {
    const vfs = createVfs()
    const fs = new VfsBackedFs(vfs)
    const bash = new Bash({ fs: fs as never, cwd: '/home/user', env: {} })
    const { defineCommand } = await import('just-bash')
    bash.registerCommand(
      defineCommand('dump-env', async (_args: string[], ctx: { env?: Map<string, string> }) => {
        const entries: Record<string, string> = {}
        for (const [k, v] of ctx.env ?? new Map<string, string>()) entries[k] = v
        return { stdout: `DUMP:${JSON.stringify(entries)}\n`, stderr: '', exitCode: 0 }
      }),
    )
    const box: Record<string, string> = {}
    await bash.exec('export A=1', { cwd: '/home/user', env: box as never })
    const r = await bash.exec('dump-env', { cwd: '/home/user', env: box as never })
    console.log('PROBE dump:', JSON.stringify(r.stdout).slice(0, 300))
    expect(true).toBe(true)
  })
})
