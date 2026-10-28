# Cell

A complete development environment that lives entirely inside one browser tab.
Filesystem, bash shell, TypeScript compiler, node runtime, npm, git, a live
app preview and an AI agent harness — all running on V8 (WebAssembly where it
counts). **No server, no container, no kernel, no backend compute.** Clone a
repo, install, edit with live typechecking, run, test, commit, push, preview
the running app, snapshot the workspace — everything persists in the browser.

```
pnpm install
pnpm dev          # → http://localhost:5199
```

That's the whole setup. The WASM toolchain (21 MB total) is committed under
`public/wasm/` — no native builds, no downloads.

## What works (all asserted by tests)

| Capability | How it's real | Verified by |
|---|---|---|
| Filesystem | In-memory VFS, text + binary files, full user home (`~`), dotfiles, volatile `/tmp` | unit + e2e |
| Persistence | Incremental IndexedDB saves (node_modules included), single-pass load, `navigator.storage.persist()` | e2e: deps survive reload |
| bash | just-bash + session env, `~/.bashrc` sourced every command, shebang scripts, heredocs, pipes, subshells, `[[ ]]`, `set -e`, tar/gzip, sqlite3 | `bash-audit.test.ts` (17 assertions) |
| System identity | `uname`, `id`, `df`, `free`, `ps`, `uptime`, `hostname`, `which`, `man`, `less`, `/etc/os-release`, `/proc/*` | `bash-audit.test.ts` |
| node | Fresh V8 worker per run, CommonJS resolver with walk-up, circular imports, shebangs, shell env → `process.env`, write-back to the VFS, 5 min ceiling | `worker-exec.test.ts` + e2e |
| TypeScript | ts-rust (Rust port of TS 7) in WASM: live editor diagnostics, `tsc` CLI, TS runs directly on `node` | e2e |
| npm/pnpm/npx | Real registry: semver, SHA-1-verified tarballs, scoped packages, npm aliases (`npm:x@y`), project-root installs, `-g` with PATH bins, scripts with `node_modules/.bin` | e2e: subdir install + global bins |
| git | Real libgit2 1.9.4 (wasm-git). `.git` is a visible directory; clone/fetch/push over https — CORS-blocked hosts (github) go through a relay chain automatically; `pull` = fetch+merge | e2e: clone from a real git server + github through the relay |
| App preview | `cell preview`: esbuild-wasm bundles the module graph in-page (exports maps, subpaths, tsx, images), Tailwind compiled live by the oxide runtime, `public/` served at root, Vercel-style `api/*.js` executed per request in the isolate, hot reload | `scripts/e2e-gdg.mjs` (style + asset truth probes) |
| Object storage | `cell save/list/load/status` — whole-workspace tar.gz to any S3-compatible endpoint, SigV4 on WebCrypto (verified against botocore) | `cell-cmd.test.ts` |
| AI agent | `cell agent "task"` — Anthropic/OpenAI tool loop over `bash`/`read`/`write`/`ls` on the same filesystem, step budget, full transcript | `agent.test.ts` |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ UI (React): Explorer · Editor (CodeMirror) · Terminal (xterm)│
│             GitPanel · PreviewPanel · Problems               │
├──────────────────────────────────────────────────────────────┤
│ EventBus  ← coalesced VFS events (one emit per 120ms window) │
├──────────────┬───────────────┬───────────────────────────────┤
│ Shell        │ Language svc  │ Preview system                │
│ (just-bash)  │ (ts-rust WASM │ esbuild-wasm bundler → doc    │
│  node npm    │  in a worker) │ → SW-served iframe + api fns  │
│  git tsc     │               │ in the node isolate           │
│  cell curl   │               │                               │
├──────────────┴───────────────┴───────────────────────────────┤
│ Node runtime: one V8 worker per process, zero-copy payload   │
│ (transferable ArrayBuffer + offset index, lazy decode)       │
├──────────────────────────────────────────────────────────────┤
│ VFS — in-memory tree (text + binary), watch events           │
├──────────────────────────────────────────────────────────────┤
│ IndexedDB (incremental) · ServiceWorker CacheStorage · S3    │
└──────────────────────────────────────────────────────────────┘
```

How the pieces talk:

- **Type a command** → xterm → `shell.exec` → just-bash parses → the VFS
  adapter maps bash paths 1:1 onto the VFS → coalesced events repaint the UI
  → autosave flushes the diff.
- **`node app.ts`** → (ts-rust emit if TS) → the workspace snapshot is
  transferred as one zero-copy buffer → the worker runs CJS with a shared
  `require.cache` → output coalesced back → only touched files write back.
- **`git commit`** → VFS ⇄ libgit2 MEMFS two-way sync (binary-safe) → lg2
  runs → sync back → the GitPanel re-discovers repos by scanning for `.git`.
- **`cell preview`** → bundle → document → CacheStorage → service worker
  serves it at `/` (routers match) → your app runs → `fetch('/api/x')` →
  shim → host → your function in the node isolate → response.
- **`export KEY=v; node …`** → the session environment is captured in-band
  after every command, restored before the next, and injected into
  `process.env` (most-specific-last: defaults < `~/.cell/env.json` < shell).

The bash session model: just-bash is per-execution, so Cell sources
`~/.bashrc` in front of every command and captures the resulting environment
in-band (brace-wrapped dump, exit code preserved, output line stripped). The
result behaves like a real interactive shell: exports persist, `.bashrc`
applies everywhere, aliases are defined, and an agent cannot tell the
difference through the container-detection probes.

## Repository layout

```
src/
  vfs/            VFS core, IndexedDB persistence, autosave, starter home
  shell/          just-bash integration, session env, system commands
    commands/     node npm git tsc cell agent curl + registry/installer/untar
  node/           the V8 isolate runtime (payload, worker, resolver, transform)
  lang/           ts-rust language service (worker) + diagnostics mapping
  preview/        esbuild bundler, document builder, SW, api runner
  terminal/ ui/   the IDE (xterm, CodeMirror, panels)
