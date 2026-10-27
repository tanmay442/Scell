import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import { platform } from '../platform'
import { buildPreviewDocument, collectPublicAssets, type PreviewBuild } from '../preview/document'
import { runApiFunction } from '../preview/run-api'

interface PendingApi {
  id: number
  path: string
  method: string
  body: string | null
}

/**
 * The app preview: the project's index.html rendered live in a sandboxed
 * iframe. Static files resolve to blob URLs straight from the VFS; /api/*
 * calls are executed as Vercel-style functions in the node isolate — the
 * whole dev-server loop, minus the server.
 */
export function PreviewPanel() {
  const { vfs, bus } = platform()
  const [dir, setDir] = useState<string | null>(null)
  const [build, setBuild] = useState<PreviewBuild | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ text: string; tone: 'info' | 'error' }[]>([])
  const [status, setStatus] = useState('idle')
  const buildRef = useRef<PreviewBuild | null>(null)
  const buildGen = useRef(0)
  const restoredDir = useRef<string | null>(null)
  buildRef.current = build
  const pushLog = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setLogs((prev) => [...prev.slice(-40), { text, tone }])
  }, [])

  const rebuild = useCallback(
    (target: string) => {
      const generation = ++buildGen.current
      setStatus('bundling…')
      void (async () => {
        const result = await buildPreviewDocument(vfs, target)
        if (generation !== buildGen.current) {
          // a newer rebuild superseded this one — drop its blobs, keep the
          // newer build (or the last-good document on error)
          if (!('error' in result)) for (const url of result.objectUrls) URL.revokeObjectURL(url)
          return
        }
        if ('error' in result) {
          // keep the last-good preview mounted; surface the error as a strip
          setError(result.error)
          setStatus('idle')
          return
        }
        const previous = buildRef.current
        if (previous) for (const url of previous.objectUrls) URL.revokeObjectURL(url)
        setError(null)
        setBuild(result)
        // router apps need a real pathname (/) — about:srcdoc matches no
        // route. The service worker serves the document at
        // /?cellpreview=<token>; fall back to srcDoc when unavailable.
        let url: string | null = null
        try {
          // the worker only INTERCEPTS navigations; the document is written
          // into CacheStorage directly from this page (shared origin store —
          // the message-channel version raced its own acks into 404s)
          const registration =
            navigator.serviceWorker !== undefined
              ? await Promise.race([
                  (async () => {
                    await navigator.serviceWorker.register('/cell-preview-sw.js')
                    return navigator.serviceWorker.ready
                  })(),
                  new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
                ])
              : null
          if (registration?.active && typeof caches !== 'undefined') {
            const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            url = `/?cellpreview=${token}`
            const cache = await caches.open('cell-preview-v3')
            await cache.put(
              url,
              new Response(result.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
            )
            // seed public/ at root paths — React references these at runtime
            // (img src="/logo.svg") long after the static rewrite ran
            for (const asset of collectPublicAssets(vfs, target)) {
              const assetUrl = new URL(asset.url, location.href).href
              await cache.put(assetUrl, new Response(asset.bytes as unknown as BodyInit))
            }
            // one live preview: drop older documents — keys() returns
            // ABSOLUTE urls, so compare normalized (the relative comparison
            // was never equal and deleted the entry we just wrote)
            const absolute = new URL(url, location.href).href
            const keep = new Set([absolute, ...collectPublicAssets(vfs, target).map((a) => new URL(a.url, location.href).href)])
            for (const key of await cache.keys()) {
              if (!keep.has(key.url)) await cache.delete(key)
            }
          }
        } catch (err) {
          pushLog(`preview cache write failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
          url = null
        }
        setPreviewUrl(url)
        setVersion((v) => v + 1)
        setStatus('idle')
      })()
    },
    [vfs],
  )

  useEffect(() => {
    // survive RELOADS (sessionStorage), not fresh tabs — a new tab starts
    // with a clean workspace view
    const saved = sessionStorage.getItem('cell-preview-dir')
    if (saved !== null && vfs.isDir(saved)) {
      pushLog(`preview restored for ${saved.replace(/^\/home\/user/, '~')}`)
      setDir(saved)
      rebuild(saved)
    }
    const off = bus.on('preview:open', (payload: { dir: string }) => {
      if (payload.dir === sessionStorage.getItem('cell-preview-dir') && restoredDir.current === payload.dir) return
      pushLog(`preview opened for ${payload.dir.replace(/^\/home\/user/, '~')}`)
      sessionStorage.setItem('cell-preview-dir', payload.dir)
      restoredDir.current = payload.dir
      setDir(payload.dir)
      rebuild(payload.dir)
    })
    return off
  }, [bus, rebuild, pushLog, vfs])

  // /api/* calls from the iframe → node sandbox → back
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return
      const msg = event.data as PendingApi & { __cellApi?: boolean; __cellRuntimeError?: boolean; text?: string }
      if (!msg || msg.__cellApi !== true || typeof msg.id !== 'number') return
      const target = dir
      if (target === null) return
      const started = performance.now()
      pushLog(`→ ${msg.method} ${msg.path.split('?')[0]}`)
      if (msg.__cellRuntimeError === true) {
        pushLog(`preview runtime: ${String(msg.text ?? '').slice(0, 240)}`, 'error')
        return
      }
      setStatus(`${msg.method} ${msg.path.split('?')[0]}`)
      void runApiFunction(vfs, target, { method: msg.method, path: msg.path, body: msg.body })
        .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        .then((response) => {
          const frame = document.querySelector('.preview-frame') as HTMLIFrameElement | null
          const ms = Math.round(performance.now() - started)
          if ('error' in (response as { error?: string }) && (response as { error?: string }).error) {
            const why = (response as { error: string }).error
            setStatus(`error: ${why}`)
            pushLog(`✗ ${msg.method} ${msg.path.split('?')[0]} — ${ms}ms — ${why.slice(0, 200)}`, 'error')
            frame?.contentWindow?.postMessage({ __cellApiReply: true, id: msg.id, ok: false, error: why }, '*')
          } else {
            const done = response as { status: number }
            setStatus('idle')
            pushLog(`✓ ${msg.method} ${msg.path.split('?')[0]} → ${done.status} (${ms}ms)`)
            frame?.contentWindow?.postMessage({ __cellApiReply: true, id: msg.id, ok: true, response }, '*')
          }
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [vfs, dir, pushLog])

  // live reload: filesystem changes rebuild the document (debounced)
  useEffect(() => {
    if (dir === null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = bus.on('vfs:changed', (event: { path: string }) => {
      if (event.path.includes('/node_modules/') || event.path.includes('/.git/')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => rebuild(dir), 600)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [bus, dir, rebuild])

  if (dir === null) return null

  return (
    <div className="preview-panel">
      <div className="preview-toolbar">
        <span className="preview-title">PREVIEW · {dir.replace(/^\/home\/user/, '~')}</span>
        <span className={`preview-status ${status !== 'idle' ? 'busy' : ''}`}>{status}</span>
        <span className="preview-actions">
          <button title="Rebuild" onClick={() => rebuild(dir)}>
            <RefreshCw size={13} />
          </button>
          <button
            title={previewUrl !== null ? 'Open in a new tab' : 'Open in a new tab (static — api calls need this panel)'}
            onClick={() => {
              if (previewUrl !== null) window.open(previewUrl, '_blank')
              else if (build) {
                const blob = new Blob([build.html], { type: 'text/html' })
                window.open(URL.createObjectURL(blob), '_blank')
              }
            }}
          >
            <ExternalLink size={13} />
          </button>
          <button
            title="Close preview"
            onClick={() => {
              if (build) for (const url of build.objectUrls) URL.revokeObjectURL(url)
              sessionStorage.removeItem('cell-preview-dir')
              restoredDir.current = null
              setDir(null)
              setBuild(null)
              setPreviewUrl(null)
            }}
          >
            <X size={13} />
          </button>
        </span>
      </div>
      <div className="preview-body">
        {error ? (
          <div className="preview-error">{error}</div>
        ) : build ? (
          <iframe
            key={version}
            className="preview-frame"
            title="app preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
            {...(previewUrl !== null ? { src: previewUrl } : { srcDoc: build.html })}
          />
        ) : (
          <div className="preview-error">building…</div>
        )}
      </div>
      {logs.length > 0 ? (
        <div className="preview-logs">
          {logs.slice(-14).map((line, i) => (
            <div key={`${i}-${line.text}`} className={line.tone === 'error' ? 'log-error' : ''}>{line.text}</div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
