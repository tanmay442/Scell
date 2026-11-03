import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LocalDirStore, pullSnapshot, pushSnapshot } from './snapshots'
import { createDiskVfs } from './disk-vfs'

function hasTar(): boolean {
  try {
    const result = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}

const describeIfTar = hasTar() ? describe : describe.skip

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describeIfTar('snapshots', () => {
  it('roundtrips a fixture tree (text + binary, files only)', async () => {
    const workspace = tempRoot('snap-ws-')
    const storeDir = tempRoot('snap-store-')
    try {
      const vfs = createDiskVfs(workspace)
      vfs.write('/hello.txt', 'hello world')
      vfs.write('/nested/deep/file.txt', 'deep content')
      vfs.writeBytes('/blob.bin', new Uint8Array([0, 1, 2, 255, 0, 10, 20]))
      vfs.mkdir('/emptydir')

      const store = LocalDirStore(storeDir)
      const pushed = await pushSnapshot(workspace, store, 'ws1')
      expect(pushed.skipped).toBe(false)
      expect(pushed.manifest.name).toBe('ws1')
      expect(pushed.manifest.files.map((f) => f.path).sort()).toEqual(
        ['/blob.bin', '/hello.txt', '/nested/deep/file.txt'].sort(),
      )
      expect(existsSync(join(storeDir, 'ws1.tar'))).toBe(true)
      expect(existsSync(join(storeDir, 'ws1.manifest.json'))).toBe(true)

      // mutate then restore into a fresh root
      vfs.write('/hello.txt', 'changed')
      vfs.write('/extra.txt', 'extra')
      const pulled = await pullSnapshot(workspace, store, 'ws1')
      expect(pulled.status).toBe('restored')
      expect(pulled.manifest?.name).toBe('ws1')
      expect(vfs.read('/hello.txt')).toBe('hello world')
      expect(vfs.exists('/extra.txt')).toBe(false)
      expect(vfs.readBytes('/blob.bin')).toEqual(new Uint8Array([0, 1, 2, 255, 0, 10, 20]))
      expect(vfs.read('/nested/deep/file.txt')).toBe('deep content')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('skips writing the tar when the manifest is identical', async () => {
    const workspace = tempRoot('snap-skip-ws-')
    const storeDir = tempRoot('snap-skip-store-')
    try {
      const vfs = createDiskVfs(workspace)
      vfs.write('/a.txt', 'aaa')
      const store = LocalDirStore(storeDir)
      const first = await pushSnapshot(workspace, store, 'same')
      expect(first.skipped).toBe(false)
      const tarBytes = new Uint8Array(readFileSync(join(storeDir, 'same.tar')))
      const second = await pushSnapshot(workspace, store, 'same')
      expect(second.skipped).toBe(true)
      expect(second.manifest.files).toEqual(first.manifest.files)
      // tar untouched by the skipped push
      expect(new Uint8Array(readFileSync(join(storeDir, 'same.tar')))).toEqual(tarBytes)

      // a change forces a rewrite
      vfs.write('/a.txt', 'bbb')
      const third = await pushSnapshot(workspace, store, 'same')
      expect(third.skipped).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('fresh pull leaves the root as-is', async () => {
    const workspace = tempRoot('snap-fresh-ws-')
    const storeDir = tempRoot('snap-fresh-store-')
    try {
      const vfs = createDiskVfs(workspace)
      vfs.write('/keep.txt', 'keep me')
      const store = LocalDirStore(storeDir)
      const pulled = await pullSnapshot(workspace, store, 'never-pushed')
      expect(pulled.status).toBe('fresh')
      expect(pulled.manifest).toBeUndefined()
      expect(vfs.read('/keep.txt')).toBe('keep me')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('slim excludes node_modules', async () => {
    const workspace = tempRoot('snap-slim-ws-')
    const storeDir = tempRoot('snap-slim-store-')
    try {
      const vfs = createDiskVfs(workspace)
      vfs.write('/index.js', 'console.log(1)')
      vfs.write('/node_modules/dep/index.js', 'dep code')
      vfs.write('/src/node_modules/nested.js', 'nested dep')

      const store = LocalDirStore(storeDir)
      const full = await pushSnapshot(workspace, store, 'full')
      expect(full.manifest.files.map((f) => f.path)).toContain('/node_modules/dep/index.js')

      const slim = await pushSnapshot(workspace, store, 'slim', { slim: true })
      const paths = slim.manifest.files.map((f) => f.path)
      expect(paths).toContain('/index.js')
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false)

      // restore slim into a clean root: node_modules must not come back
      const clean = tempRoot('snap-slim-clean-')
      try {
        const pulled = await pullSnapshot(clean, store, 'slim')
        expect(pulled.status).toBe('restored')
        const cleanVfs = createDiskVfs(clean)
        expect(cleanVfs.read('/index.js')).toBe('console.log(1)')
        expect(cleanVfs.exists('/node_modules/dep/index.js')).toBe(false)
      } finally {
        rmSync(clean, { recursive: true, force: true })
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('supports custom exclude patterns', async () => {
    const workspace = tempRoot('snap-excl-ws-')
    const storeDir = tempRoot('snap-excl-store-')
    try {
      const vfs = createDiskVfs(workspace)
      vfs.write('/keep.txt', 'keep')
      vfs.write('/skip.log', 'logs')
      const store = LocalDirStore(storeDir)
      const pushed = await pushSnapshot(workspace, store, 'excl', { exclude: [/\.log$/] })
      expect(pushed.manifest.files.map((f) => f.path)).toEqual(['/keep.txt'])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('LocalDirStore roundtrips raw keys', async () => {
    const storeDir = tempRoot('snap-raw-store-')
    try {
      const store = LocalDirStore(storeDir)
      expect(await store.get('missing.bin')).toBeNull()
      await store.put('missing.bin', new Uint8Array([1, 2, 3]))
      expect(await store.get('missing.bin')).toEqual(new Uint8Array([1, 2, 3]))
      // direct file layout: <dir>/<key>
      expect(existsSync(join(storeDir, 'missing.bin'))).toBe(true)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})

describeIfTar('snapshot integrity (adversarial)', () => {
  it('rejects archives containing symlinks, even to in-workspace targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-evil-'))
    try {
      const vfs = createDiskVfs(root)
      vfs.mkdir('/home/user/threads/t')
      vfs.write('/home/user/threads/t/real.txt', 'real')
      const { symlinkSync } = await import('node:fs')
      symlinkSync(join(root, 'home', 'user', 'threads', 't', 'real.txt'), join(root, 'home', 'user', 'threads', 't', 'evillink'))
      const store = LocalDirStore(mkdtempSync(join(tmpdir(), 'snap-store-')))
      await pushSnapshot(root, store, 'evil')
      const fresh = mkdtempSync(join(tmpdir(), 'snap-fresh-'))
      try {
        await expect(pullSnapshot(fresh, store, 'evil')).rejects.toThrow(/symlink/)
      } finally {
        rmSync(fresh, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to restore when tar bytes do not match the manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-mismatch-'))
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/a.txt', 'VERSION-ONE')
      const store = LocalDirStore(mkdtempSync(join(tmpdir(), 'snap-store-')))
      await pushSnapshot(root, store, 'v')
      // swap: push v2 content, then rewind the manifest to the v1 bytes
      const manifestKey = 'v.manifest.json'
      const oldManifest = await store.get(manifestKey)
      vfs.write('/a.txt', 'VERSION-TWO-ATTACKER')
      await pushSnapshot(root, store, 'v')
      if (oldManifest !== null) await store.put(manifestKey, oldManifest)
      const fresh = mkdtempSync(join(tmpdir(), 'snap-fresh-'))
      try {
        await expect(pullSnapshot(fresh, store, 'v')).rejects.toThrow(/do not match/)
      } finally {
        rmSync(fresh, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws (instead of fresh) when the tar exists without a manifest', async () => {
    const store = LocalDirStore(mkdtempSync(join(tmpdir(), 'snap-store-')))
    try {
      await store.put('orphan.tar', new Uint8Array([1, 2, 3]))
      const fresh = mkdtempSync(join(tmpdir(), 'snap-fresh-'))
      try {
        await expect(pullSnapshot(fresh, store, 'orphan')).rejects.toThrow(/corrupt/)
      } finally {
        rmSync(fresh, { recursive: true, force: true })
      }
    } finally {
      // store dir cleanup best-effort
    }
  })

  it('leaves existing workspace files alone when the tar is corrupt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-keep-'))
    try {
      const vfs = createDiskVfs(root)
      vfs.write('/precious.txt', 'keep me')
      const store = LocalDirStore(mkdtempSync(join(tmpdir(), 'snap-store-')))
      await pushSnapshot(root, store, 'good')
      // corrupt the stored tar behind a valid manifest
      const fixedBytes = new TextEncoder().encode('not a tar at all')
      await store.put('good.tar', fixedBytes)
      await expect(pullSnapshot(root, store, 'good')).rejects.toThrow()
      expect(vfs.read('/precious.txt')).toBe('keep me')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
