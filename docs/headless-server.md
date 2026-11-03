# Headless agent (single box)

The same `runAgent` loop as `cell agent`, without the browser: disk-backed VFS, real bash via `child_process`, fresh shell per request. Powers Telegram and always-on work.

Two entry points, compiled with `pnpm server:build` into `dist-server/`:
`dist-server/server/run-once.js` (one task, then exit) and
`dist-server/server/server.js` (HTTP+SSE on `CELL_PORT`).

Agent config lives at VFS `/home/user/.cell/agent.json`, i.e. on disk at
`$CELL_WORKSPACE/home/user/.cell/agent.json`. When that file is missing it
is seeded from env (`CELL_PROVIDER` default `meta`, `CELL_MODEL`,
`CELL_AGENT_KEY`, `CELL_BASE_URL`, and `CELL_AGENT_LIVE_KEY` as the meta
key); when it exists the file wins. The image also ships `python3` +
the full data stack (Pillow, numpy, pandas, scipy, matplotlib), so the
`images` and `documents` skills run the same scripts as the browser
pyodide path.

Note: `pnpm server:build` compiles into `dist-server/` (gitignored) —
build before `docker build`, and rebuild after pulling new source.

## Quick start

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

## API

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

Routes: `GET /health` (no auth; `{ok:true, telegram:true/false}` — the flag means the poll loop is up, not that the bot token works), `POST /run`
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
no `..`, no symlinks, hardlinks, FIFOs, sockets, or devices), verifies tar bytes against the
manifest hash, extracts to a scratch dir inside the workspace, and only
then swaps the result in — a corrupt tar cannot destroy live state.
Slim snapshots skip `node_modules`, `.git`, `.cache`, and `.cell/usage`.
Non-regular files (symlinks, FIFOs) are skipped on push — snapshots preserve regular files and directories only.

## Workspace modes

In the UI, Agent home is the front door and the full IDE (editor, terminal, git, preview) sits one click away under Workspace — same files, both sides. On the server, the workspace is a plain directory (`./workspace` by default): back it up, mount it into a container, point several bots at several workspaces. Threads are just folders; sessions are just JSON.

There is no web→Telegram handoff: browser threads live in the tab, server threads live on disk — the web UI browses server threads read-only, and a Telegram thread continues only on Telegram.

## Env vars

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

Auth is a shared bearer token, not user accounts — localhost or a private network. One box, no autoscaling — run one container per workspace (enforced by a fencing-token lockfile: a second boot waits up to 60 s for the holder's heartbeat to go stale, takes over a dead holder, and refuses while a live holder keeps beating; the deposed holder exits instead of split-braining). Bash is not chrooted: the hard boundary is the VFS scope plus the existing deny-pattern scans (agent shells also inherit only a minimal env allowlist — no `CELL_*` keys or cloud credentials — and timeouts SIGKILL the whole process tree, including `setsid` escapees). Shell cwds are canonicalized, so a symlinked cwd outside the workspace is refused instead of executed. Treat runs as semi-trusted code, not hostile tenants. Rate-limit budget covers every authed request including 409s (backpressure by design); usage rows record real `steps`/`exitCode`. Jobs that exhaust 5 attempts flip to `dead` and stop being due — visible on `GET /jobs`, never silently dropped (terminal history is pruned to the newest 200 rows).
