# Connectors — Telegram, Gmail, and the tool port

Threads are separate workspaces, but the assistant is one continuous bot:
the same identity (`~/.cell/bot.json`: name + timezone), the same durable
memory, the same skill index — in web chat, Telegram, and headless runs.

- `history_search` finds anything across all past threads (decisions, old errors, prior attempts) — search before redoing work.
- `memory_save` / `memory_list` keep lasting user-stated facts (preferences, timezone) across sessions. How-tos belong in skills, project records in project files, short-lived facts stay in-session.
- `delegate` hands a self-contained sub-task to a subagent with a fresh context window (same tools, same thread scope, 12-step cap, one level only — subagents cannot write shared memory or install skills — they report back, the parent decides).
- `background_task` hands long work to a background worker thread and keeps the chat responsive: the worker runs with the full toolset in its own thread and reports back with results + deliverables when done (Telegram: loud push to the chat plus a transcript note in the origin thread; failures report back too, never silence).
- `remind` promises a follow-up (`in 20m` / `in 2h` / ISO, max 7 days out). One-shot and delete-on-delivery. The server delivers due reminders back to the bound chat.
- `skill_install` teaches the bot a new skill from a URL or pasted markdown (`~/.cell/skills/<name>/SKILL.md`) — only on the user's explicit request.

## Custom tools — the port adapter

Anything scriptable becomes an agent tool. Drop JSON into `~/.cell/tools/`:

```json
{
  "name": "deploy",
  "description": "Deploy the current build",
  "parameters": { "target": { "type": "string" } },
  "run": { "kind": "bash", "command": "deploy.sh {{target}}" }
}
```

Skills (`~/.cell/skills/<name>/SKILL.md`) and slash commands (`~/.cell/commands/*.md`, e.g. `/commit`, `/preview`) extend the same way. Project overrides at `<project>/.cell/skills/` win over user skills.

This is the port other tools plug into: if your agent system exposes a CLI, webhook, or script, wrap it as a custom tool and Scell calls it like a native tool.

## Telegram trigger

`CELL_TELEGRAM=1` starts a long-poll loop next to the server: DMs only,
one stable thread per chat (`tg-<chatId>`). The main thread is a triage
loop (12 steps): quick answers inline, bigger work goes to
`background_task` workers that report back with results + files — the
chat stays responsive throughout, and messages arriving mid-task queue
(positioned, max 5, in order) instead of dying busy; queued turns run
after the current one finishes. Photos and documents (PDFs, files,
up to 12 MB) download into the thread's `uploads/` and ride the first
model turn — images go to the model as vision input, documents as staged files for tools. Anything the run
creates or updates in the thread comes back to the chat (photos for
images, documents for the rest, newest 5, 45 MB cap each).

Commands: `/new` starts a fresh thread, `/status` shows the live turn plus this
thread's jobs and workers, `/brief` writes a catch-up brief, `/reminders` lists pending
follow-ups, `/forget <n>` cancels one, `/cancel`, `/help`. Unknown `/commands` reach the
model as plain chat text.

```sh
CELL_TELEGRAM=1 CELL_TELEGRAM_TOKEN=<botfather-token> \
  CELL_TELEGRAM_ALLOW_FROM=<your-chat-id> \
  ./scripts/agent-server.sh --workspace ./workspace --port 8787
```

Security posture (asserted by `server/telegram.test.ts`): the token comes from `CELL_TELEGRAM_TOKEN` or a token file outside the workspace (`CELL_TELEGRAM_TOKEN_FILE` — refused when inside it), never from a workspace file. The server scrubs the token from its environment after boot and refuses `/proc` and `/sys` to agent bash. `~/.cell/telegram.json` holds only the non-secret allowlist (`{"allowFrom": [<chat-id>]}`); a `botToken` inside it fails closed. An empty allowlist fails closed — the poller refuses to start; strangers get silence (no model call, no reply — group/channel messages are dropped too). Single-operator assumption: every allowlisted chat shares one workspace, one memory, and one searchable history. Keep the allowlist to one operator (or their own devices) unless that sharing is intended.

| Env var | Purpose | Default |
|---|---|---|
| `CELL_TELEGRAM` | `1` enables the Telegram poll loop | off |
| `CELL_TELEGRAM_TOKEN` | Bot API token (never logged, never committed) | — |
| `CELL_TELEGRAM_TOKEN_FILE` | path to a file holding the token — must be outside the workspace (0600 file in a 0700 dir) | — |
| `CELL_TELEGRAM_ALLOW_FROM` | comma-separated chat ids (or `allowFrom` in `~/.cell/telegram.json`) | empty = poller refuses to start |

## Gmail watcher

The Gmail connector lets the agent watch and act on email:

- `gmail_search` — search with Gmail query syntax (`from:boss subject:invoice newer_than:7d`), returns matching ids.
- `gmail_read` — read one message body by id (plain-text preferred).
- `gmail_draft` — stage a draft (to, subject, body) without sending; returns a draft id plus the exact text for review.
- `gmail_send` — send a previously created draft by id, only after the user approved that draft text and only to allowlisted recipients.

Sending is structural: there is no send-raw-text tool, drafts-only mode is the default, and every recipient (To/Cc/Bcc) is checked against the allowlist. Message bodies are treated as untrusted data — the agent never follows instructions found inside them. Config lives in `~/.cell/gmail.json` (watched labels default to `INBOX`); OAuth tokens stay outside the workspace. See `src/shell/commands/agent-gmail.ts` and `agent-gmail.test.ts` for the exact boundaries.
