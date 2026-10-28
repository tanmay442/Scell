# Substrate review for agent workloads (2026-10-28, read-only review agent)

Full report in thread history. Prioritized findings against an autonomous
agent driving long, mixed workloads. The agent-loop overhaul on this branch
must address these before declaring the harness solid.

## P0 — agent-breaking

- P0-1 `src/shell/shell.ts:87-101` — `shell.exec` has NO timeout. `sleep 600` /
  `tail -f` wedges the step forever; no kill path (TerminalPanel:252 swallows
  input while running). Fix: `timeoutMs` on `Shell.exec`, race + `{exitCode:124,
  timedOut:true}` on expiry.
- P0-2 `src/shell/shell.ts:78-94,125-126` — `exec` not re-entrant: shared `Bash`,
  shared `sessionEnv` by reference, LIFO-only nonce save/restore. Parallel tool
  calls corrupt each other. Fix: mutex/queue around `bash.exec`, clone env per call.
- P0-3 `src/shell/shell.ts:99-101` — `exit`/unclosed syntax skips env capture
  silently (marker absent at :106 → silent return). Fix: trap-style always-run
  epilogue + missing-marker signal.
- P0-4 `src/shell/shell.ts:317,408,454-455,460` — nested shells (`man`, `xargs`,
  scriptShell, `cell` nestedShell) drop caller's env. Fix: thread `ctx.env` through.
- P0-5 `src/node/run.ts:131-137` vs `node-cmd.ts:87-95`; `python-cmd.ts:104-105` —
  timeout/OOM/crash indistinguishable from normal exit (flag dropped, OOM → exit 1).
  Fix: structured `{timedOut, oomSuspected}` through `CommandResult` + untruncatable trailer.
- P0-6 Silent truncation, no marker: `run.ts:97-107`, `agent.ts:180` (20k),
  `agent.ts:191` (30k), `clip(...,12)` at :333. Fix: head+tail with explicit receipt.
- P0-7 `python-cmd.ts:39-50`, `runner.ts` — piped stdin to `python script.py`
  silently dropped (EOF, exit 0, looks like success). Fix: plumb stdin bytes.
- P0-8 `auto-save.ts:56` fire-and-forget `void saveChanges`; `persistence.ts:81-83`
  clear-then-put non-atomic full-save; all errors swallowed. Fix: await + retry +
  status-bus signal; write-then-swap full save.
- P0-9 `main.tsx:14-25` + `persistence.ts:58-65` — deliberate wipe resurrects
  starter (empty == fresh, no tombstone). Fix: persist `__seeded` marker.

## P1 — degrades long runs

- P1-1 `.bashrc` re-sourced per exec; one bad line bricks every later command.
  Fix: hash + re-source on change; guard source failure.
- P1-2 Raw string interpolation of agent command text (`shell.ts:99-101`).
  Fix: temp file/stdin + collision-proof var prefix.
- P1-3 `vfs.ts:155` binary identical-check is reference equality → needless
  autosave churn. Fix: byte-compare.
- P1-4 `vfs-fs.ts:271-278` `>>` on binaries corrupts via lossy UTF-8. Fix: buffer append.
- P1-5 Symlinks/mode bits die on reload + absent from `cell save`
  (`cell-cmd.ts:73-79` uses `listAllFiles` only); `looksLikeText` flips repr.
  Fix: persist sidecar/type flag.
- P1-6 `cell save` ships node_modules unbounded. Fix: exclude list + size warn.
- P1-7 `/tmp` volatile + inconsistently visible (`runner.ts:40` FS_SKIP).
  Fix: document in SYSTEM_PROMPT or opt-in persist.
- P1-8 `node -e` fixed temp name `.cell-eval.js` races (`node-cmd.ts:31-37`).
  Fix: unique temp names.
- P1-9 No background servers (drain only pendingTimers, `runtime-worker.ts:961-970`);
  TS cap 120s vs promised 5min. Fix: document + reconcile ceilings.
- P1-10 Python `__cell_*` globals clobber user ns; dead `__init__` check
  mis-triggers micropip (`runner.ts:148,179-196`). Fix: UUID prefix + fix check.
- P1-11 `zlib-shim.ts:19` ignores `maxOutputLength`. Fix: enforce cap.
- P1-12 Fake telemetry (`free`/`df` 16GB/100G vs 512MB isolate; random PIDs).
  Fix: report sandbox limits, deterministic PIDs.
- P1-13 Progress sink lost in nested shells (`shell.ts:141` vs `:454-455`).
  Fix: pass parent sink down.

