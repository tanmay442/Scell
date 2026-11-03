# Gateway wiring

Wraps the existing request handler in `server/server.ts` with auth,
rate limiting, and usage logging. This is a paste-in snippet for a
follow-up edit to `server.ts` — no existing file was changed to add
the gateway itself.

## Snippet

Add the imports alongside the existing `node:http` import:

```ts
import { join } from 'node:path'
import { loadTokens } from './auth'
import { createRateLimiter } from './ratelimit'
import { withGateway } from './gateway'
```

After `root` / `vfs` are defined (the gateway default usage dir lives
under the workspace), add:

```ts
const tokens = loadTokens() // throws at startup on malformed CELL_API_TOKENS
const limiter = createRateLimiter({
  max: Number(process.env.CELL_RATE_MAX || '60') || 60,
  windowMs: Number(process.env.CELL_RATE_WINDOW_MS || '60000') || 60000,
})
const usageDir = process.env.CELL_USAGE_DIR || join(root, '.cell', 'usage')

const handleWithGateway = withGateway(
  async (req, res) => {
    await handle(req, res)
  },
  {
    tokens,
    limiter,
    usageDir,
    usageModel: (body) => {
      if (
        body !== null &&
        typeof body === 'object' &&
        typeof (body as { model?: unknown }).model === 'string'
      ) {
        return (body as { model: string }).model
      }
      return process.env.CELL_MODEL || 'default'
    },
  },
)
```

Then point the server at it — replace `handle(req, res)` with
`handleWithGateway(req, res)` in the `createServer` callback:

```ts
const server = createServer((req, res) => {
  handleWithGateway(req, res).catch(() => {
    // ... existing 500 handling unchanged
  })
})
```

## Env vars

- `CELL_API_TOKENS` — `id1:token1,id2:token2`. Empty/unset = auth
  disabled (open, single-user mode; usage rows record `tokenId:
  "local"`). Only run open mode bound to localhost.
- `CELL_RATE_MAX` — max requests per window per token id (default `60`).
- `CELL_RATE_WINDOW_MS` — window length in ms (default `60000`).
- `CELL_USAGE_DIR` — where `usage.jsonl` is appended (default
  `<workspace>/.cell/usage`).

## Notes

- `GET /health` passes through with no auth and writes no usage row.
- `maxBodyBytes` (default 4MB) caps buffered request bodies with `413 {error:'body too large'}`; pass `CELL_PORT`-style env through in the server wiring.
  Everything else needs `Authorization: Bearer <token>` (401
  `{error:'unauthorized'}`) and is rate-limited per token id (429
  `{error:'rate limited', retryAfterMs}`).
- The gateway buffers the request body to compute `promptChars` and
  `model`, then replays it to the inner handler via async iteration.
  This works with `readBody`'s `for await` loop in `server.ts`; an
  inner handler that reads the body another way would see an empty
  stream.
- Usage rows default to `{steps:-1, exitCode:-1}` because `handleRun`
  does not report stats yet. To record real values, a later edit can
  thread the gateway `ctx` into `handle`/`handleRun` and call
  `ctx.report({ steps, exitCode })` when the run finishes.
- Behind the gateway, `/run` should also receive the token id
  (`ctx.tokenId`, available on the inner handler's third argument) so
  per-user workspaces can be keyed off it later.
