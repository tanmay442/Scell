#!/usr/bin/env bash
set -euo pipefail

# agent-server.sh — long-running headless agent server in a container.
# Usage: agent-server.sh [--workspace <dir>] [--port <n>] [--name <name>]
#
# Expects the image `cell-agent` (see README) and dist-server/ compiled
# via `pnpm server:build`. Runs detached with `--restart unless-stopped`.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CELL_AGENT_IMAGE:-cell-agent}"

usage() {
  cat >&2 <<'EOF'
usage: agent-server.sh [--workspace <dir>] [--port <n>] [--name <name>]

  --workspace <dir> host dir mounted at /workspace (default: ./workspace)
  --port <n>        host port mapped to the container's 8787 (default: 8787)
  --name <name>     container name (default: cell-agent-server)
EOF
  exit "${1:-1}"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found — install docker to run the agent container" >&2
  exit 1
fi
if [ ! -d "$ROOT/dist-server" ]; then
  echo "error: dist-server/ not found — run \`pnpm server:build\` first" >&2
  exit 1
fi

WORKSPACE="${CELL_WORKSPACE_HOST:-$PWD/workspace}"
PORT="${CELL_PORT_HOST:-8787}"
NAME="cell-agent-server"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="${2:-}"; [ -n "$WORKSPACE" ] || usage 1; shift 2 ;;
    --port) PORT="${2:-}"; [ -n "$PORT" ] || usage 1; shift 2 ;;
    --name) NAME="${2:-}"; [ -n "$NAME" ] || usage 1; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown argument '$1'" >&2; usage 1 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "error: --port must be a number (got '$PORT')" >&2; exit 1 ;;
esac

mkdir -p "$WORKSPACE"
WORKSPACE_ABS="$(cd "$WORKSPACE" && pwd)"

ENV_ARGS=()
for var in CELL_AGENT_KEY CELL_AGENT_LIVE_KEY CELL_PROVIDER CELL_MODEL CELL_BASE_URL CELL_API_TOKENS CELL_RATE_MAX CELL_RATE_WINDOW_MS CELL_USAGE_DIR CELL_TIMEOUT_MS CELL_JOBS_INTERVAL_MS CELL_RESUME_ON_BOOT CELL_SNAPSHOTS_DIR CELL_S3_ENDPOINT CELL_S3_REGION CELL_S3_BUCKET CELL_S3_ACCESS_KEY CELL_S3_SECRET_KEY CELL_S3_PREFIX CELL_TELEGRAM CELL_TELEGRAM_TOKEN CELL_TELEGRAM_ALLOW_FROM; do
  if [ -n "${!var:-}" ]; then
    ENV_ARGS+=(-e "$var=${!var}")
  fi
done

docker run -d \
  --restart unless-stopped \
  --name "$NAME" \
  --label "cell-agent=server" \
  -p "$PORT:8787" \
  -v "$WORKSPACE_ABS:/workspace" \
  -e CELL_PORT=8787 \
  "${ENV_ARGS[@]}" \
  "$IMAGE" >/dev/null

echo "agent server: $NAME listening on http://localhost:$PORT/health"
echo "logs: docker logs -f $NAME"
echo "stop: docker stop $NAME"
