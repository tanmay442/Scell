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
