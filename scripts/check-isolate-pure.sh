#!/usr/bin/env bash
# check-isolate-pure.sh — the machine-free gate.
#
# The agent core (shell, VFS, python, node runtime, skills) must run on
# nothing but V8: no node: imports (static or dynamic), no bare builtin
# specifiers, no host globals, no Worker spawning outside the two
# documented loaders, and no imports reaching into server/ or scripts/.
# Anything that needs a machine lives in server/ or scripts/ and may
# never be imported by agent code. CI runs this; it fails the build.
#
# Known limits (documented, not checkable with grep): eval/Function
# laundering, worker-alias indirection (`new o()`), whitespace-obfuscated
# member access (`process .env`), dynamic import variables. Reviews must
# eyeball for these; the gate catches the direct spellings.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
flag() { echo "ISOLATE-GATE: $1"; fail=1; }

# Sanctioned single site (ISOLATE-ALLOW marker): agent.ts hostMetaKey reads
# a dev-machine key through a dynamic, guarded hint — never required.
ALLOW_RE='ISOLATE-ALLOW'

# 1. node: imports — static, dynamic, and bare builtin specifiers
if grep -rn --include="*.ts" -E "from ['\"](node:|fs(['\"/]|$)|path(['\"/]|$)|os(['\"/]|$))|require\(['\"](node:|fs(['\"/]|$)|path(['\"/]|$)|os(['\"/]|$))|import\(['\"]node:" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -vE "^[^:]+:[0-9]+:\s*//" | grep -v "$ALLOW_RE"; then
  flag "node: import in isolate code (see above)"
fi

# 2. host globals — optional chaining, bracket access, and qualified forms
if grep -rn --include="*.ts" -E "(^|[^a-zA-Z0-9_$])process(\?\.[ \t]*env|\.env|\[['\"]env['\"]\])|Deno(\.|\[)|Bun(\.|\[)" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -vE "^[^:]+:[0-9]+:\s*//" | grep -v "$ALLOW_RE"; then
  flag "host global in isolate code (see above)"
fi

# 3. Worker spawning — every spelling except alias indirection (documented
# residual). Each real site needs an ISOLATE-GATE marker explaining the
# Workers path; unmarked sites fail.
if grep -rn --include="*.ts" -E "new[[:space:]]*(\(Worker\)|globalThis\.Worker|self\.Worker|Worker)[[:space:]]*\(" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -vE "^[^:]+:[0-9]+:\s*//" > /dev/null; then
  while IFS= read -r line; do
    file="${line%%:*}"
    if ! grep -q "ISOLATE-GATE" "$file"; then
      flag "unmarked Worker spawning in $file"
    fi
  done < <(grep -rln --include="*.ts" -E "new[[:space:]]*(\(Worker\)|globalThis\.Worker|self\.Worker|Worker)[[:space:]]*\(" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' || true)
fi

# 4. the seam itself: agent code must never import server/ or scripts/
if grep -rn --include="*.ts" -E "from ['\"]\.\./\.\./server/|from ['\"]\.\./scripts/|from ['\"]\.\./\.\./scripts/|import\(['\"]\.\./" src/shell src/vfs src/python src/node 2>/dev/null | grep -v '\.test\.ts' | grep -vE "^[^:]+:[0-9]+:\s*//" | grep -v "$ALLOW_RE"; then
  flag "agent code imports server/scripts or dynamic parent import (see above)"
fi

# 5. test files are trusted by name only — verify the trust: any *.test.ts
# with a node: import must also import from vitest (real tests always do)
bad_tests="$(grep -rln --include="*.test.ts" -E "from ['\"]node:|require\(['\"]node:" src/shell src/vfs src/python src/node 2>/dev/null | while IFS= read -r f; do grep -L "from 'vitest'" "$f"; done || true)"
if [ -n "$bad_tests" ]; then
  echo "$bad_tests"
  flag "test file with node: import but no vitest import (see above)"
fi

if [ "$fail" -ne 0 ]; then
  echo "ISOLATE-GATE: FAILED — agent core must stay machine-free (see docs/ISOLATE_SEAM.md)"
  exit 1
fi
echo "ISOLATE-GATE: PASS — agent core is machine-free"
