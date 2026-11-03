# Technical reference

The README states what Scell can do. This file states how it does it, where the code lives, and how to verify it.

## Capabilities in depth

| Capability | How it's real | Verified by |
|---|---|---|
| Filesystem | In-memory VFS, text + binary files, full user home (`~`), dotfiles, volatile `/tmp` | unit + e2e |
| Persistence | Incremental IndexedDB saves (node_modules included), single-pass load, `navigator.storage.persist()`, flush on tab-hide; agent sessions persist after **every step** with a live-run flag, so a closed/crashed tab reopens threads with history intact and an "interrupted — send a message to continue" note; composer drafts, the open thread (auto-reopened with history), and UI state (mode, editor tabs) survive reload too | e2e: deps survive reload; restart + mid-run kill verified |
| bash | just-bash + session env, `~/.bashrc` sourced every command, shebang scripts, heredocs, pipes, subshells, `[[ ]]`, `set -e`, tar/gzip, sqlite3, `curl` (browser fetch) | `bash-audit.test.ts` (17 assertions) |
| System identity | `uname`, `id`, `df`, `free`, `ps`, `uptime`, `hostname`, `which`, `man`, `less`, `/etc/os-release`, `/proc/*` | `bash-audit.test.ts` |
| node | Fresh V8 worker per run, CommonJS resolver with walk-up, circular imports, shebangs, shell env → `process.env`, write-back to the VFS | `worker-exec.test.ts` + e2e |
| TypeScript | ts-rust (Rust port of TS 7) in WASM: live editor diagnostics, `tsc` CLI, TS runs directly on `node` | e2e |
| npm/pnpm/npx | Real registry: semver, SHA-1-verified tarballs, scoped packages, npm aliases (`npm:x@y`), project-root installs, `-g` with PATH bins, scripts with `node_modules/.bin` | e2e: subdir install + global bins |
| git | Real libgit2 1.9.4 (wasm-git). `.git` is a visible directory; clone/fetch/push over https with an automatic relay chain for CORS-blocked hosts; `pull` = fetch+merge | e2e: clone from a real git server + github through the relay |
| App preview | `cell preview`: esbuild-wasm bundles the module graph in-page (exports maps, subpaths, tsx, images), Tailwind compiled live by the oxide runtime, `public/` served at root, Vercel-style `api/*.js` executed per request in the isolate, hot reload | browser e2e benchmarks (style + asset truth probes) |
| Object storage | `cell save/list/load/status` — whole-workspace tar.gz to any S3-compatible endpoint, SigV4 on WebCrypto (verified against botocore) | `cell-cmd.test.ts` |
| Python | Pyodide CPython 3.12 in a worker. Vendored wheels, hash-pinned, installed offline: numpy, pandas, scipy, matplotlib, Pillow, plus pypdf and seaborn for documents and charts. `python3` CLI, argv/cwd/stdin semantics, `matplotlib` PNGs, write-back to the VFS | `python.test.ts` (incl. Pillow convert/resize/verify, pypdf extract, seaborn plot) |
| Images | Drop any photo on the composer (staged into the thread workspace) or point at a workspace file, then ask: exact-dimension resize (LANCZOS), JPEG/PNG/WebP converts, quality byte-budget loops, EXIF normalize/strip — driven by the built-in `images` skill (Pillow), outputs verified by reopening and linked inline as previewable file chips | `python.test.ts` + live browser/server runs |
| AI agent | Agent home (front door) + `cell agent "task" [--steps N] [--resume <id>]` in the terminal — Meta/Anthropic/OpenAI/OpenAI-compatible tool loop over `bash`/`read`/`edit`/`write`/`ls`/`load_skill`/`job_start`/`job_poll`/`job_list`/`history_search`/`memory_save`/`memory_list`/`skill_install`/`remind`/`delegate`/`background_task` + custom `~/.cell/tools/*.json`, skills with progressive disclosure (`bot`, `commit`, `preview`, `debug-tsc`, `images`, `documents`; user-installed skills land in `~/.cell/skills/`; project overrides win), slash commands (`/commit`, `/preview`, custom), persisted sessions (model-generated titles, pin/lock/archive/fork/share), resumable chat with restored history, per-thread workspaces that keep running in the background, HTML visuals rendered in-thread, attached-file staging, per-tool approval in Ask mode (default: full permission), background jobs, secret redaction, SSE streaming, abort + auto-compaction | `agent*.test.ts` |

## How the pieces talk

- **Type a command** → xterm → `shell.exec` → just-bash parses → the VFS adapter maps bash paths 1:1 onto the VFS → coalesced events repaint the UI → autosave flushes the diff.
- **`node app.ts`** → (ts-rust emit if TS) → the workspace snapshot is transferred as one zero-copy buffer → the worker runs CJS with a shared `require.cache` → output coalesced back → only touched files write back.
- **`python3 script.py`** → same worker pattern through Pyodide: imports resolve from vendored wheels (Pillow/matplotlib/numpy/pandas, offline), anything else pure-python comes via micropip; written files land back in the VFS (text and binary), so `Image.save(...)` output is immediately readable, previewable, and committable.
- **`git commit`** → VFS ⇄ libgit2 MEMFS two-way sync (binary-safe) → lg2 runs → sync back → the GitPanel re-discovers repos by scanning for `.git`.
- **`cell preview`** → bundle → document → CacheStorage → service worker serves it at `/` (routers match) → your app runs → `fetch('/api/x')` → shim → host → your function in the node isolate → response.
- **`export KEY=v; node …`** → the session environment is captured in-band after every command, restored before the next, and injected into `process.env` (most-specific-last: defaults < `~/.cell/env.json` < shell).

