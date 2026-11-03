#!/usr/bin/env bash
# check-isolate-pure.sh — the machine-free gate.
#
# The agent core (shell, VFS, python, node runtime, skills) must run on
# nothing but V8: no static node: imports, no process.env/Deno/Bun, no
# Worker spawning (the loaders are the documented exceptions below).
# Anything that needs a machine lives in server/ or scripts/ and may
# never be imported by agent code. CI runs this; it fails the build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
flag() { echo "ISOLATE-GATE: $1"; fail=1; }

# 1. static node: imports (dynamic getBuiltinModule hints are allowed —
#    they degrade gracefully where there is no host)
if grep -rn --include="*.ts" -E "from ['\"]node:|require\(['\"]node:" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -vE "^[^:]+:[0-9]+:\s*//"; then
  flag "static node: import in isolate code (see above)"
fi

# 2. direct host-runtime references (globalThis-guarded hints are allowed)
if grep -rn --include="*.ts" -E "(^|[^a-zA-Z_.])process\.env|Deno\.|Bun\." src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -v "globalThis" | grep -vE "^[^:]+:[0-9]+:\s*//"; then
  flag "direct host-runtime reference in isolate code (see above)"
fi

# 3. Worker spawning: only the documented loaders may do it, and each
#    must carry an ISOLATE-GATE marker explaining the Workers path
if grep -rn --include="*.ts" "new Worker(" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' > /dev/null; then
  while IFS= read -r line; do
    file="${line%%:*}"
    if ! grep -q "ISOLATE-GATE" "$file"; then
      flag "unmarked Worker spawning in $file"
    fi
  done < <(grep -rln --include="*.ts" "new Worker(" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' || true)
fi

# 4. the seam itself: agent code must never import server/ or scripts/
if grep -rn --include="*.ts" -E "from ['\"]\.\./\.\./server/|from ['\"]\.\./scripts/|from ['\"]\.\./\.\./scripts/" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts'; then
  flag "agent code imports server/scripts (see above)"
fi

if [ "$fail" -ne 0 ]; then
  echo "ISOLATE-GATE: FAILED — agent core must stay machine-free (see docs/ISOLATE_SEAM.md)"
  exit 1
fi
echo "ISOLATE-GATE: PASS — agent core is machine-free"
