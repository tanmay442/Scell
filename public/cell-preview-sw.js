/**
 * Cell preview service worker: the preview iframe must load the generated
 * app document from a REAL url on this origin (pathname '/', so router apps
 * match their routes; about:srcdoc breaks them and history.replaceState is
 * forbidden there).
 *
 * The PANEL writes the document straight into Cache Storage from the page
 * (CacheStorage is shared origin-wide — no message channel needed), then
 * navigates the iframe to /?cellpreview=<token>. This worker only SERVES:
 * every navigation to that url comes from the cache.
 *
 * PLAIN JAVASCRIPT — the browser parses service worker scripts without a
 * transpiler; a type annotation here silently kills the whole preview.
 */

const CACHE = 'cell-preview-v3'

self.addEventListener('install', function (event) {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE))
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const names = await caches.keys()
      for (const name of names) {
        if (name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url)
  if (event.request.mode === 'navigate' && url.pathname === '/' && url.searchParams.has('cellpreview')) {
    event.respondWith(
      (async function () {
        const cache = await caches.open(CACHE)
        const hit = await cache.match(event.request)
        if (hit) return hit
        // the document may still be mid-put (reload raced the write) —
        // wait briefly before declaring it expired
        for (let i = 0; i < 20; i++) {
          await new Promise(function (resolve) { setTimeout(resolve, 250) })
          const retry = await cache.match(event.request)
          if (retry) return retry
        }
        return new Response('<h1>preview expired — run cell preview again</h1>', { status: 404, headers: { 'content-type': 'text/html' } })
      })(),
    )
  }
})
