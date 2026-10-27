# Architecture

## Phase 1 layout (now)

```
┌────────────────────────── browser tab ──────────────────────────┐
│  main thread                                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ React UI: file tree · tabs · CodeMirror · terminal · bar  │  │
│  └──────────────┬────────────────────────────────────────────┘  │
│                 │ platform() = { vfs, bus }                      │
│  ┌──────────────┴──────────────┐  ┌──────────────────────────┐  │
│  │ Vfs (single source of truth)│  │ just-bash Bash instance  │  │
│  │ in-memory tree + watch      │◄─┤ Fs adapter over the Vfs  │  │
│  └──────┬──────────────────────┘  └──────────────────────────┘  │
│         │ debounced flush                                        │
│  ┌──────┴───────────────┐                                       │
│  │ IndexedDB persistence│                                       │
│  └──────────────────────┘                                       │
│                                                                 │
│  worker: tsc-wasm ── fetch('/wasm/ts_rust.wasm') ── ts-rust     │
│  (module worker, single-threaded WASI, no SAB)                  │
└─────────────────────────────────────────────────────────────────┘
```

- **Vfs is the kernel of the platform.** The editor writes to it, just-bash
  reads/writes it through an FS adapter, the language service snapshots it,
  persistence flushes it. Nobody keeps a second copy of file state.
- **EventBus** carries mutations (`vfs:changed`), diagnostics, and UI intents
  (`editor:open`) between modules that never import each other.
- **ts-rust runs in a worker** because a check is CPU-heavy; it receives the
  full file map each run (`tsc(['-p','/project'], { files, diagnostics:'json' })`)
  and returns structured diagnostics with UTF-16 positions. Each run is a
  fresh WASM instance; the module is compiled once. No `--lsp` in the WASM
  build — diagnostics only for now.
- **just-bash runs on the main thread** in Phase 1 (it is fully async JS, so
  it does not jank). It moves to its own worker in Phase 2 together with a
  VFS replica synced over events, so the shape of `src/shell` is UI-agnostic.
  Bash sees the workspace at `/workspace` (VFS `/`).

## Deployment shape

The whole app is a static bundle plus one WASM file — deployable on any edge
runtime or a single V8 isolate (Workers, deno_deploy, a static bucket). The
isolate never needs Node APIs in Phase 1. Phase 4 adds snapshot upload/download
via presigned URLs (host issues them; the isolate holds no credentials).

## Library notes (from reading the sources)

- **ts-rust** (`vendor/ts-rust/npm/wasm`): package `ts-rust-wasm`, exports
  `tsc(args, { files, diagnostics })`. Built by `scripts/wasm/build.sh`
  (wasm32-wasip1, cdylib, host provides the FS through two imports
  `ts_host.fs` / `fs_take`; a tiny WASI shim in `core.js` gives clocks,
  random, stdout/stderr). 4.2 MB raw / ~1.8 MB gzip. Safari has a small
  worker stack — deep recursion shapes can fail there; Chrome/Firefox fine.
- **just-bash** (`vendor/just-bash/packages/just-bash`): `new Bash({...})`,
  `await bash.exec(cmd)` → `{ stdout, stderr, exitCode }`. Custom `fs` option
  takes an Fs implementation — the adapter contract lives in
  `packages/just-bash/src/fs/interface.ts`. Browser build at export
  `just-bash/browser`. Node-only bits (sqlite3, python, OverlayFs) are unused.
  Shell state (env/cwd) resets per exec; the filesystem persists across
  execs.

## Constraints we accept on purpose

- No SharedArrayBuffer / COOP-COEP requirement in Phase 1–2 → works embedded
  anywhere, including non-isolated iframes.
- Text-only VFS until package tarballs force binary (Phase 2).
- Diagnostics-only language service until an LSP-over-WASM exists.
- No real PTY: xterm drives a line-oriented exec loop.
