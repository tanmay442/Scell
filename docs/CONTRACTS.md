# Internal contracts & module ownership

These files are **shared contracts** — changing them requires updating every
owner. Agents implement against them; if a contract is wrong, report it in
your summary instead of editing it.

- `src/vfs/types.ts` — `Vfs`, `VfsPersistence`, `VfsEvent`, `vfsPath` helpers
- `src/events.ts` — `EventBus`, `AppEvents`, `DiagnosticItem`
- `src/platform.ts` — `Platform`, `initPlatform()`, `platform()`

## Ownership map

| Path | Owner |
|---|---|
| `src/vfs/**` | Agent A |
| `src/shell/**` | Agent A |
| `src/terminal/**` | Agent A |
| `src/ui/**`, `src/editor/**`, `src/styles/**`, `src/main.tsx`, `src/App.tsx`, `index.html` | Agent B |
| `src/lang/**`, `public/wasm/**`, integration edits inside `src/editor/**` + one boot line in `src/main.tsx` | Agent C (wave 2, after A+B land) |
| contracts above, docs, config | Lead (already done) |

## Cross-module seams (compile against these, don't wait for the other agent)

**Agent A exports from `src/vfs/index.ts`:**

```ts
export function createVfs(initial?: Record<string, string>): Vfs
export function createIdbPersistence(dbName?: string): VfsPersistence
export function seedStarterProject(vfs: Vfs): void
```

**Agent A exports from `src/terminal/TerminalPanel.tsx`:**

```tsx
export default function TerminalPanel(): JSX.Element
```

Self-contained React component. Reads `platform()` for vfs/bus. Renders its
own xterm instance; the parent only supplies the container.

**Agent A exports from `src/shell/` (used later by Agent C / Phase 2):**

```ts
export function createShell(): { exec(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> }
```

**Agent B consumes** `createVfs` / `createIdbPersistence` / `seedStarterProject`
in `src/main.tsx` boot (load → restore or seed → `initPlatform` → render) and
lazy-mounts `TerminalPanel` in the bottom panel. Agent B renders an empty
Problems tab listening to `diagnostics:updated` (it will be empty until
Agent C lands — that is fine).

**Agent B leaves a seam** at `src/editor/lang-extensions.ts` — a function
`(path: string) => Extension[]` returning language + theme extensions. Agent
C appends the lint/diagnostic extension there.

**Agent C** owns the worker, the WASM asset, diagnostics mapping, and the
CodeMirror lint wiring; it must not change contracts and must keep
`src/lang` importable only from `src/editor` and `src/main.tsx`.

## Rules for agents working in this repo

1. Do not edit files outside your ownership map; do not edit the contracts.
2. Do not run `pnpm add` / `pnpm remove` (deps are preinstalled). If you need
   a package, say so in your report. Exception: Agent A may add
   `fake-indexeddb` as a devDependency for persistence tests.
3. Do not run `pnpm build` (shared dist). Verify with:
   `pnpm exec tsc --noEmit` (only errors under your paths count against you)
   and `pnpm exec vitest run <your test files>`.
4. Do not `git commit` — the lead commits.
5. Another agent is working in sibling directories concurrently. Never touch
   `pnpm-lock.yaml`, `package.json`, or anything outside your map.
6. Study the vendored sources before coding:
   - `vendor/just-bash/packages/just-bash/src/fs/interface.ts` (Fs adapter)
   - `vendor/ts-rust/npm/wasm/` (README, core.js, core.d.ts, browser.js)
