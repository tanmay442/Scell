/**
 * Cell preview service worker: the preview iframe must load the generated
 * app document from a REAL url on this origin (pathname '/', so router apps
 * match their routes; about:srcdoc breaks them and history.replaceState is
 * forbidden there). The panel generates the document, hands it over here,
 * and the iframe's navigation to /?cellpreview=<token> is answered from the
 * cache — before the network, in dev and on a single isolate alike.
 */

const CACHE = 'cell-preview-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || msg.type !== 'cell-preview-put') return
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // one live preview at a time: drop the previous documents
      for (const key of await cache.keys()) await cache.delete(key)
      await cache.put(msg.url, new Response(msg.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.mode === 'navigate' && url.pathname === '/' && url.searchParams.has('cellpreview')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const hit = await cache.match(event.request)
        return hit ?? new Response('<h1>preview expired — run cell preview again</h1>', { status: 404, headers: { 'content-type': 'text/html' } })
      })(),
    )
  }
})
