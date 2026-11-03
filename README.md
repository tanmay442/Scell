# Cell

A complete development environment that lives entirely inside one browser tab.
Filesystem, bash shell, TypeScript compiler, node runtime, Python data stack,
npm, git, a live app preview and an AI agent harness — all running on V8
(WebAssembly where it counts). **No server, no container, no kernel, no
backend compute.** Clone a repo, install, edit with live typechecking, run,
test, commit, push, convert images, preview the running app, snapshot the
workspace — everything persists in the browser.

```
pnpm install
pnpm dev          # → http://localhost:5199
```

That's the whole setup. The WASM toolchain (21 MB total) is committed under
`public/wasm/` — no native builds, no downloads.

The app opens on the **Agent home**: a chat front door (sessions with
model-generated titles, skills, tools, model settings, a status dock with
agent/jobs/review state) where a general-purpose agent works for you. Ask
it anything — questions are answered directly; when work needs doing it
has bash, files, git, python and a live preview. Every thread works in
its own workspace folder (`~/threads/<session-id>/`), invisible to other
threads, threads keep running in the background when you switch away,
generated files are linked inline and open in a preview, and HTML visuals
render in the thread itself. There is no step limit in the UI (the stop button is the
guardrail); the terminal's `cell agent "task"` takes `--steps N` only
when you ask for one. The full IDE — editor, terminal, git, preview —
is one click away under **Workspace**, and everything below describes
both surfaces.

## What works (all asserted by tests)

| Capability | How it's real | Verified by |
|---|---|---|
| Filesystem | In-memory VFS, text + binary files, full user home (`~`), dotfiles, volatile `/tmp` | unit + e2e |
| Persistence | Incremental IndexedDB saves (node_modules included), single-pass load, `navigator.storage.persist()`, flush on tab-hide; agent sessions persist after **every step** with a live-run flag, so a closed/crashed tab reopens threads with history intact and an "interrupted — send a message to continue" note; composer drafts, the open thread (auto-reopened with history), and UI state (mode, editor tabs) survive reload too | e2e: deps survive reload; restart + mid-run kill verified |
| bash | just-bash + session env, `~/.bashrc` sourced every command, shebang scripts, heredocs, pipes, subshells, `[[ ]]`, `set -e`, tar/gzip, sqlite3, `curl` (browser fetch, CORS applies) | `bash-audit.test.ts` (17 assertions) |
| System identity | `uname`, `id`, `df`, `free`, `ps`, `uptime`, `hostname`, `which`, `man`, `less`, `/etc/os-release`, `/proc/*` | `bash-audit.test.ts` |
| node | Fresh V8 worker per run, CommonJS resolver with walk-up, circular imports, shebangs, shell env → `process.env`, write-back to the VFS, 5 min ceiling | `worker-exec.test.ts` + e2e |
| TypeScript | ts-rust (Rust port of TS 7) in WASM: live editor diagnostics, `tsc` CLI, TS runs directly on `node` | e2e |
| npm/pnpm/npx | Real registry: semver, SHA-1-verified tarballs, scoped packages, npm aliases (`npm:x@y`), project-root installs, `-g` with PATH bins, scripts with `node_modules/.bin` | e2e: subdir install + global bins |
| git | Real libgit2 1.9.4 (wasm-git). `.git` is a visible directory; clone/fetch/push over https — CORS-blocked hosts (github) go through a relay chain automatically; `pull` = fetch+merge | e2e: clone from a real git server + github through the relay |
| App preview | `cell preview`: esbuild-wasm bundles the module graph in-page (exports maps, subpaths, tsx, images), Tailwind compiled live by the oxide runtime, `public/` served at root, Vercel-style `api/*.js` executed per request in the isolate, hot reload | browser e2e benchmarks (style + asset truth probes) |
| Object storage | `cell save/list/load/status` — whole-workspace tar.gz to any S3-compatible endpoint, SigV4 on WebCrypto (verified against botocore) | `cell-cmd.test.ts` |
| Python | Pyodide CPython 3.12 in a worker (numpy, pandas, scipy, matplotlib and Pillow wheels vendored — no downloads), `python3` CLI, argv/cwd/stdin semantics, `matplotlib` PNGs, write-back to the VFS | `python.test.ts` (incl. Pillow convert/resize/verify) |
| Images | Drop any photo on the composer (staged into the thread workspace, 25 MB cap) or point at a workspace file, then ask: exact-dimension resize (LANCZOS), JPEG/PNG/WebP converts, quality byte-budget loops, EXIF normalize/strip — driven by the built-in `images` skill (Pillow), outputs verified by reopening and linked inline as previewable file chips | `python.test.ts` + live browser/server runs |
| AI agent | Agent home (front door) + `cell agent "task" [--steps N] [--resume <id>]` in the terminal — Meta/Anthropic/OpenAI/OpenAI-compatible tool loop over `bash`/`read`/`edit`/`write`/`ls`/`load_skill`/`job_start`/`job_poll`/`job_list`/`history_search`/`memory_save`/`memory_list`/`skill_install`/`remind`/`delegate` + custom `~/.cell/tools/*.json`, skills with progressive disclosure (`bot`, `commit`, `preview`, `debug-tsc`, `images`; user-installed skills land in `~/.cell/skills/`; project overrides win), slash commands (`/commit`, `/preview`, custom), persisted sessions (model-generated titles, pin/lock/archive/fork/share), resumable chat with restored history, per-thread workspaces that keep running in the background, HTML visuals rendered in-thread, attached-file staging, per-tool approval in Ask mode (default: full permission), background jobs, secret redaction, SSE streaming, abort + auto-compaction | `agent*.test.ts` |

