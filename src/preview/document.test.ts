import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { buildPreviewDocument, mimeForPath } from './document'

const HTML = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'

function plainProject() {
  const vfs = createVfs()
  vfs.write('/app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }))
  vfs.write('/app/index.html', HTML)
  vfs.write('/app/src/main.tsx', "import './index.css'\nconsole.log('hi')\n")
  vfs.write('/app/src/index.css', 'body { color: red; }\n')
  return vfs
}

function tailwindProject() {
  const vfs = plainProject()
  vfs.write('/app/src/index.css', '@import "tailwindcss";\nbody { color: red; }\n')
  return vfs
}

describe('preview document', () => {
  it('inlines bundled css for plain stylesheets without warnings', async () => {
    const result = await buildPreviewDocument(plainProject(), '/app')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.warnings).toEqual([])
    expect(result.html).toContain('body { color: red; }')
    expect(result.html).not.toContain('text/tailwindcss')
  })

  it('warns instead of silently shipping uncompiled tailwind when the runtime is unavailable', async () => {
    // node has no dev server for the ?url runtime, so the fetch fails and
    // the builder must take the degraded path LOUDLY (the fresh-clone bug)
    const result = await buildPreviewDocument(tailwindProject(), '/app')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.warnings.some((w) => w.includes('tailwindcss'))).toBe(true)
    expect(result.html).toContain('@import "tailwindcss"')
  })

  it('reports a missing entry instead of an empty document', async () => {
    const vfs = createVfs()
    const result = await buildPreviewDocument(vfs, '/missing')
    expect('error' in result).toBe(true)
  })

  it('mimeForPath covers served asset types with a safe default', () => {
    expect(mimeForPath('/logo.svg')).toBe('image/svg+xml')
    expect(mimeForPath('/photo.webp')).toBe('image/webp')
    expect(mimeForPath('/app.js')).toBe('text/javascript')
    expect(mimeForPath('/font.woff2')).toBe('font/woff2')
    expect(mimeForPath('/blob.unknown-ext')).toBe('application/octet-stream')
  })
})
