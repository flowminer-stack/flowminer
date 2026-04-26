#!/usr/bin/env bash
# wait-ready.sh — block until the FlowMiner stack is reachable.
#
# Polls the SPA (which proxies /api to the backend) for /health/ready.
# Exits 0 when the stack reports DB + Redis healthy, non-zero on
# timeout. Designed for use right after `docker compose up -d` so a
# new operator doesn't have to keep poking `docker compose ps`.

set -euo pipefail

PORT="${FLOWMINER_FRONTEND_PORT:-3000}"
HOST="${FLOWMINER_HOST:-localhost}"
# /health/ready is exposed by the SPA's nginx (which proxies /api to
# the backend) — same hostname/port the user opens in the browser,
# so a successful poll means the operator's whole quick-start path
# is reachable.
URL="http://${HOST}:${PORT}/health/ready"
TIMEOUT="${TIMEOUT:-180}"

if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required but not on PATH." >&2
    exit 1
fi

echo "Waiting for FlowMiner at ${URL} (timeout ${TIMEOUT}s)..."
deadline=$(( $(date +%s) + TIMEOUT ))
attempt=0

while true; do
    attempt=$(( attempt + 1 ))
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$URL" || true)
    if [[ "$code" == "200" ]]; then
        echo
        echo "Ready. FlowMiner is up at http://${HOST}:${PORT}"
        exit 0
    fi
    if (( $(date +%s) >= deadline )); then
        echo
        echo "ERROR: timed out after ${TIMEOUT}s waiting for ${URL}" >&2
        echo "Last HTTP status: ${code}" >&2
        echo "Inspect: docker compose logs backend" >&2
        exit 1
    fi
    # Single-line spinner: rewrite the same line each tick.
    printf "\r  attempt %d (HTTP %s) ..." "$attempt" "${code:-000}"
    sleep 2
done