The bash session model: just-bash is per-execution, so Scell sources `~/.bashrc` in front of every command and captures the resulting environment in-band (brace-wrapped dump, exit code preserved, output line stripped). The result behaves like a real interactive shell: exports persist, `.bashrc` applies everywhere, aliases are defined, and an agent cannot tell the difference through the container-detection probes.

## Repository layout

```
src/
  vfs/            VFS core, IndexedDB persistence, autosave, starter home
  shell/          just-bash integration, session env, system commands
    commands/     node npm git tsc cell agent curl + registry/installer/untar
  node/           the V8 isolate runtime (payload, worker, resolver, transform)
  python/         Pyodide runner (payload, worker, micropip fallback)
  lang/           ts-rust language service (worker) + diagnostics mapping
  preview/        esbuild bundler, document builder, SW, api runner
  terminal/ ui/   the IDE (xterm, CodeMirror, panels)
server/           headless agent: disk VFS, real-bash shell, run-once CLI,
                  HTTP+SSE server, gateway (auth/limits/usage), per-thread
                  router, boot resume, job ticker, snapshot store, bindings
Dockerfile.agent  node:22-slim + fflate/semver + python3-pil; CMD = server
scripts/
  agent-run.sh / agent-server.sh   one-shot and server containers
  e2e.mjs              main e2e over headless Chrome (raw CDP, no deps)
  e2e-gdg.mjs          benchmark: clone/build/preview the gdg-hbtu site
  e2e-scribe.mjs       repro: clone/build/preview the scribe site
  e2e-agent.mjs        live agent loop against the Meta API (CELL_AGENT_LIVE_KEY)
  git-http-server.mjs  real `git http-backend` server for clone tests
  vendor-public.mjs    postinstall: materialize public/vendor/ from npm
public/
  wasm/           committed toolchain: esbuild (14M), ts_rust (6M), lg2 (1.6M)
  vendor/         generated by postinstall (gitignored): pyodide core copied
                  from the versioned npm package — the python offline fallback.
                  (The tailwind browser runtime is bundled from
                  @tailwindcss/browser via `?url`, not copied.)
  cell-preview-sw.js   the preview service worker (plain JS — parsed as-is)
```

Source of truth for behavior: the tests. `bash-audit.test.ts` pins the shell realism, `worker-exec.test.ts` runs the actual node worker against real registry packages, and the three e2e scripts drive the real UI in headless Chrome over raw CDP.

## Testing

```sh
pnpm test        # unit tests (vitest)
pnpm build       # typecheck + production build

# browser e2e (needs the dev server on :5199 — `pnpm dev` — plus internet:
# the main flow clones github.com/octocat/Hello-World and hits the npm
# registry; the gdg/scribe benchmarks clone live project repos):
pnpm e2e              # main flow (or: node scripts/e2e.mjs)
pnpm e2e:gdg          # gdg-hbtu benchmark
pnpm e2e:scribe       # scribe repro
CELL_AGENT_LIVE_KEY=LLM_… pnpm e2e:agent  # meta agent harness (skips without the key)
```

The e2e scripts are dependency-free (raw Chrome DevTools Protocol over WebSocket) and spawn their own headless Chrome (`google-chrome-stable` by default, `CHROME_BIN` to override; `APP_URL` to point at another server). The main script covers the full user journey: boot, editing, typecheck, node, npm, git cycles, preview with api functions, github clone through the relay, and reload persistence — against its own local git fixture server plus the live registry and github (internet required).

## Budgets — ceilings, caps, and quotas

No single time limit — each executor has its own ceiling:

| Executor | Ceiling | What happens past it |
|---|---|---|
| One python/node script run | 5 min | timeout error, partial output kept |
| One bash step | 120 s default, raisable to 10 min | exit 124, `timeoutMs` up to 600000 |
| One background job attempt | 10 min (`CELL_TIMEOUT_MS`) | retried, 5 attempts, then `dead` |
| One Telegram triage turn | 12 steps | run ends; bigger work belongs in a background worker |
| Queued Telegram turns | 5 per thread | extras get 'hold that thought' — first-in, first-run |
| One approval wait (Ask mode) | 5 min | auto-denies |

Size and count caps (same everywhere): Telegram attachments 12 MB in,
45 MB deliverables out, 3 images max into vision (4 MB each); composer
images 25 MB staged as bytes, other files inline as text (200 KB / 12k
chars clipped); tool results 30k chars and job logs 40k with receipts;
100 durable memories (oldest evicted silently), 40-char skill names, 50 reminders (7 days out
max), history search covers the 200 newest sessions
(says so when it skips), request bodies 4 MB (413), one run per thread
(second caller gets 409).
