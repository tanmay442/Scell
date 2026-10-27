import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { installPackages } from '../shell/commands/install'
import { bundleEntry } from './bundle'

/**
 * Bundles a real TSX app through esbuild-wasm with react/react-dom installed
 * from the live registry — the same pipeline cell preview uses.
 */

async function appVfs() {
  const vfs = createVfs()
  vfs.mkdir('/home/user/app/src')
  await installPackages(vfs, [{ name: 'react' }, { name: 'react-dom' }], '/home/user/app')
  vfs.write('/home/user/app/index.html', '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>')
  vfs.write(
    '/home/user/app/src/main.tsx',
    `import React from 'react'
import { createRoot } from 'react-dom/client'
import { Greeting } from './greeting'
import './app.css'

const el: HTMLElement | null = document.getElementById('root')
if (el) createRoot(el).render(<Greeting name="Cell" />)
`,
  )
  vfs.write(
    '/home/user/app/src/greeting.tsx',
    `import React from 'react'
export function Greeting({ name }: { name: string }) {
  return <h1 className="title">hello {name}</h1>
}
`,
  )
  vfs.write('/home/user/app/src/app.css', '@import "tailwindcss";\n.title { color: rebeccapurple; }\n')
  return vfs
}

describe('bundleEntry (esbuild-wasm over the VFS)', () => {
  it(
    'bundles a TSX app with react from the registry',
    async () => {
      const vfs = await appVfs()
      const result = await bundleEntry(vfs, '/home/user/app', '/home/user/app/src/main.tsx')
      if ('error' in result) throw new Error(result.error)
      // react got bundled: the iife contains its signature strings
      expect(result.js).toMatch(/createRoot|react-dom/)
      expect(result.js).toMatch(/hello/)
      // the css side-effect import was captured, not bundled into js
      expect(result.css).toContain('.title')
      expect(result.tailwind).toBe(true)
    },
    180_000,
  )

  it(
    'reports resolution failures honestly',
    async () => {
      const vfs = createVfs()
      vfs.mkdir('/home/user/broken')
      vfs.write('/home/user/broken/main.ts', "import thing from 'does-not-exist-anywhere'\nconsole.log(thing)\n")
      const result = await bundleEntry(vfs, '/home/user/broken', '/home/user/broken/main.ts')
      expect('error' in result).toBe(true)
      if ('error' in result) expect(result.error).toContain('does-not-exist-anywhere')
    },
    120_000,
  )
})

describe('subpath exports resolution', () => {
  it(
    "resolves '@vercel/analytics/react' through the package exports map",
    async () => {
      const vfs = createVfs()
      vfs.mkdir('/home/user/app')
      await installPackages(vfs, [{ name: '@vercel/analytics' }, { name: 'react' }], '/home/user/app')
      vfs.write(
        '/home/user/app/main.tsx',
        `import { Analytics } from '@vercel/analytics/react'
console.log(Analytics)
`,
      )
      const result = await bundleEntry(vfs, '/home/user/app', '/home/user/app/main.tsx')
      if ('error' in result) throw new Error(result.error)
      expect(result.js).toMatch(/react/i)
      expect(result.js.length).toBeGreaterThan(500)
    },
    180_000,
  )
})
