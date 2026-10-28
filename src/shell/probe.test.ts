import { describe, expect, it } from 'vitest'
import { Bash } from 'just-bash'
import { VfsBackedFs } from './vfs-fs'
import { createVfs } from '../vfs'

function testBash() {
  const vfs = createVfs()
  const fs = new VfsBackedFs(vfs)
  const bash = new Bash({ fs: fs as never, cwd: '/home/user', env: { FOO: 'bar' } })
  return { bash, fs, vfs }
}

describe('probe just-bash semantics', () => {
  it('what is ctx.env in a custom command', async () => {
    const { bash } = testBash()
    let seen: unknown = 'NOT-CALLED'
    const { defineCommand } = await import('just-bash')
    bash.registerCommand(
      defineCommand('probe-env', async (_args: string[], ctx: unknown) => {
        const env = (ctx as { env?: unknown }).env
        seen = {
          isMap: env instanceof Map,
          ctor: (env as object)?.constructor?.name,
          keys: env instanceof Map ? [...env.keys()] : Object.keys((env as object) ?? {}),
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
    )
    const r = await bash.exec('probe-env', { cwd: '/home/user', env: { A: '1' } as never })
    console.log('PROBE env:', JSON.stringify(seen), 'exit:', r.exitCode, 'stderr:', JSON.stringify(r.stderr).slice(0, 200))
    expect(true).toBe(true)
  })

  it('source of a file with unclosed quote: does the epilogue run', async () => {
    const { bash, fs } = testBash()
    await fs.writeFile('/tmp/bad.sh', 'echo "unclosed')
    const r = await bash.exec(`source '/tmp/bad.sh' || RC=$?; echo "EPILOGUE rc=$RC"`, {
      cwd: '/home/user',
      env: { FOO: 'bar' } as never,
    })
    console.log('PROBE source-bad stdout:', JSON.stringify(r.stdout), 'exit:', r.exitCode, 'stderr:', JSON.stringify(r.stderr).slice(0, 300))
    expect(true).toBe(true)
  })

  it('function exit shadow + return outside source', async () => {
    const { bash } = testBash()
    const r = await bash.exec(`exit() { return \${1:-0}; } 2>/dev/null; echo after-fn`, {
      cwd: '/home/user',
      env: {} as never,
    })
    console.log('PROBE fn stdout:', JSON.stringify(r.stdout), 'exit:', r.exitCode, 'stderr:', JSON.stringify(r.stderr).slice(0, 300))
    expect(true).toBe(true)
  })

  it('prefix assignment scoping + trap support', async () => {
    const { bash } = testBash()
    const r1 = await bash.exec(`XQ=99 env | grep XQ; echo "outer:$XQ"`, { cwd: '/home/user', env: {} as never })
    console.log('PROBE prefix stdout:', JSON.stringify(r1.stdout), 'exit:', r1.exitCode, 'stderr:', JSON.stringify(r1.stderr).slice(0, 200))
    const r2 = await bash.exec(`trap 'echo TRAPPED' EXIT; echo body`, { cwd: '/home/user', env: {} as never })
    console.log('PROBE trap stdout:', JSON.stringify(r2.stdout), 'exit:', r2.exitCode, 'stderr:', JSON.stringify(r2.stderr).slice(0, 200))
    expect(true).toBe(true)
  })
})
