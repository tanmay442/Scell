<img src="public/scell.svg" width="72" alt="Scell">

# Scell — V8-native agent workspaces

Agent sandboxing keeps getting harder. VMs are heavy: slow to boot, expensive to run, wasteful to pack, painful to manage. One agent per VM does not scale.

Scell runs the whole agent environment inside V8. No kernel, no container, no VM per agent. One big VM hosts many Scell instances side by side — same memory, same host, fully isolated from each other. Cheaper to run, denser to pack, easier to manage.

```
pnpm install
pnpm dev          # → http://localhost:5199
```

The WASM toolchain (21 MB) is committed under `public/wasm/` — no native builds, no downloads.

## What the agent gets

Everything an agent harness needs — persistent filesystem, bash, Python — entirely inside a V8 isolate.

The agent works with real files that survive reloads, a real shell session with env and `~/.bashrc`, and a real Python 3.12 data stack (numpy, pandas, scipy, matplotlib, Pillow, pypdf, seaborn). It reads, edits, writes, runs, and iterates exactly like it does in any other harness. The difference is where it runs: V8 isolates, not machines.

Each thread gets its own workspace folder (`~/threads/<session-id/>`). Threads run in the background when you switch away, sessions resume with full history, and generated files link inline and open in a preview.

## TypeScript + Node web dev, inside V8

Scell runs the full TypeScript/Node web loop inside the isolate — this is the meta part: the entire TypeScript/Node stack moved into V8 itself.

Clone from GitHub with a real git CLI (libgit2 compiled to WASM, `.git` is a real visible directory, fetch/push over HTTPS). Install from the real npm registry with semver resolution, scoped packages, aliases, global bins, and `node_modules/.bin` scripts. Run on a real Node runtime (fresh V8 worker per run, CommonJS resolver, `process.env` wiring, write-back to the workspace). Typecheck with the real TypeScript compiler (ts-rust in WASM) with live editor diagnostics and a `tsc` CLI. Bundle with esbuild-WASM, style with live Tailwind, serve `public/` at root, run Vercel-style `api/*.js` per request in the isolate, and preview the running app with hot reload.

It is almost there — clone, install, edit, typecheck, run, test, commit, push, preview, all without leaving V8. That removes the VM bill for cloud agents doing web work.

## What it can do

| Capability | How it's real |
|---|---|
| Filesystem | In-memory VFS with text + binary files, full home (`~`), dotfiles, `/tmp` |
| Persistence | Incremental IndexedDB saves (including `node_modules`), single-pass load, flush on tab-hide; sessions persist after every step and reopen with history intact |
| bash | just-bash with session env, `~/.bashrc`, shebangs, heredocs, pipes, subshells, `[[ ]]`, `set -e`, tar/gzip, sqlite3, `curl` |
| node | Fresh V8 worker per run, walk-up CommonJS resolver, circular imports, shebangs, shell env → `process.env`, write-back to the workspace |
| TypeScript | ts-rust (Rust port of TS 7) in WASM: live diagnostics, `tsc` CLI, TS runs directly on `node` |
| npm / pnpm / npx | Real registry, semver + SHA-1-verified tarballs, scoped packages, npm aliases, project-root installs, `-g` bins |
| git | Real libgit2 1.9.4 (wasm-git): clone, fetch, push, pull as fetch+merge |
| App preview | `cell preview`: in-page esbuild bundle (exports maps, subpaths, tsx, images), live Tailwind, `public/` at root, `api/*.js` per-request functions, hot reload |
| Object storage | `cell save/list/load/status` — whole-workspace tar.gz to any S3-compatible endpoint, SigV4 on WebCrypto |
| Python | Pyodide CPython 3.12 in a worker, hash-pinned vendored wheels installed offline: numpy, pandas, scipy, matplotlib, Pillow, pypdf, seaborn. `python3` CLI, argv/cwd/stdin, matplotlib PNGs with write-back |
| Images | Drop a photo on the composer or point at a workspace file: exact resize (LANCZOS), JPEG/PNG/WebP converts, quality byte-budget loops, EXIF normalize — driven by the built-in `images` skill, outputs verified by reopening and linked as preview chips |
| AI agent | Chat + `cell agent "task"` over Meta/Anthropic/OpenAI/compat: `bash`/`read`/`edit`/`write`/`ls`/`load_skill`/`job_start`/`job_poll`/`job_list`/`history_search`/`memory_save`/`memory_list`/`skill_install`/`remind`/`delegate`/`background_task` + custom `~/.cell/tools/*.json`, skills (`bot`, `commit`, `preview`, `debug-tsc`, `images`, `documents`), slash commands, persisted sessions with model-generated titles, resumable history, per-thread workspaces, in-thread HTML visuals, file staging, per-tool approval, background jobs, secret redaction, SSE streaming |

