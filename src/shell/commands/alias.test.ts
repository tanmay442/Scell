import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { installPackages, readManifest } from './install'

describe('npm alias dependencies', () => {
  it('installs npm:<real>@<version> under the alias key', async () => {
    const vfs = createVfs()
    vfs.mkdir('/home/user')
    await installPackages(vfs, [{ name: 'my-ms', range: 'npm:ms@2.1.3' }], '/home/user')
    const manifest = readManifest(vfs, '/home/user/node_modules/my-ms/package.json')
    expect(manifest?.name).toBe('ms')
    expect(manifest?.version).toBe('2.1.3')
    // the aliased package's files are really there
    expect(vfs.isFile('/home/user/node_modules/my-ms/index.js')).toBe(true)
  }, 60000)
})
