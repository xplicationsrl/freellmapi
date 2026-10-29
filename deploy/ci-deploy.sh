#!/usr/bin/env bash
# Run by the GitHub Actions deploy over SSH (as the forced command of its key).
# stdin: the per-user JSON from the FREELLMAPI_USERS secret.
set -euo pipefail

# Wrapped in a function so bash parses the whole script before running it:
# the `git reset` below rewrites this very file, and bash otherwise keeps
# reading the new contents from the old byte offset.
main() {
  local ROOT
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  export PATH="$HOME/.local/node22/bin:$PATH"

  local users_json
  users_json="$(cat)"

  cd "$ROOT"
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  npm ci --no-audit --no-fund --loglevel=error
  npm run build -w server --silent
  # The server serves client/dist itself (server/src/app.ts), so the dashboard
  # ships from the same origin as the API.
  npm run build -w client --silent

  printf '%s' "$users_json" | node deploy/provision.mjs
}

main "$@"