## Architecture

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
│ (transferable ArrayBuffer + offset index, lazy decode)       │
├──────────────────────────────────────────────────────────────┤
│ VFS — in-memory tree (text + binary), watch events           │
├──────────────────────────────────────────────────────────────┤
│ IndexedDB (incremental) · ServiceWorker CacheStorage · S3    │
└──────────────────────────────────────────────────────────────┘
```

How the pieces talk:

- **Type a command** → xterm → `shell.exec` → just-bash parses → the VFS
  adapter maps bash paths 1:1 onto the VFS → coalesced events repaint the UI
  → autosave flushes the diff.
- **`node app.ts`** → (ts-rust emit if TS) → the workspace snapshot is
  transferred as one zero-copy buffer → the worker runs CJS with a shared
  `require.cache` → output coalesced back → only touched files write back.
- **`python3 script.py`** → same worker pattern through Pyodide: imports
  resolve from vendored wheels (Pillow/matplotlib/numpy/pandas, offline),
  anything else pure-python comes via micropip; written files land back in
  the VFS (text and binary), so `Image.save(...)` output is immediately
  readable, previewable, and committable.
- **`git commit`** → VFS ⇄ libgit2 MEMFS two-way sync (binary-safe) → lg2
  runs → sync back → the GitPanel re-discovers repos by scanning for `.git`.
- **`cell preview`** → bundle → document → CacheStorage → service worker
  serves it at `/` (routers match) → your app runs → `fetch('/api/x')` →
  shim → host → your function in the node isolate → response.
- **`export KEY=v; node …`** → the session environment is captured in-band
  after every command, restored before the next, and injected into
  `process.env` (most-specific-last: defaults < `~/.cell/env.json` < shell).

The bash session model: just-bash is per-execution, so Cell sources
`~/.bashrc` in front of every command and captures the resulting environment
in-band (brace-wrapped dump, exit code preserved, output line stripped). The
result behaves like a real interactive shell: exports persist, `.bashrc`
applies everywhere, aliases are defined, and an agent cannot tell the
difference through the container-detection probes.

## Repository layout

```
src/
  vfs/            VFS core, IndexedDB persistence, autosave, starter home
  shell/          just-bash integration, session env, system commands
    commands/     node npm git tsc cell agent curl + registry/installer/untar
  node/           the V8 isolate runtime (payload, worker, resolver, transform)
  python/         Pyodide runner (payload, worker, micropip fallback)
  lang/           ts-rust language service (worker) + diagnostics mapping
  preview/        esbuild bundler, document builder, SW, api runner
  terminal/ ui/   the IDE (xterm, CodeMirror, panels)
