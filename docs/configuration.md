# Configuration — everything in `~`

All optional. Edit in the app or on disk; the agent and the server read the same files.

| File | Purpose |
|---|---|
| `~/.gitconfig` | git identity — edited in the app, bridged into libgit2 |
| `~/.cell/agent.json` | `{ "provider": "meta" \| "anthropic" \| "openai" \| "compat", "model": "…", "apiKey": "…", "baseURL": "…" (compat), "permission": "full" \| "ask" (default full), "thinking": "minimal".."xhigh" (meta reasoning effort) }` — seeded with meta defaults; in the browser the key must be in this file or the Agent panel (there is no host auth file in a tab); under Node/vitest meta also resolves `~/.pi/agent/auth.json` |
| `~/.cell/env.json` | env vars for node processes and api functions (`{"GOOGLE_API_KEY": "…"}`) |
| `~/.cell/tools/*.json` | custom agent tools: `{ "name", "description", "parameters", "run": { "kind": "bash", "command": "… {{arg}} …" } }` |
| `~/.cell/skills/<name>/SKILL.md` | agent skills (frontmatter `name`+`description`, markdown body); project override at `<project>/.cell/skills/`; builtins seeded automatically: `commit`, `preview`, `debug-tsc`, `images` (Pillow recipes), `documents` |
| `~/.cell/commands/*.md` | agent slash commands (`/commit`, `/preview` seeds) |
| `~/.cell/sessions/*.json` | agent sessions: transcript + resumable history + sidebar metadata (`title` model-generated, `pinned`, `archived`, `locked`); resume via the sidebar or `cell agent --resume <id>` |
| `~/.cell/job-queue.json` | durable agent job table (`continue`/`snapshot`, 5-attempt cap then visible `dead`) — server ticker fires due jobs; terminal jobs live in-process |
| `~/.cell/usage/` | server JSONL usage log (auto-rotates at ~10 MB) |
| `~/.cell/storage.json` | S3-compatible endpoint for `cell save/load` snapshots |
| `~/.gitconfig` `[cell] corsproxy` | custom git CORS relay list (`off` disables) |
| `~/.cell/bot.json` | bot identity shared across surfaces (name + timezone) |
| `~/.cell/telegram.json` | Telegram allowlist only (`{"allowFrom": [<chat-id>]}`) — never a token; token lives in env or a file outside the workspace |
| `~/.cell/gmail.json` | Gmail connector config (client id/secret, allowlists, watched labels, drafts-only flag) — see `docs/connectors.md` |
