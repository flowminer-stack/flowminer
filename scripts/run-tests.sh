#!/usr/bin/env bash
#
# Regression gate — run after making changes to catch regressions.
#
#   ./scripts/run-tests.sh            # backend tests + frontend typecheck + build
#   ./scripts/run-tests.sh --quick    # skip the (slower) frontend vite build
#
# Backend: pytest (uses backend/venv if present, else python3).
# Frontend: tsc --noEmit (type regressions) + vite build (build regressions).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1
fail=0

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ── Backend ──────────────────────────────────────────────────────────────────
hr "Backend tests (pytest)"
if [ -x "$ROOT/backend/venv/bin/python" ]; then
  PY="$ROOT/backend/venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  PY="python"
fi
( cd "$ROOT/backend" && "$PY" -m pytest tests/ -q -W ignore ) || fail=1

# ── Frontend typecheck ───────────────────────────────────────────────────────
hr "Frontend typecheck (tsc --noEmit)"
if command -v npx >/dev/null 2>&1; then
  ( cd "$ROOT/frontend" && npx tsc --noEmit ) || fail=1
else
  echo "SKIP: npx not found"
fi

# ── Frontend build ───────────────────────────────────────────────────────────
if [ "$QUICK" -eq 0 ]; then
  hr "Frontend build (vite)"
  if command -v npm >/dev/null 2>&1; then
    ( cd "$ROOT/frontend" && npm run build ) || fail=1
  else
    echo "SKIP: npm not found"
  fi
fi

echo
if [ "$fail" -ne 0 ]; then
  printf '\033[31m✗ Regression gate FAILED\033[0m\n'
  exit 1
fi
printf '\033[32m✓ All checks passed\033[0m\n'