server/           headless agent: disk VFS, real-bash shell, run-once CLI,
                  HTTP+SSE server, gateway (auth/limits/usage), per-thread
                  router, boot resume, job ticker, snapshot store, bindings
Dockerfile.agent  node:22-slim + fflate/semver + python3-pil; CMD = server
scripts/
  agent-run.sh / agent-server.sh   one-shot and server containers
  e2e.mjs              main e2e over headless Chrome (raw CDP, no deps)
  e2e-gdg.mjs          benchmark: clone/build/preview the gdg-hbtu site
  e2e-scribe.mjs       repro: clone/build/preview the scribe site
  e2e-agent.mjs        live agent loop against the Meta API (CELL_AGENT_LIVE_KEY)
  git-http-server.mjs  real `git http-backend` server for clone tests
  vendor-public.mjs    postinstall: materialize public/vendor/ from npm
public/
  wasm/           committed toolchain: esbuild (14M), ts_rust (6M), lg2 (1.6M)
  vendor/         generated by postinstall (gitignored): pyodide core copied
                  from the versioned npm package — the python offline fallback.
                  (The tailwind browser runtime is bundled from
                  @tailwindcss/browser via `?url`, not copied.)
  cell-preview-sw.js   the preview service worker (plain JS — parsed as-is)
```

Source of truth for behavior: the tests. `bash-audit.test.ts` pins the shell
realism, `worker-exec.test.ts` runs the actual node worker against real
registry packages, and the three e2e scripts drive the real UI in headless
Chrome over raw CDP.

## Testing

```sh
pnpm test        # unit tests (vitest)
pnpm build       # typecheck + production build

