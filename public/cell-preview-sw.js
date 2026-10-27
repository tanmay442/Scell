/**
 * Cell preview service worker: the preview iframe must load the generated
 * app document from a REAL url on this origin (pathname '/', so router apps
 * match their routes; about:srcdoc breaks them and history.replaceState is
 * forbidden there). The panel generates the document, hands it over here,
 * waits for the ack, then points the iframe at /?cellpreview=<token>.
 */

const CACHE = 'cell-preview-v2'

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
  const reply = (payload: unknown) => {
    if (event.source && 'postMessage' in event.source) {
      ;(event.source as Window).postMessage(payload)
    }
  }
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE)
        // put FIRST, then evict everything except the fresh entry — a
        // delete-all before the put raced navigations into "preview expired"
        await cache.put(msg.url, new Response(msg.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
        for (const key of await cache.keys()) {
          if (key.url !== msg.url) await cache.delete(key)
        }
        reply({ type: 'cell-preview-put-done', url: msg.url })
      } catch (err) {
        reply({ type: 'cell-preview-put-done', url: msg.url, error: err instanceof Error ? err.message : String(err) })
      }
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
        if (hit) return hit
        // the document may still be mid-put (reload raced the write) —
        // wait briefly before declaring it expired
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          const retry = await cache.match(event.request)
          if (retry) return retry
        }
        return new Response('<h1>preview expired — run cell preview again</h1>', { status: 404, headers: { 'content-type': 'text/html' } })
      })(),
    )
  }
})