scripts/
  e2e.mjs         main e2e: 41 checks over headless Chrome (raw CDP, no deps)
  e2e-scribe.mjs  real-repo benchmark: clone → install → preview → api → reload
  e2e-gdg.mjs     modern-app benchmark: Vite/React/Tailwind repo, style probes
  git-http-server.mjs  real `git http-backend` server for clone tests
public/
  wasm/           committed toolchain: esbuild (14M), ts_rust (6M), lg2 (1.6M)
  vendor/         @tailwindcss/browser runtime (rust oxide → wasm)
  cell-preview-sw.js   the preview service worker (plain JS — parsed as-is)
```

Source of truth for behavior: the tests. `bash-audit.test.ts` pins the shell
realism, `worker-exec.test.ts` runs the actual node worker against real
registry packages, and the three e2e scripts drive the real UI in headless
Chrome over raw CDP.

## Testing

```sh
pnpm test        # 87 unit tests (vitest)
pnpm build       # typecheck + production build

# browser e2e (needs the dev server running):
node scripts/e2e.mjs          # main flow
node scripts/e2e-scribe.mjs   # real github repo: clone → install → preview → api → reload
node scripts/e2e-gdg.mjs      # modern Vite app benchmark: styles + assets asserted
```

The e2e scripts are dependency-free (raw Chrome DevTools Protocol over
WebSocket) and spawn their own headless Chrome. `e2e-scribe` clones a real
github repository through the relay, installs, previews it, executes its
serverless function, installs vercel globally, and verifies the tab survives
— the exact user journeys, asserted.

## Configuration (all optional, all in `~`)

| File | Purpose |
|---|---|
| `~/.gitconfig` | git identity — edited in the app, bridged into libgit2 |
| `~/.cell/agent.json` | `{ "provider": "anthropic" \| "openai", "apiKey": "…", "model": "…" }` |
| `~/.cell/env.json` | env vars for node processes and api functions (`{"GOOGLE_API_KEY": "…"}`) |
| `~/.cell/storage.json` | S3-compatible endpoint for `cell save/load` snapshots |
| `~/.gitconfig` `[cell] corsproxy` | custom git CORS relay list (`off` disables) |

## Honest limits

Browsers are the physics: no `child_process`, no native binaries (packages
that ship machine code — e.g. vercel, opencode — install but say so plainly),
no SSH remotes, no listening servers (preview + api functions replace them),
ESM-with-top-level-await CLIs can't run in the CommonJS isolate, and network
access obeys CORS (hence the git relay chain). Long-running processes cap at
5 minutes per run. Everything else behaves like the real thing — including
the parts an agent would probe.

## Docs

Historical design documents live in [`docs/`](docs/): `ARCHITECTURE.md`,
`CONTRACTS.md`, `PHASES.md` (from the phase-planning era; the README above is
the current truth).
