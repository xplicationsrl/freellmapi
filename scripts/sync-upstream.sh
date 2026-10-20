#!/usr/bin/env bash
# Merge the upstream project (new providers, fixes, releases) into the current
# branch. Never leaves a half-finished merge behind.
#
# Fork-safe: where upstream and this fork edited the same lines, the fork's
# version is kept (merge -X ours), so local edits are never overwritten. Upstream
# changes elsewhere are applied. Only structural conflicts (e.g. one side deleted
# a file the other edited) stop the sync. Set SYNC_PREFER=none for a plain merge.
#
# Prints key=value lines (also appended to $GITHUB_OUTPUT when set):
#   result=uptodate | merged | conflict
#   behind=<commits merged or pending>
#   files=<comma-separated conflicting paths>   (conflict only)
#
# Env: UPSTREAM_URL (default tashfeenahmed/freellmapi), UPSTREAM_BRANCH (default main),
#      SYNC_PREFER (ours | none, default ours).
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/tashfeenahmed/freellmapi.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
SYNC_PREFER="${SYNC_PREFER:-ours}"
STRATEGY=()
if [ "$SYNC_PREFER" = "ours" ]; then STRATEGY=(-X ours); fi

emit() {
  echo "$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi
}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "refusing to sync: working tree has uncommitted changes" >&2
  exit 1
fi

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch --quiet upstream "$UPSTREAM_BRANCH"
REF="FETCH_HEAD"
git rev-parse --verify --quiet "$REF" >/dev/null

if git merge-base --is-ancestor "$REF" HEAD; then
  emit "result=uptodate"
  emit "behind=0"
  exit 0
fi

BEHIND="$(git rev-list --count "HEAD..$REF")"
if git merge --no-ff --no-edit ${STRATEGY[@]+"${STRATEGY[@]}"} -m "chore(sync): merge upstream $UPSTREAM_BRANCH ($BEHIND commits)" "$REF" >/dev/null 2>&1; then
  emit "result=merged"
  emit "behind=$BEHIND"
  exit 0
fi

FILES="$(git diff --name-only --diff-filter=U | paste -sd, -)"
git merge --abort
emit "result=conflict"
emit "behind=$BEHIND"
emit "files=$FILES"
