import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import { platform } from '../platform'
import { buildPreviewDocument, type PreviewBuild } from '../preview/document'
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
  const [status, setStatus] = useState('idle')
  const buildRef = useRef<PreviewBuild | null>(null)
  buildRef.current = build

  const rebuild = useCallback(
    (target: string) => {
      setStatus('bundling…')
      void (async () => {
        const previous = buildRef.current
        if (previous) for (const url of previous.objectUrls) URL.revokeObjectURL(url)
        const result = await buildPreviewDocument(vfs, target)
        if ('error' in result) {
          setBuild(null)
          setError(result.error)
          setStatus('idle')
          return
        }
        setError(null)
        setBuild(result)
        // router apps need a real pathname (/) — about:srcdoc matches no
        // route. The service worker serves the document at
        // /?cellpreview=<token>; fall back to srcDoc when unavailable.
        let url: string | null = null
        try {
          // register once; ready never resolves without it — race a timeout
          // so unavailable service workers (private mode, no https) fall back
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
          if (registration?.active) {
            const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            url = `/?cellpreview=${token}`
            registration.active.postMessage({ type: 'cell-preview-put', url, html: result.html })
          }
        } catch {
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
    const off = bus.on('preview:open', (payload: { dir: string }) => {
      setDir(payload.dir)
      rebuild(payload.dir)
    })
    return off
  }, [bus, rebuild])

  // /api/* calls from the iframe → node sandbox → back
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as PendingApi & { __cellApi?: boolean }
      if (!msg || msg.__cellApi !== true || typeof msg.id !== 'number') return
      const target = dir
      if (target === null) return
      setStatus(`${msg.method} ${msg.path.split('?')[0]}`)
      void runApiFunction(vfs, target, { method: msg.method, path: msg.path, body: msg.body })
        .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        .then((response) => {
          const frame = document.querySelector('.preview-frame') as HTMLIFrameElement | null
          if ('error' in (response as { error?: string }) && (response as { error?: string }).error) {
            setStatus(`error: ${(response as { error: string }).error}`)
            frame?.contentWindow?.postMessage({ __cellApiReply: true, id: msg.id, ok: false, error: (response as { error: string }).error }, '*')
          } else {
            setStatus('idle')
            frame?.contentWindow?.postMessage({ __cellApiReply: true, id: msg.id, ok: true, response }, '*')
          }
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [vfs, dir])

  // live reload: filesystem changes rebuild the document (debounced)
  useEffect(() => {
    if (dir === null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = bus.on('vfs:changed', (event: { path: string }) => {
      if (event.path.startsWith('/node_modules') || event.path.includes('/.git/')) return
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
            title="Open in new tab (static — api calls need this panel)"
            onClick={() => {
              if (build) {
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
              setDir(null)
              setBuild(null)
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
    </div>
  )
}