# browser e2e (needs the dev server on :5199 — `pnpm dev` — plus internet:
# the main flow clones github.com/octocat/Hello-World and hits the npm
# registry; the gdg/scribe benchmarks clone live project repos):
pnpm e2e              # main flow (or: node scripts/e2e.mjs)
pnpm e2e:gdg          # gdg-hbtu benchmark
pnpm e2e:scribe       # scribe repro
CELL_AGENT_LIVE_KEY=LLM_… pnpm e2e:agent  # meta agent harness (skips without the key)
```

The e2e scripts are dependency-free (raw Chrome DevTools Protocol over
WebSocket) and spawn their own headless Chrome (`google-chrome-stable` by
default, `CHROME_BIN` to override; `APP_URL` to point at another server).
The main script covers the full user journey: boot, editing, typecheck,
node, npm, git cycles, preview with api functions, github clone through the
relay, and reload persistence — against its own local git fixture server
plus the live registry and github (internet required).

## Configuration (all optional, all in `~`)

| File | Purpose |
|---|---|
| `~/.gitconfig` | git identity — edited in the app, bridged into libgit2 |
| `~/.cell/agent.json` | `{ "provider": "meta" \| "anthropic" \| "openai" \| "compat", "model": "…", "apiKey": "…", "baseURL": "…" (compat), "permission": "full" \| "ask" (default full), "thinking": "minimal".."xhigh" (meta reasoning effort) }` — seeded with meta defaults; in the browser the key must be in this file or the Agent panel (there is no host auth file in a tab); under Node/vitest meta also resolves `~/.pi/agent/auth.json` |
| `~/.cell/env.json` | env vars for node processes and api functions (`{"GOOGLE_API_KEY": "…"}`) |
| `~/.cell/tools/*.json` | custom agent tools: `{ "name", "description", "parameters", "run": { "kind": "bash", "command": "… {{arg}} …" } }` |
| `~/.cell/skills/<name>/SKILL.md` | agent skills (frontmatter `name`+`description`, markdown body); project override at `<project>/.cell/skills/`; builtins seeded automatically: `commit`, `preview`, `debug-tsc`, `images` (Pillow recipes) |
| `~/.cell/commands/*.md` | agent slash commands (`/commit`, `/preview` seeds) |
| `~/.cell/sessions/*.json` | agent sessions: transcript + resumable history + sidebar metadata (`title` model-generated, `pinned`, `archived`, `locked`); resume via the sidebar or `cell agent --resume <id>` |
| `~/.cell/job-queue.json` | durable agent job table (`continue`/`snapshot`, 5-attempt cap then visible `dead`) — server ticker fires due jobs; terminal jobs live in-process |
| `~/.cell/usage/` | server JSONL usage log (auto-rotates at ~10 MB) |
| `~/.cell/storage.json` | S3-compatible endpoint for `cell save/load` snapshots |
| `~/.gitconfig` `[cell] corsproxy` | custom git CORS relay list (`off` disables) |

## Honest limits

Browsers are the physics: no `child_process`, no native binaries (packages
that ship machine code — e.g. vercel, opencode — install but say so plainly;
the server image instead ships `python3-pil` via apt for the `images` skill),
no SSH remotes, no listening servers (preview + api functions replace them),
ESM-with-top-level-await CLIs can't run in the CommonJS isolate, and network
access obeys CORS (hence the git relay chain). Long-running processes cap at
5 minutes per run. Composer attachments: images stage as bytes (25 MB max)
into the thread workspace; other files inline as text (200 KB / 12k chars
clipped). Everything else behaves like the real thing — including
the parts an agent would probe.

## Headless agent (single box)

The same `runAgent` loop as `cell agent`, without the browser: disk-backed
VFS, real bash via `child_process`, fresh shell per request. Two entry
points, compiled with `pnpm server:build` into `dist-server/`:
`dist-server/server/run-once.js` (one task, then exit) and
`dist-server/server/server.js` (HTTP+SSE on `CELL_PORT`).

Agent config lives at VFS `/home/user/.cell/agent.json`, i.e. on disk at
`$CELL_WORKSPACE/home/user/.cell/agent.json`. When that file is missing it
is seeded from env (`CELL_PROVIDER` default `meta`, `CELL_MODEL`,
`CELL_AGENT_KEY`, `CELL_BASE_URL`, and `CELL_AGENT_LIVE_KEY` as the meta
key); when it exists the file wins. The image also ships `python3` +
Pillow, so the `images` skill (exact dimensions, format converts,
byte budgets) runs the same scripts as the browser pyodide path.
Note: `pnpm server:build` compiles into `dist-server/` (gitignored) —
build before `docker build`, and rebuild after pulling new source.

Quick start:

```sh
pnpm server:build
docker build -f Dockerfile.agent -t cell-agent .

# one-shot: runs run-once.js, container is removed on exit
./scripts/agent-run.sh "fix the failing test" --steps 20
./scripts/agent-run.sh "keep going" --resume agent-abc123 --workspace ./workspace

# server mode: detached, restarts unless stopped
./scripts/agent-server.sh --workspace ./workspace --port 8787
curl http://localhost:8787/health
# {"ok":true}
```

Agent runs stream as SSE `data:` lines (one JSON object per line):

```
data: {"type":"progress","line":"…"}
data: {"type":"done","exitCode":0,"stdout":"…","stderr":"","sessionId":"…","threadId":"…"}
```

The `done` event always arrives — even when the model transport throws
(`exitCode: 1` + error text, no silent hang). Hitting the step budget is
exit code 2 everywhere (terminal, SSE, usage rows, job retries):
unfinished work is never reported as success.

Every run is confined to its own thread dir (`/home/user/threads/<id>`)
plus a shared `~/.cell` mount — it cannot name other threads' files.
One run per thread at a time: a second `POST /run` for a busy thread gets
`409 {"error":"thread busy"}`.

Routes: `GET /health` (no auth, `{ok:true}` only), `POST /run`
`{prompt, resumeId?, maxSteps?, cwd?}` (400s validated: bad JSON, empty
prompt, bad `resumeId`/`cwd`, non-finite `maxSteps`; 410 when the resume
target's thread workspace was deleted), `GET /jobs` (includes `busy`
threads), `POST /jobs` (`threadId` must be a bare stem, `runAt` finite
epoch ms, `kind` strictly `'continue'`/`'snapshot'`), `DELETE /jobs/:id`.
Interrupted runs (server died mid-run) are requeued as `continue` jobs on
boot and picked up by the ticker — the server resumes work by itself.
One-shot runs can `--pull <name>` a snapshot before starting and
`--push <name>` after finishing (slim tar, skips when unchanged; request
bodies over 4 MB get 413).

Snapshots are per-thread by default on the server: a snapshot named for
a thread covers that thread's dir plus its session records — restoring
never touches sibling threads. Pull validates members (no absolute paths,
no `..`, no symlinks,
hardlinks, FIFOs, sockets, or devices), verifies tar bytes against the
manifest hash, extracts to a scratch dir inside the workspace, and only
then swaps the result in — a corrupt tar cannot destroy live state.
Slim snapshots skip `node_modules`, `.git`, `.cache`, and `.cell/usage`.
One caveat: non-regular files (symlinks, FIFOs) are skipped on push
with no warning — snapshots preserve regular files and directories only.

| Env var | Purpose | Default |
|---|---|---|
| `CELL_WORKSPACE` | VFS root on disk | `/workspace` (in container) |
| `CELL_PORT` | server listen port | `8787` |
| `CELL_PROVIDER` | `meta` \| `anthropic` \| `openai` \| `compat` | `meta` |
| `CELL_MODEL` | model id override | provider default |
| `CELL_AGENT_KEY` | api key written into `agent.json` | — |
| `CELL_AGENT_LIVE_KEY` | meta key fallback when no api key is set | — |
| `CELL_BASE_URL` | base URL for `compat` provider | — |
| `CELL_TIMEOUT_MS` | whole-run timeout (ms) | `600000` |
| `CELL_API_TOKENS` | `id:token,…` for `Authorization: Bearer`; empty = open | — |
| `CELL_RATE_MAX` / `CELL_RATE_WINDOW_MS` | per-token rate limit | `60` / `60000` |
| `CELL_USAGE_DIR` | JSONL usage log dir | `<workspace>/.cell/usage` |
| `CELL_JOBS_INTERVAL_MS` | job ticker poll interval | `30000` |
| `CELL_RESUME_ON_BOOT` | requeue interrupted runs at boot | `true` |
| `CELL_SNAPSHOTS_DIR` | local snapshot store | `<workspace>/../snapshots` |
| `CELL_S3_*` | S3 snapshot backend (`ENDPOINT, BUCKET, ACCESS_KEY, SECRET_KEY`, optional `REGION, PREFIX`) | local store |

Limits: auth is a shared bearer token, not user accounts — localhost or a
private network. One box, no autoscaling — run one container per workspace
(enforced by a fencing-token lockfile: a second boot waits up to 60 s for
the holder's heartbeat to go stale, takes over a dead holder, and refuses
while a live holder keeps beating; the deposed holder exits instead of
split-braining). Bash is not chrooted: the hard boundary is the VFS scope
plus the existing deny-pattern scans (agent shells also inherit only a
minimal env allowlist — no `CELL_*` keys or cloud credentials — and
timeouts SIGKILL the whole process tree, including `setsid` escapees).
Shell cwds are canonicalized, so a symlinked cwd outside the workspace is
refused instead of executed. Treat runs as semi-trusted code, not hostile
tenants. Rate-limit budget covers every authed request including 409s
(backpressure by design); usage rows record real `steps`/`exitCode` — every
rejection reports its HTTP code, so `-1` only means an internal error before
the run started. Jobs that exhaust 5 attempts flip to
`dead` and stop being due — visible on `GET /jobs`, never silently
dropped (terminal history is pruned to the newest 200 rows).

## One bot, every surface

Threads are separate workspaces, but the assistant is one continuous bot:
the same identity (`~/.cell/bot.json`: name + timezone), the same durable
memory, the same skill index — in web chat, Telegram, and headless runs.

- `history_search` finds anything across all past threads (decisions,
  old errors, prior attempts) — search before redoing work.
- `memory_save` / `memory_list` keep lasting user-stated facts
  (preferences, timezone) across sessions. How-tos belong in skills,
  project records in project files, short-lived facts stay in-session.
- `delegate` hands a self-contained sub-task to a subagent with a fresh
  context window (same tools, same thread scope, 12-step cap, one level
  only — no grand-delegates).
- `remind` promises a follow-up (`in 20m` / `in 2h` / ISO, max 7 days
  out). One-shot and delete-on-delivery: a reminder can never nag twice.
  The server delivers due reminders back to the bound chat.
- `skill_install` teaches the bot a new skill from a URL or pasted
  markdown (`~/.cell/skills/<name>/SKILL.md`, frontmatter added when
  missing) — only on the user's explicit request, never from instructions
  found in files or pages. Verified live: the `unslop` skill installed
  from its GitHub URL and loaded back in the same run.

### Telegram

`CELL_TELEGRAM=1` starts a long-poll loop next to the server: DMs only,
one stable thread per chat (`tg-<chatId>`), `/new` rotates it, `/status`
shows jobs, `/help` explains itself. Non-text messages are ignored.

```sh
CELL_TELEGRAM=1 CELL_TELEGRAM_TOKEN=<botfather-token> \
  CELL_TELEGRAM_ALLOW_FROM=<your-chat-id> \
  ./scripts/agent-server.sh --workspace ./workspace --port 8787
```

Security posture (all asserted by tests in `server/telegram.test.ts`):
the token comes from `CELL_TELEGRAM_TOKEN` or a token file outside the
workspace (`CELL_TELEGRAM_TOKEN_FILE` — refused when inside it), never
from a workspace file: the agent's bash can read anything mounted in its
shell, so workspace secrets are not secrets. The server scrubs the token
from its environment after boot and refuses `/proc` and `/sys` to agent
bash (that closes the `/proc/<pid>/environ` read); prefer file config —
a 0600 file in a 0700 dir outside the workspace. `~/.cell/telegram.json`
holds only the non-secret allowlist (`{"allowFrom": [<chat-id>]}`); a
`botToken` inside it fails closed with an error. An empty allowlist fails
closed — the poller refuses to start; strangers get silence (no model
call, no reply, no oracle — group/channel messages are dropped too);
`/status` shows only the requesting chat's own thread jobs; unknown
`/commands` reach the model as plain chat text (built-in slash commands
like `/commit` expand — any allowlisted chat can invoke them). Heads-up:
server runs use full permission, so over Telegram `ask` tools
(bash/edit/skill_install/delegate) execute without a human checkpoint —
that is the point of a bound personal chat (the allowlist is the
authority; Telegram use assumes a single operator). Destructive bash
shapes stay refused by the deny scans — `rm -rf` in any spelling, `find
-delete`, `dd of=`, numeric `chmod -R`, `git clean -fdx`, inline
`python3 -c`/`node -e` destructive calls, and one hop of variable
aliasing (`F=…; cat $F`, `${VAR:-default}`, `cat<file`). Skill installs
are https-only with loopback/private hosts refused. If a token ever
passes through a chat log, `/revoke` it with BotFather and mint a fresh
one.

| Env var | Purpose | Default |
|---|---|---|
| `CELL_TELEGRAM` | `1` enables the Telegram poll loop | off |
| `CELL_TELEGRAM_TOKEN` | Bot API token (never logged, never committed) | — |
| `CELL_TELEGRAM_TOKEN_FILE` | path to a file holding the token — must be outside the workspace | — |
| `CELL_TELEGRAM_ALLOW_FROM` | comma-separated chat ids (or `allowFrom` in `~/.cell/telegram.json`) | empty = poller refuses to start |

## Docs

Historical design documents live in [`docs/`](docs/): `ARCHITECTURE.md`,
`CONTRACTS.md`, `PHASES.md` (from the phase-planning era; the README above is
the current truth).
