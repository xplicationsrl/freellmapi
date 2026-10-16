#!/usr/bin/env bash
# Run by the GitHub Actions deploy over SSH (as the forced command of its key).
# stdin: the per-user JSON from the FREELLMAPI_USERS secret.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node22/bin:$PATH"

users_json="$(cat)"

cd "$ROOT"
git fetch --quiet origin main
git reset --quiet --hard origin/main
npm ci --no-audit --no-fund --loglevel=error
npm run build -w server --silent

printf '%s' "$users_json" | node deploy/provision.mjs
