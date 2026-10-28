import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { curlCommand } from './curl'
import { tscCommand } from './tsc-cmd'

/** CLI error paths that need no network, no workers, no language service. */
describe('cli fallbacks', () => {
  it('curl explains itself without a URL and fails honestly offline', async () => {
    const vfs = createVfs()
    const usage = await curlCommand(vfs, [], { cwd: '/home/user' })
    expect(usage.exitCode).toBe(2)
    expect(usage.stderr).toContain('curl')
    const dead = await curlCommand(vfs, ['http://127.0.0.1:1/nope', '--max-time', '2'], { cwd: '/home/user' })
    expect(dead.exitCode).toBe(1)
    expect(dead.stderr).toContain('curl: (1)')
  })

  it('tsc reports its version and the missing service in node', async () => {
    const vfs = createVfs()
    const version = await tscCommand(vfs, ['--version'])
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toContain('Version')
    const run = await tscCommand(vfs, ['--noEmit'], { cwd: '/home/user' })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('language service not started')
  })
})
