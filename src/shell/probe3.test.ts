import { describe, expect, it } from 'vitest'
import { Bash } from 'just-bash'
import { VfsBackedFs } from './vfs-fs'
import { createVfs } from '../vfs'

describe('probe abort semantics', () => {
  it('does output before the bad line survive; does bash -n check syntax', async () => {
    const vfs = createVfs()
    const fs = new VfsBackedFs(vfs)
    const bash = new Bash({ fs: fs as never, cwd: '/home/user', env: {} })
    await fs.writeFile('/tmp/mixed.sh', 'echo FIRST\necho "unclosed\necho THIRD')
    const r = await bash.exec(`source '/tmp/mixed.sh' || RC=$?; echo "EPILOGUE rc=$RC"`, {
      cwd: '/home/user',
      env: {} as never,
    })
    console.log('PROBE mixed stdout:', JSON.stringify(r.stdout), 'exit:', r.exitCode, 'stderr:', JSON.stringify(r.stderr).slice(0, 200))
    const n = await bash.exec(`bash -n /tmp/mixed.sh; echo "check=$?"`, { cwd: '/home/user', env: {} as never })
    console.log('PROBE bash-n stdout:', JSON.stringify(n.stdout), 'exit:', n.exitCode, 'stderr:', JSON.stringify(n.stderr).slice(0, 200))
    await fs.writeFile('/tmp/good.sh', 'echo ok\n')
    const n2 = await bash.exec(`bash -n /tmp/good.sh; echo "check=$?"`, { cwd: '/home/user', env: {} as never })
    console.log('PROBE bash-n-good stdout:', JSON.stringify(n2.stdout), 'exit:', n2.exitCode, 'stderr:', JSON.stringify(n2.stderr).slice(0, 200))
    expect(true).toBe(true)
  })
})
