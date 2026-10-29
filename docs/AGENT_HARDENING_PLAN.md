# Agent hardening plan (folded from the two 2026-10-28 explorations)

Two read-only explorations (bash mediation bypasses; terminal/shell session
limits) converge on one principle: enforcement must sit where spelling no
longer matters — at the VFS — and approval must be a real gate at every
entry point. Text scanning stays as an early-error layer only.

## Findings that set the order

- The bash text scan is bypassed by at least six independent families:
  `$HOME` indirection, globs/concat/brace spellings, cwd-relative reads,
  symlinks (resolved below the scan), cross-call script files, and
  node/python full-workspace snapshots. `storage.json` (S3 secret) and
  `env.json` (user API keys) are not on the deny list at all. Fix at the
  VFS, not the tokenizer.
- The terminal cannot gate: input (incl. Ctrl-C) is dropped while a run is
  active; the 120s outer exec timeout would kill a run while the user
  thinks about an approval.
- `.bashrc` bricking root cause: the `exit()` shadow is defined after the
  source line, so `exit` in `.bashrc` kills every exec, silently, forever.
- Symlink/mode sidecar is per-shell, not just per-reload: a `chmod` in the
  terminal is invisible to a panel run in the same session.
- Panel approval uses a single resolver slot; two queued approvals would
  overwrite each other (FIFO needed in panel and terminal alike).

## Policy (adopted)

- Hard-deny, agent-originated, always: the whole `/home/user/.cell/` prefix
  (not five entries), `cell load/save` from agent bash, `rm` recursive+force,
  pipe-to-shell. Sanctioned channels (`load_skill`, `job_poll`, panel config,
  resume) cover every legitimate need.
- Approval-gated with scoped grants (later phase): installing home
  skills/tools/commands, project `.cell/skills|commands/` writes (they shape
  future instructions), `~/.bashrc` writes.
- Open: everything else, including `npm run` under the protected shell.

## Phases

1. **Protected VFS (M).** New `src/shell/protected-vfs.ts`: `wrapProtectedVfs`
   — protected reads look missing (never throw on read; node/python snapshot
   iteration depends on it), writes throw `EACCES`, listings filter `.cell`.
   `createShell(vfs, { protected: true })` wraps before `VfsBackedFs` and all
   command registrations, so bash/node/python/git/npm/tsc inherit it.
   Propagate through `nestedShellFrom` and `scriptShell`; mark only agent
   shells (panel ×2, `cell agent` nested shells). Human terminal untouched.
   `runAgent` keeps the raw VFS (harness-privileged reads). Deny constants
   move to `src/vfs/protected-paths.ts`; whole-`.cell` prefix. `JobManager`
   log writes go through `redactSecrets`. Tests: new `protected-vfs.test.ts`,
   new `agent-protected-shell.test.ts` replaying the bypass corpus (must fail
   under protected, must still succeed unprotected).
2. **Terminal approval (M).** Line-based `Approve <call>? [y/N]` prompt in
   TerminalPanel reusing line input; `approve` threaded `createShell` →
   `cellCommand`; FIFO approval queue (fix the panel slot too); outer exec
   timeout raised for `cell agent` runs; type-ahead buffer wiped when an
   approval opens. Jobs do not get the gate (their own `job_start` is gated).
3. **`.bashrc` guard (S).** Move the `exit()` shadow before the source line;
   bad-hash guard: retry once without `.bashrc`, visible note, no env merge
   from the failed attempt. Hash-skip with alias capture is a later M.
4. **Shared sidecar (M).** Symlinks/modes keyed to the Vfs (WeakMap),
   persisted as `~/.cell/fs-meta.json` (ordinary file — autosave and
   `cell save` carry it, no schema change). Fix `rm`/`mv` sidecar leaks.
   Add `fs-meta.json` handling to the protected set.
5. **Small terminal items (S each).** Final cwd returned in the env-dump
   epilogue (`ShellResult.cwd`); capped type-ahead buffer replayed at the
   prompt; delete the heredoc quote-strip rewrite; `scrollback: 10000`.
6. **Later.** Secret relocation (key in panel memory / env, not VFS);
   value-based redaction (replace known key literals); AST pre-scan for
   operation-level rules in protected shells; scoped grants for installs.

## Verification

Per phase: targeted test files only (listed in phase 1), typecheck, one
production build for UI phases. Full suite once before merge. Live
`e2e:agent` once after phases 1–2.

## Status (2026-10-29)

All five phases implemented, reviewed (two read-only reviews + one
re-review), fixed, and landed. 241 unit tests green; live e2e:agent
green. Probe trade-off recorded in shell.ts: the .bashrc probe sources
the rc once extra per uncached (hash, cwd). Remaining known limits:
exit-to-return rewrite covers line-start / ; / && / || spellings only
(other positions fail safe: rc skipped, user command runs); EACCES
mid-compound aborts the line like a thrown fs error; verdict cache is
keyed by (hash, cwd) only.
