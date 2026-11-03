# Isolate seam

The agent core runs on nothing but V8. This is the rule that keeps the
Cloudflare Workers destination reachable: any capability that cannot run
in an isolate never enters the agent path.

## The seam

Agent code (`src/shell`, `src/vfs`, `src/python`, `src/node`, skill
bodies) may depend only on:

- the `Vfs` interface (backends: in-memory, disk, R2 — the agent never
  knows which),
- the `ShellLike` interface (backends: just-bash everywhere; real bash
  only behind `server/`),
- `fetch`, WebCrypto, `TextEncoder`, timers,
- WASM toolchains (pyodide, ts-rust, esbuild-wasm, wasm-git).

Forbidden in agent code: static `node:` imports, `process.env` / `Deno` /
`Bun`, spawning `Worker`s (except the two documented loaders below),
and any import reaching into `server/` or `scripts/`. Dynamic host hints
that degrade gracefully (e.g. reading a dev-machine key via
`globalThis.process.getBuiltinModule`) are allowed but never required.

`scripts/check-isolate-pure.sh` enforces this; CI fails the build on
violation. Run it locally after touching agent code.

## Worker loaders (the two exceptions)

`src/shell/commands/python-cmd.ts` and `src/node/run.ts` spawn a nested
`Worker` to run pyodide / the node runtime off the main thread. That is
the browser/node strategy. On Cloudflare Workers (no nested workers) the
same worker files load in-isolate instead — the Durable Object already
provides tenant isolation, so the extra worker buys nothing. Both files
carry an `ISOLATE-GATE` marker; the gate requires the marker.

## What this buys

- The Telegram image flow (Pillow) and the document flow (pure-Python
  extraction) run byte-identical code in pyodide and on real python.
- The `workers/` entry (R2 VFS + DO router + Queues ticker + Secrets
  bindings) composes only seam-clean pieces — no agent rewrite.
- `server/` stays as the single-box self-host runner: same agent,
  machine-backed shell and disk. It is optional, never required.

## Known limits (grep can't see these — reviewers eyeball for them)

- `eval`/`Function` laundering of host access.
- Worker-alias indirection (`const o = Worker; new o()` — only the
direct spellings are grepped).
- Whitespace-obfuscated member access (`process .env`).
- `*.test.ts` files are trusted by name; the gate only verifies they
also import from vitest (check 5).
- The sanctioned `ISOLATE-ALLOW` site (agent.ts `hostMetaKey`): a
guarded, degrading hint, never required. Any new `ISOLATE-ALLOW`
needs adversarial review, not just a marker.
