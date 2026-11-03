# Architecture — many Scells, one big VM

Scell is one V8 isolate that holds a whole agent workspace: filesystem, shell,
runtimes, and UI. The deployment story is many such isolates on one large VM —
one Scell per agent — sharing host memory while staying fully isolated.

```
┌─────────────────────── big VM / host ──────────────────────────┐
│  Scell instance A     Scell instance B     Scell instance C     │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐      │
│  │ V8 isolate    │   │ V8 isolate    │   │ V8 isolate    │      │
│  │ fs+bash+node  │   │ fs+bash+node  │   │ fs+bash+node  │      │
│  │ python+git    │   │ python+git    │   │ python+git    │      │
│  │ agent thread  │   │ agent thread  │   │ agent thread  │      │
│  └───────────────┘   └───────────────┘   └───────────────┘      │
│  shared host memory · no shared files · no shared env          │
└────────────────────────────────────────────────────────────────┘
```

Why this packs: isolates boot in milliseconds, idle near zero, and isolate
only what agents need (files, env, threads). No guest kernels, no per-agent
VMs, no container sprawl. The host manages one fleet instead of many machines.

## Inside one instance

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

- **VFS is the kernel.** The editor writes to it, just-bash reads/writes it through an FS adapter, the language service snapshots it, persistence flushes it. Nobody keeps a second copy of file state.
- **EventBus** carries mutations (`vfs:changed`), diagnostics, and UI intents (`editor:open`) between modules that never import each other.
- **ts-rust runs in a worker** — a check is CPU-heavy. It receives the full file map each run and returns structured diagnostics. Each run is a fresh WASM instance; the module is compiled once.
- **just-bash runs on the main thread** (fully async JS, no jank). Shell state (env/cwd) resets per exec; the filesystem persists across execs.

## How the pieces talk

See `docs/technical-reference.md` — one section covers type-a-command,
`node app.ts`, `python3 script.py`, `git commit`, `cell preview`, and env
capture.

## Isolate seam

The agent core (`src/shell`, `src/vfs`, `src/python`, `src/node`, skill bodies)
runs on nothing but V8. It may depend only on the `Vfs` interface, the
`ShellLike` interface, `fetch`, WebCrypto, `TextEncoder`, timers, and the WASM
toolchains (pyodide, ts-rust, esbuild-wasm, wasm-git). Forbidden in agent code:
static `node:` imports, `process.env` / `Deno` / `Bun`, spawning `Worker`s, and
any import reaching into `server/` or `scripts/`. Two exceptions carry an
`ISOLATE-GATE` marker: `src/shell/commands/python-cmd.ts` and `src/node/run.ts`
spawn the pyodide / node runtime in a nested `Worker` to keep heavy work off
the main thread.

`scripts/check-isolate-pure.sh` enforces this; CI fails the build on violation.
Grep can't see everything — reviews still eyeball for `eval`/`Function`
laundering, worker-alias indirection, and obfuscated member access.

## Deployment shapes

- **Browser tab (default):** static bundle + committed WASM under `public/wasm/` (esbuild 14M, ts-rust 6M, libgit2 1.6M). Runs on any edge runtime or static host.
- **Headless server (opt-in):** same agent loop with disk VFS + real shell for Telegram and always-on work — see `docs/headless-server.md`.
- **Fleet (the goal):** many browser-shaped isolates on one big VM, one per agent, sharing host memory with no shared files or env.