Every row above is asserted by tests — see `docs/technical-reference.md`.

## Web UI

The app opens on **Agent home**: chat with sessions, skills, tools, model settings, and a status dock (agent / jobs / review / workspace). The full IDE — Explorer, CodeMirror editor, xterm terminal, Git panel, Preview panel, Problems — is one click away under **Workspace**. Same files on both sides.

The UI is built with **Astryx design components** (`@astryxdesign/core` + neutral theme): AppShell, Layout, Stack, Chat, Markdown, Dialog, SideNav, and more — no raw divs, styling through component props and design tokens.

## Architecture: many Scells, one big VM

Scell is not a standalone demo. It is designed so one large VM runs many Scell instances at once — one per agent — sharing the host's memory while staying completely isolated from each other.

```
┌─────────────────────── big VM / host ──────────────────────────┐
│  Scell instance A     Scell instance B     Scell instance C    │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐     │
│  │ V8 isolate    │   │ V8 isolate    │   │ V8 isolate    │     │
│  │ fs+bash+node  │   │ fs+bash+node  │   │ fs+bash+node  │     │
│  │ python+git    │   │ python+git    │   │ python+git    │     │
│  │ agent thread  │   │ agent thread  │   │ agent thread  │     │
│  └───────────────┘   └───────────────┘   └───────────────┘     │
│  shared host memory · no shared files · no shared env          │
└────────────────────────────────────────────────────────────────┘
```

Inside one instance:

```
┌──────────────────────────────────────────────────────────────┐
│ Agent home (Astryx): chat · sessions · skills · settings     │
│ StatusDock: agent state · jobs · review · workspace          │
│ Workspace: Explorer · Editor (CodeMirror) · Terminal (xterm) │
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
├──────────────────────────────────────────────────────────────┤
│ VFS — in-memory tree (text + binary), watch events           │
├──────────────────────────────────────────────────────────────┤
│ IndexedDB (incremental) · ServiceWorker CacheStorage · S3    │
└──────────────────────────────────────────────────────────────┘
```

Full story in `docs/ARCHITECTURE.md`.

## Connect anywhere: triggers + tools

Scell connects to whatever your agent connects to.

- **Telegram trigger** — `CELL_TELEGRAM=1` starts a bot next to the server: one stable thread per chat, triage inline + `background_task` workers for long work, photos/documents in, results and files back. See `docs/connectors.md`.
- **Gmail watcher** — `gmail_search` / `gmail_read` / `gmail_draft` / `gmail_send`: search with Gmail query syntax, read bodies, stage drafts, send only approved drafts to allowlisted recipients. The agent watches inboxes and acts on mail.
- **Tool port** — `~/.cell/tools/*.json` adds custom tools (`{ name, description, parameters, run: { kind: "bash", command } }`), plus skills (`~/.cell/skills/<name>/SKILL.md`) and slash commands (`~/.cell/commands/*.md`). Anything scriptable becomes an agent tool.

Memory (`memory_save`/`memory_list`), history search across threads, reminders, delegation, and background workers round out the loop. Details in `docs/connectors.md`.

## Headless, when you need it

The same agent loop runs headless on a server (disk VFS, real shell) for Telegram and always-on work:

```sh
pnpm server:build
./scripts/agent-server.sh --workspace ./workspace --port 8787
curl http://localhost:8787/health
```

One-shot runs, HTTP+SSE API, per-thread isolation, snapshots, and env config live in `docs/headless-server.md`.

## Docs

- `docs/technical-reference.md` — capabilities in depth, how the pieces talk, repo layout, testing, budgets
- `docs/ARCHITECTURE.md` — isolate topology and the many-Scells-one-VM story
- `docs/connectors.md` — Telegram, Gmail, custom tools, memory, jobs, reminders
- `docs/headless-server.md` — server build, Docker, routes, env vars, snapshots
- `docs/configuration.md` — every file in `~`, what it does

Built with Astryx (`@astryxdesign/core`, `@astryxdesign/theme-neutral`) and a committed WASM toolchain: esbuild (14M), ts-rust (6M), libgit2 (1.6M).
