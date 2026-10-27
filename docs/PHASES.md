# Phases

## Phase 0 — Foundation (done)

Repo layout, docs, internal contracts (`src/vfs/types.ts`, `src/events.ts`,
`src/platform.ts`), toolchain (Vite + React + TS strict + vitest), vendor
clones of just-bash and ts-rust, WASM build script for the typechecker.

## Phase 1 — MVP (this milestone): the IDE feels real

One browser tab, one workspace. A dropped-in web developer creates files,
edits with syntax highlighting, sees real `tsc` diagnostics inline, and runs
bash against the same filesystem — without noticing there is no server.

- **VFS** — in-memory tree, full file ops, watch events, IndexedDB
  persistence (survives reload), snapshot/restore.
- **Editor** — CodeMirror 6, tabs, file tree with create/rename/delete/move,
  Ctrl+S save with dirty indicator, language detection by extension.
- **Typecheck** — ts-rust WASM in a module worker; whole-project `tsc`
  diagnostics (errors/warnings) as squiggles + gutter marks + Problems panel,
  debounced on save/edit.
- **Shell** — just-bash on the VFS through a custom FS adapter: `ls`, `cat`,
  `grep`, `sed`, `find`, pipes, redirects, variables, loops; xterm.js panel
  with cwd, history.
- **Status bar** — diagnostics counts, file count, terminal cwd.

Definition of done: create a TS file in the UI, introduce a type error, see
the squiggle + Problems entry in <1s after save; `echo hi > note.txt` in the
terminal makes the file appear in the tree; reload restores everything.

Out of scope for Phase 1: hover/completion/goto-def (ts-rust WASM has no LSP
yet — Phase 5), binary files, npm install, dev server.

## Phase 2 — Run the project

- npm registry client + tarball extraction into the VFS (no `npm` CLI).
- oxc-parser/oxc-transform for TS/JSX transform; `@rolldown/browser` or an
  esbuild-wasm class bundler for bundling; lightningcss-wasm for CSS.
- In-browser dev server: module rewriting over the VFS, HMR over a
  WebSocket/BroadcastChannel, preview in an iframe tab.
- `dev`, `build`, `check` commands as shell builtins.

## Phase 3 — Data + version control

- PGlite (Postgres in WASM, OPFS/IndexedDB persistence) as the default
  database; SQLite-wasm as the light alternative.
- isomorphic-git on the VFS: clone/branch/commit/diff/push over HTTPS;
  Octokit for PRs. GitHub auth via token held outside isolates.
- `git` builtin in the shell.

## Phase 4 — Persistence, isolation, deployability

- Content-addressed workspace snapshots to S3/R2 (one per commit + per
  session); package cache keyed by tarball hash; presigned URL flow.
- Isolate topology: heavy tools in workers, budgets (CPU/memory/egress)
  per isolate.
- Single-isolate deployment shape (Cloudflare Workers / any edge runtime):
  the app is a static bundle; the "server" parts are worker modules with no
  Node APIs.

## Phase 5 — Language depth + polish

- Language features beyond diagnostics (hover, completion, goto-def,
  rename) when ts-rust WASM exposes them — or layered via
  `@vitejs/language-tools`-style JS parsing until then.
- oxlint (WASM) + Biome wasm-web for lint/format, command palette, keymap
  parity with VS Code, multi-workspace tabs.

## Cross-cutting rules

- Text-first VFS until Phase 2 forces bytes.
- No SharedArrayBuffer requirement anywhere in Phase 1–2 (keeps the app
  embeddable in any isolate). Revisit with Rolldown threads.
- Every heavy tool runs in a worker; the main thread only renders.
- The shell and the language service must always see the same VFS state.