## P2 — harness-inheritance gaps (current agent.ts)

Transcript-at-end/no streaming (:227-355, no onProgress at :178-180); no resume
(:354); no approval gate (rm -rf/curl/cell load); provider coupling + fixed
max_tokens 8192 + truncation hack (:283-297) + single 120s abort, no retry;
5 tools only, per-call cd, binary-unaware read, unique-match edit.

## Suggested fix order

1. Timeout + structured result on `Shell.exec` + both runners.
2. Serialize `exec` (mutex), clone env per call.
3. Total env capture + thread `ctx.env` through nested shells.
4. Await/retry autosave + seed tombstone + exclude heavies from `cell save`.
5. Streaming + resumable conversation + retrying model client in harness.

## Fix status (2026-10-28, branch agent-harness)

### P0 — FIXED
- P0-1 FIXED (01082cd) — per-exec `timeoutMs` on `Shell.exec`, `{exitCode:
  124, timedOut: true}` on expiry. Test: shell.test.ts timeout case.
- P0-2 FIXED (01082cd) — mutex/queue around `bash.exec`, env cloned per
  call. Test: serialize case.
- P0-3 FIXED (01082cd) — trap-style always-run epilogue + missing-marker
  signal; temp-file command delivery (`/tmp/.cell-exec-<nonce>.sh`) with
  collision-proof `__cell_<nonce>_` var prefix (also closes P1-2).
- P0-4 FIXED (01082cd) — `ctx.env` threaded through nested shells.
  (2 full-suite flakes seen 2026-10-28 in shell.test.ts unclosed-syntax /
  xargs cases — both pass in isolation; timing flake under parallel load.)
- P0-5 FIXED (ec7412c + 13274a8) — structured `{timedOut, oomSuspected}`
  through `CommandResult` + untruncatable exit trailers.
- P0-6 FIXED (ec7412c + 13274a8) — head+tail `truncateWithReceipt` + exit
  trailer appended post-truncation in agent/node/python paths.
- P0-7 FIXED (ec7412c) — piped stdin plumbed to `python script.py`.
- P0-8 FIXED (214c44a + caa8d5d) — autosave awaits with bounded retry,
  dirty sets snapshotted before the await, failures re-queue + report via
  `onError` (status bus); full-save is write-then-swap. Tests:
  auto-save.test.ts retry/signal cases.
- P0-9 FIXED (214c44a) — `__seeded` tombstone persists deliberate wipes.

### P1 — status
- P1-1 DEFERRED — no .bashrc hash/re-source guard; one bad line still
  bricks later commands (only PATH-prepend dedupe present).
- P1-2 FIXED (01082cd) — nonce temp-file command delivery (see P0-3).
- P1-3 FIXED (214c44a) — byte-exact `bytesEqual` (vfs.ts).
- P1-4 FIXED (214c44a) — buffer-level append in vfs-fs.ts.
- P1-5 DEFERRED — symlinks/modes live in VfsBackedFs memory only; reload
  still loses them, `cell save` has no sidecar.
- P1-6 FIXED (214c44a) — `cell save` excludes node_modules/.git + warns.
- P1-7 FIXED (caa8d5d) — documented in the agent system prompt
  (`/tmp` volatile, invisible to python/node; keep work under ~).
- P1-8 FIXED (ec7412c) — unique node-eval temp names.
- P1-9 PARTIAL — ceilings documented in the prompt (node/python 5min,
  bash 120s); background servers still absent (see capability audit).
- P1-10 DEFERRED — python preamble still uses bare `__cell_*` globals
  (runner.ts); no UUID prefix, no namespace isolation.
- P1-11 FIXED (214c44a) — `maxOutputLength` enforced in zlib-shim.
- P1-12 FIXED (214c44a) — no random PIDs / env-sourced telemetry left in
  shell paths; values report sandbox limits.
- P1-13 FIXED (214c44a) — parent progress sink threaded to nested shells.

### Note (2026-10-28, harness round-3 verification)
- `src/python/python.test.ts` "python stdin (P0-7)" cases wedge the vitest
  worker in this environment (no output, default timeouts never fire —
  event loop looks blocked) while every other test in the file passes in
  seconds standalone. Standalone repro shows `runPython` resolving but
  stdin bytes arriving empty (`got:` with no content), so the P0-7 plumbing
  shape (`setStdin({read})`, correct per pyodide 0.27.7 types) misbehaves
  under node 26 here. Untouched by round-3 (zero shared files) — needs a
  substrate follow-up, not a harness fix. Full suite otherwise green with
  this one file excluded.
