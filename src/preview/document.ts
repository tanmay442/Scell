import type { Vfs } from '../vfs/types'
import { vfsPath } from '../vfs/types'

/**
 * Builds the preview document for an iframe: local file references become
 * blob URLs (the srcdoc iframe shares the app's origin), and a fetch shim is
 * injected so /api/* calls travel to the host, which runs the Vercel-style
 * functions in the node sandbox.
 */

const API_SHIM = `
<script>
(function () {
  var pending = new Map();
  var seq = 0;
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || !m.__cellApiReply || !pending.has(m.id)) return;
    var entry = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) entry.resolve(m.response);
    else entry.reject(new Error(m.error || 'api error'));
  });
  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.charCodeAt(0) === 47 /* / */ && url.slice(0, 5) === '/api/') {
      var id = ++seq;
      var body = null;
      try { if (init && init.body !== undefined) body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } catch (e) {}
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ __cellApi: true, id: id, path: url, method: (init && init.method) || 'GET', body: body }, '*');
        setTimeout(function () {
          if (pending.has(id)) { pending.delete(id); reject(new Error('api call timed out')) }
        }, 90000);
      }).then(function (response) {
        return new Response(response.body, { status: response.status, headers: { 'content-type': response.contentType || 'application/json' } });
      });
    }
    return originalFetch(input, init);
  };
})();
</script>
`

export interface PreviewBuild {
  html: string
  /** blob URLs created for this document — revoked on rebuild */
  objectUrls: string[]
}

function blobUrlFor(vfs: Vfs, path: string, textFallback: string): string | null {
  const bytes = vfs.readBytes(path)
  if (bytes === null) return null
  const isPng = path.endsWith('.png')
  const isJpg = /\.jpe?g$/.test(path)
  const isSvg = path.endsWith('.svg')
  const isGif = path.endsWith('.gif')
  const isWebp = path.endsWith('.webp')
  const isJs = /\.m?js$/.test(path)
  const isCss = path.endsWith('.css')
  const type = isPng
    ? 'image/png'
    : isJpg
      ? 'image/jpeg'
      : isSvg
        ? 'image/svg+xml'
        : isGif
          ? 'image/gif'
          : isWebp
            ? 'image/webp'
            : isJs
              ? 'text/javascript'
              : isCss
                ? 'text/css'
                : 'application/octet-stream'
  const blob = new Blob([bytes as unknown as BlobPart], { type })
  void textFallback
  return URL.createObjectURL(blob)
}

export function buildPreviewDocument(vfs: Vfs, dir: string, entryFile = 'index.html'): PreviewBuild | { error: string } {
  const entryPath = vfsPath.join(dir, entryFile)
  const html = vfs.read(entryPath)
  if (html === null) return { error: `no ${entryFile} in ${dir}` }

  const objectUrls: string[] = []
  const urlFor = (relative: string): string | null => {
    const clean = relative.split('?')[0].split('#')[0]
    if (clean === '' || /^[a-z]+:/i.test(clean) || clean.startsWith('//')) return null
    const path = vfsPath.join(dir, clean)
    if (!vfs.isFile(path)) return null
    const existing = mapped.get(clean)
    if (existing) return existing
    const url = blobUrlFor(vfs, path, '')
    if (url) {
      mapped.set(clean, url)
      objectUrls.push(url)
    }
    return url
  }
  const mapped = new Map<string, string>()

  // src= / href= attributes pointing at local files become blob URLs
  let out = html.replace(/(\s(?:src|href)=["'])([^"']+)(["'])/gi, (full, pre, ref, post) => {
    const url = urlFor(ref)
    return url ? `${pre}${url}${post}` : full
  })
  // css url(...) inside inline styles
  out = out.replace(/url\((["']?)([^"')]+)\1\)/gi, (full, quote, ref) => {
    const url = urlFor(ref)
    return url ? `url(${quote}${url}${quote})` : full
  })
  // the api shim goes in first, before any script runs
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (full) => `${full}\n${API_SHIM}`)
  } else {
    out = `${API_SHIM}\n${out}`
  }
  return { html: out, objectUrls }
}
