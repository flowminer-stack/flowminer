#!/usr/bin/env bash
# init-env.sh — generate a fresh .env for FlowMiner with strong secrets.
#
# Run from anywhere — the script resolves the repo root from its own
# location. The four mandatory secrets are filled in with cryptographically
# strong values:
#
#   * SECRET_KEY              — openssl rand -hex 32   (256 bits)
#   * POSTGRES_PASSWORD       — openssl rand -hex 16   (128 bits)
#   * REDIS_PASSWORD          — openssl rand -hex 16   (128 bits)
#   * FLOWMINER_ENCRYPTION_KEY — Fernet key (32 random bytes,
#                                URL-safe base64-encoded)
#
# Refuses to overwrite an existing .env unless --force is passed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
TEMPLATE="${REPO_ROOT}/.env.example"

force=false
for arg in "$@"; do
    case "$arg" in
        -f|--force) force=true ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [-f|--force]

Copies .env.example to .env and fills in the four required secret
fields with strong values. Refuses to overwrite an existing .env
unless --force is passed.

  -f, --force   Overwrite an existing .env (the existing file is
                backed up to .env.bak first).
  -h, --help    Show this message.
EOF
            exit 0 ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 2 ;;
    esac
done

if [[ ! -f "$TEMPLATE" ]]; then
    echo "ERROR: $TEMPLATE not found." >&2
    exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
    if [[ "$force" != "true" ]]; then
        echo "ERROR: $ENV_FILE already exists. Pass --force to overwrite." >&2
        exit 1
    fi
    cp "$ENV_FILE" "${ENV_FILE}.bak"
    echo "Existing $ENV_FILE backed up to ${ENV_FILE}.bak"
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl is required but not on PATH." >&2
    exit 1
fi

cp "$TEMPLATE" "$ENV_FILE"

secret_key=$(openssl rand -hex 32)
postgres_password=$(openssl rand -hex 16)
redis_password=$(openssl rand -hex 16)
# A Fernet key is exactly 32 random bytes encoded with URL-safe
# base64 ('+'->'-', '/'->'_'), keeping the trailing '=' padding.
fernet_key=$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '\n')

# In-place edits — '|' as the sed delimiter avoids any chance of
# colliding with characters in the generated values. We only
# overwrite the empty REQUIRED-secret lines from the template; every
# other configurable (LLM provider, SMTP, CORS) is left at the
# template default for the operator to fill in by hand.
sed -i.tmp \
    -e "s|^SECRET_KEY=.*|SECRET_KEY=${secret_key}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${redis_password}|" \
    -e "s|^FLOWMINER_ENCRYPTION_KEY=.*|FLOWMINER_ENCRYPTION_KEY=${fernet_key}|" \
    "$ENV_FILE"
rm -f "${ENV_FILE}.tmp"

chmod 600 "$ENV_FILE"

cat <<EOF
Wrote $ENV_FILE with fresh secrets (mode 600).

Next:
  docker compose -f docker-compose.yml -f docker-compose.localhost.yml up -d
  open http://localhost:3000

The first user you register will be promoted to admin automatically.
EOF
