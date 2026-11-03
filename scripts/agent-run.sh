#!/usr/bin/env bash
set -euo pipefail

# agent-run.sh — one-shot headless agent run in a container.
# Usage: agent-run.sh "prompt" [--resume <id>] [--steps N] [--workspace <dir>] [--name <suffix>]
#
# Builds nothing; expects the image `cell-agent` (see README) and
# dist-server/ compiled via `pnpm server:build`. The container is removed
# on exit (--rm).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CELL_AGENT_IMAGE:-cell-agent}"

usage() {
  cat >&2 <<'EOF'
usage: agent-run.sh "prompt" [--resume <id>] [--steps N] [--workspace <dir>] [--name <suffix>]

  prompt            the task for the agent (required, first argument)
  --resume <id>     continue a session in ~/.cell/sessions/
  --steps N         step budget forwarded to run-once
  --workspace <dir> host dir mounted at /workspace (default: ./workspace)
  --name <suffix>   container name becomes cell-agent-<suffix> (default: run-<pid>)
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

if [ "$#" -eq 0 ]; then
  usage 1
fi
case "$1" in
  -h|--help) usage 0 ;;
  -*) echo "error: first argument must be the prompt string" >&2; usage 1 ;;
esac
PROMPT="$1"
shift

RESUME=""
STEPS=""
WORKSPACE="${CELL_WORKSPACE_HOST:-$PWD/workspace}"
NAME="run-$$"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --resume) RESUME="${2:-}"; [ -n "$RESUME" ] || usage 1; shift 2 ;;
    --steps) STEPS="${2:-}"; [ -n "$STEPS" ] || usage 1; shift 2 ;;
    --workspace) WORKSPACE="${2:-}"; [ -n "$WORKSPACE" ] || usage 1; shift 2 ;;
    --name) NAME="${2:-}"; [ -n "$NAME" ] || usage 1; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown argument '$1'" >&2; usage 1 ;;
  esac
done

mkdir -p "$WORKSPACE"
WORKSPACE_ABS="$(cd "$WORKSPACE" && pwd)"
CONTAINER="cell-agent-$NAME"

ENV_ARGS=()
for var in CELL_AGENT_KEY CELL_AGENT_LIVE_KEY CELL_PROVIDER CELL_MODEL CELL_BASE_URL; do
  if [ -n "${!var:-}" ]; then
    ENV_ARGS+=(-e "$var=${!var}")
  fi
done

RUN_ARGS=()
if [ -n "$RESUME" ]; then
  RUN_ARGS+=(--resume "$RESUME")
fi
if [ -n "$STEPS" ]; then
  RUN_ARGS+=(--steps "$STEPS")
fi

exec docker run --rm -i \
  --name "$CONTAINER" \
  --label "cell-agent=one-shot" \
  -v "$WORKSPACE_ABS:/workspace" \
  "${ENV_ARGS[@]}" \
  "$IMAGE" \
  node dist-server/server/run-once.js "$PROMPT" "${RUN_ARGS[@]}"
