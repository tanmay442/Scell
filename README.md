# Cell

A browser-native web dev platform on V8 isolates. Open a project, edit files,
run commands, typecheck, install packages, start a dev server — every part
runs inside V8 isolates in the browser. No kernel, no container, no backend
compute.

**This is the MVP (Phase 1):** virtual filesystem + IDE shell + real
TypeScript typechecking (ts-rust, the Rust port of TypeScript 7, compiled to
WASM) + a bash shell (just-bash) operating on the same filesystem.

## Run it

```sh
pnpm install
pnpm dev
```

Optional (only needed when rebuilding the typechecker WASM — a prebuilt copy
is committed under `public/wasm/`):

```sh
git clone --depth 1 https://github.com/pingdotgg/ts-rust.git vendor/ts-rust
cd vendor/ts-rust && CI=1 WASM_OPT=none scripts/wasm/build.sh
cp npm/wasm/ts_rust.wasm ../../public/wasm/
```

Reference sources for the two core libraries are shallow-cloned under
`vendor/` (gitignored) for study:

```sh
git clone --depth 1 https://github.com/vercel-labs/just-bash.git vendor/just-bash
git clone --depth 1 https://github.com/pingdotgg/ts-rust.git vendor/ts-rust
```

## Stack

| Job | Tool |
|---|---|
| Filesystem | Cell VFS (in-memory + IndexedDB persistence) |
| Typecheck | [ts-rust](https://github.com/pingdotgg/ts-rust) — Rust port of TypeScript 7, `wasm32-wasip1`, single-threaded |
| Shell | [just-bash](https://github.com/vercel-labs/just-bash) — simulated bash + virtual FS, browser build |
| Editor | CodeMirror 6 in React |
| Terminal | xterm.js |

See `docs/PHASES.md` for the roadmap and `docs/ARCHITECTURE.md` for how the
pieces fit, including the path to a single-isolate (Cloudflare Workers style)
deployment.
