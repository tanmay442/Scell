import type { Vfs } from '../vfs/types'
import { vfsPath } from '../vfs/types'
import { bundleEntry } from './bundle'

/**
 * Builds the preview document for an iframe:
 * - static references (src=/href=, css url()) become blob URLs from the VFS;
 *   root-absolute paths fall back to <dir>/public/
 * - a <script type="module" src=...> entry is BUNDLED with esbuild-wasm
 *   (app source + node_modules) into one blob script
 * - css captured by the bundler goes to <style>; when it uses tailwind,
 *   the official @tailwindcss/browser runtime (Rust oxide → wasm) compiles
 *   it live inside the iframe
 * - a fetch shim routes /api/* to the host, which runs Vercel-style
 *   functions in the node isolate
 */

const API_SHIM = `
<script>
(function () {
  window.__cellErrors = [];
  var ce = console.error; console.error = function () { try { window.__cellErrors.push('console: ' + Array.prototype.map.call(arguments, String).join(' ').slice(0, 300)) } catch (e) {} ce.apply(console, arguments) };
  try { window.__cellBoot = 'href=' + location.href + ';'; } catch (e) {}
  // router apps need a real pathname: about:srcdoc matches no route and
  // React would commit an empty tree — rewrite to '/' before app code runs
  try { history.replaceState(null, '', '/'); window.__cellBoot += 'hist=ok;href=' + location.href + ';'; } catch (e) { window.__cellBoot += 'hist=fail:' + (e && e.message ? e.message : 'x') + ';'; }
  window.addEventListener('error', function (e) { window.__cellErrors.push(String(e.message || e.type)) });
  window.addEventListener('unhandledrejection', function (e) { window.__cellErrors.push('reject: ' + String(e.reason && e.reason.message ? e.reason.message : e.reason)) });
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

/** neutralize the HTML parser traps for inline <script> text; each escape
 * is string-preserving in JS ('<' after a backslash keeps its value in
 * strings and legacy regexes) */
export function escapeInlineScript(js: string): string {
  return js
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<script/gi, '<\\script')
    .replace(/<!--/g, '<\\!--')
}

export interface PublicAsset {
  /** url path the asset is served at (root-relative, e.g. /logo.svg) */
  url: string
  bytes: Uint8Array
}

/**
 * The project's public/ tree, mapped to its root paths — React can reference
 * these at RUNTIME (img src="/logo.svg"), long after the static html rewrite
 * ran; the service worker serves them from the preview cache.
 */
export function collectPublicAssets(vfs: Vfs, dir: string, limit = 300): PublicAsset[] {
  const out: PublicAsset[] = []
  const walk = (fsDir: string, urlDir: string) => {
    if (out.length >= limit) return
    let names: string[]
    try {
      names = vfs.readDir(fsDir)
    } catch {
      return
    }
    for (const name of names) {
      const fsPath = `${fsDir}/${name}`
      const urlPath = urlDir === '' ? `/${name}` : `${urlDir}/${name}`
      if (vfs.isDir(fsPath)) walk(fsPath, urlPath)
      else {
        const bytes = vfs.readBytes(fsPath)
        if (bytes !== null) out.push({ url: urlPath, bytes })
      }
    }
  }
  walk(`${dir}/public`, '')
  return out
}

export interface PreviewBuild {
  html: string
  /** blob URLs created for this document — revoked on rebuild */
  objectUrls: string[]
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  woff2: 'font/woff2',
  woff: 'font/woff',
}

function blobUrlFor(vfs: Vfs, path: string): string | null {
  const bytes = vfs.readBytes(path)
  if (bytes === null) return null
  const ext = vfsPath.ext(path)
  const blob = new Blob([bytes as unknown as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' })
  return URL.createObjectURL(blob)
}

export async function buildPreviewDocument(
  vfs: Vfs,
  dir: string,
  entryFile = 'index.html',
): Promise<PreviewBuild | { error: string }> {
  const entryPath = vfsPath.join(dir, entryFile)
  const html = vfs.read(entryPath)
  if (html === null) return { error: `no ${entryFile} in ${dir}` }

  const objectUrls: string[] = []
  const mapped = new Map<string, string>()
  const urlFor = (relative: string): string | null => {
    const clean = relative.split('?')[0].split('#')[0]
    if (clean === '' || /^[a-z]+:/i.test(clean) || clean.startsWith('//') || clean.startsWith('data:')) return null
    // root-absolute refs resolve against the project, then public/
    const tryPaths = clean.startsWith('/')
      ? [vfsPath.join(dir, clean), vfsPath.normalize(`${dir}/public${clean}`)]
      : [vfsPath.join(dir, clean)]
    for (const path of tryPaths) {
      if (vfs.isFile(path)) {
        const existing = mapped.get(path)
        if (existing) return existing
        const url = blobUrlFor(vfs, path)
        if (url) {
          mapped.set(path, url)
          objectUrls.push(url)
          return url
        }
      }
    }
    return null
  }

  let out = html

  // bundle the module entry (src/main.tsx + node_modules) — before the
  // generic attribute pass so the script src isn't mistaken for a file link
  const moduleScript = /<script[^>]*type=["']module["'][^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/i.exec(out)
  let bundledCss = ''
  let tailwind = false
  if (moduleScript !== null) {
    const entryAbs = vfsPath.join(dir, moduleScript[1])
    const bundle = await bundleEntry(vfs, dir, entryAbs)
    if ('error' in bundle) return { error: bundle.error }
    // inline the iife — blob: scripts are silently blocked in some sandboxed
    // srcdoc contexts. The three HTML parser traps inside script text are
    // neutralized: </script, <script and <!-- (escaped-state swallowing)
    const safeJs = escapeInlineScript(bundle.js)
    // boot markers + sync-throw capture: execution evidence survives even
    // when window.onerror cannot attribute the failure
    const inlined = `<script>window.__cellBoot=(window.__cellBoot||'')+'start;';try{${safeJs}}catch(e){window.__cellErrors.push('boot: '+(e&&e.message?e.message:String(e)))}window.__cellBoot+='end;';</script>`
    // function replacer: the bundle contains $-patterns (e.g. react-dom's
    // "$&/") which a string replacer would expand into match artifacts
    out = out.replace(moduleScript[0], () => inlined)
    bundledCss = bundle.css
    tailwind = bundle.tailwind
  }

  // src= / href= attributes pointing at local files become blob URLs
  out = out.replace(/(\s(?:src|href)=["'])([^"']+)(["'])/gi, (full, pre, ref: string, post) => {
    if (ref.startsWith('data:')) return full
    const url = urlFor(ref)
    return url ? `${pre}${url}${post}` : full
  })
  // css url(...) inside inline styles
  out = out.replace(/url\((["']?)([^"')]+)\1\)/gi, (full, quote: string, ref: string) => {
    if (ref.startsWith('data:')) return full
    const url = urlFor(ref)
    return url ? `url(${quote}${url}${quote})` : full
  })
  // plain stylesheet links whose css landed in the bundle graph stay linked
  // to their blob (handled above); the bundler-captured css joins here
  if (bundledCss !== '') {
    if (tailwind) {
      const runtime = await tailwindRuntimeSource()
      if (runtime !== null) {
        const runtimeInlined = `<script>${escapeInlineScript(runtime)}</script>`
        out = out.replace(/<\/head>/i, () => `${runtimeInlined}\n<style type="text/tailwindcss">\n${bundledCss.replace(/<\/style/gi, '')}\n</style>\n</head>`)
      } else {
        out = out.replace(/<\/head>/i, () => `<style>\n${bundledCss}\n</style>\n</head>`)
      }
    } else {
      out = out.replace(/<\/head>/i, `<style>\n${bundledCss}\n</style>\n</head>`)
    }
  }

  // the api shim goes in first, before any script runs
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, () => `${API_SHIM}\n</head>`)
  } else {
    out = `${API_SHIM}\n${out}`
  }
  return { html: out, objectUrls }
}

/** the official tailwind-in-browser runtime (rust oxide → wasm inside) */
let tailwindSource: string | null | undefined
async function tailwindRuntimeSource(): Promise<string | null> {
  if (tailwindSource !== undefined) return tailwindSource
  try {
    const response = await fetch('/vendor/tailwind-browser.js')
    tailwindSource = response.ok ? await response.text() : null
  } catch {
    tailwindSource = null
  }
  return tailwindSource
}
