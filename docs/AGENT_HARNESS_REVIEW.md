# Harness code review (2026-10-28, independent reviewer, commit 8c9144a)

Scope: agent.ts, agent-providers/tools/skills/sessions/commands/redact +
tests + e2e-agent.mjs. Verdict: real, well-tested single-track loop — but
approval decorative, secrets can exit via progress/key-read paths, resume
proven for one shape only, long-run robustness absent.

## P0

- P0-1 Custom tool shadows builtin: agent.ts:251-268 builds a second
  `customTools` map with no name/shadow check; runTool checks customs BEFORE
  builtins. `~/.cell/tools/bash.json` hijacks every bash call. Fix: delete
  duplicate loader, use `loadCustomTools` directly.
- P0-2 Secrets bypass redaction on progress sink: agent.ts:374,
  agent-providers.ts:317 emit raw text via onProgress. Fix: wrap both in
  redactSecrets.
- P0-3 Agent can read its own keys raw: no deny-list; `read ~/.cell/agent.json`
  succeeds and raw toolResults re-enter model context. Fix: deny-list
  agent.json/auth.json/sessions in read (and bash-independent layer), or redact
  tool results before appending to state.
- P0-4 Approval is theater: `❓ approval … auto-approved`, always proceeds.
  `rm -rf ~`, `curl|sh`, self-modifying writes all run. Fix minimum: deny-list
  (config/tools/skills/sessions paths, `rm -rf`, `cell load/save`) that errors;
  honest fix: real allow/deny gate.
- P0-5 Anthropic/OpenAI resume duplicates prompt: :272 seeds, rebuildState
  replays without clearing, :275 pushes prompt again. Fix: empty state on
  resume. No test covers non-meta resume.
- P0-6 Meta resume drops unresolved outputs: setMetaPendingUser clears
  pendingOutputs; resume sends only new user message → 400/confused model.
  Fix: flush persisted tool results as function_call_output first, then user
  message (two hops), or re-anchor fresh.
- P0-7 No retry; every transient ends run (agent.ts:301-306 fatal). Fix:
  jittered backoff on 429/529/5xx/timeout; re-anchor on chain-expiry 400.

## P1

- P1-1 e2e sentinel false positive: command echo contains `e2e-agent-ok`.
  Fix: sentinel not present in command (model-computed UUID).
- P1-2 SSE buffered not live (awaits full text, replays deltas); 500-char
  slice no marker; parser splits on \n\n, single data: line, ignores \r\n.
  Fix: incremental reader, spec data: accumulation, redact, mark truncation.
- P1-3 Head-only truncation can cut `[exit N]` (agent-tools.ts:223-231, no
  separator between stdout/stderr). Fix: head+tail receipt, never cut trailer.
- P1-4 Unbounded live state (anthropic/openai); truncateTurns orphans
  tool_use/tool_result pairs → API rejects on resume. Fix: cut on pair
  boundaries, cap live state, real compaction later.
- P1-5 `--resume x.json` saves `x.json.json` (:289). Fix: strip suffix.
- P1-6 Skill warnings dropped (:269 destructures only skills); overrides
  silent. Fix: warn on every override/mismatch, surface in transcript.
- P1-7 Slash name unsanitized (`${root}/.cell/commands/${name}.md`).
  Fix: whitelist ^[A-Za-z0-9_-]+$.
- P1-8 loadSession reads arbitrary VFS paths. Fix: confine to SESSIONS_DIR.
- P1-9 read paging NaN + unbounded limit. Fix: default non-finite, clamp.
- P1-10 Duplicate custom-tool names → duplicate model entries. Fix: dedupe
  with warning.

## P2 (selected)

- Dead `recordProviderTurn` wrapper; truncated-turn path diverges live vs saved;
  slash unknown-cmd silent; frontmatter subset (CRLF, YAML-fold) undocumented;
  skill names unvalidated; interpolateArgs silent ''/[object Object];
  startedAt reset on resume; redact gaps: single-quoted values, bare
  KEY=value env lines, `key` field, lowercase bearer, private-key blocks,
  ?api_key= params, secrets split across truncation boundaries —
  add patterns + redact-then-truncate ordering.

## Missing tests (all runAgent-level, stubbed fetch)

python plot artifact; CSV analysis; preview driven by agent; edit+tsc
end-to-end; resume across fresh VFS (serialize → new VFS → resume); approval
line present for bash / absent for ls; custom tool via runAgent; skill
override via load_skill loop; OpenAI transport (zero tests); 4xx/5xx retry;
malformed arguments JSON; missing call_id; SSE multi-data/CRLF;
corrupt session; provider-mismatch resume; step-budget exhaustion;
unknown tool; NaN paging; shadow/duplicate tool files; frontmatter edges;
loadSession traversal; --resume double-suffix.

## Capability audit (still CANNOT)

1. background servers/processes 2. interactive approval 3. self secret/config
   protection 4. transient/chain-expiry recovery 5. long context (no
   compaction) 6. binary read 7. parallel tool calls 8. piped stdin/pty
   9. per-tool time/output bounds 10. free network (CORS/relay limits).

## Credibility

Meta single-hop credible; resume-after-text narrowly credible, not general;
SSE streaming half-true (buffered/sliced/unredacted); e2e proves transport +
save only; chain-expiry note honest — long meta chains die with 400 today.
