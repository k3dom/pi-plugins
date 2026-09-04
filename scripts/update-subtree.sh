#!/usr/bin/env bash
# Interactively select registered subtrees and pull their registered ref.
#
# Usage:
#   scripts/update-subtree.sh         # interactive (fzf multi-select)
#   scripts/update-subtree.sh --all   # pull every registered subtree

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

registry=".agents/repos/.subtrees"
if [[ ! -f "$registry" ]]; then
  echo "error: registry not found at $registry" >&2
  exit 1
fi

if ! git diff-index --quiet HEAD --; then
  echo "error: working tree has uncommitted changes — commit or stash first" >&2
  exit 1
fi

entries="$(grep -v '^[[:space:]]*#' "$registry" | grep -v '^[[:space:]]*$' || true)"
if [[ -z "$entries" ]]; then
  echo "no subtrees registered" >&2
  exit 0
fi

if [[ "${1:-}" == "--all" ]]; then
  selection="$entries"
else
  if ! command -v fzf >/dev/null 2>&1; then
    echo "error: fzf is required for interactive mode — use --all to pull everything" >&2
    exit 1
  fi
  selection="$(printf '%s\n' "$entries" | fzf \
    --multi \
    --delimiter=$'\t' \
    --with-nth=1 \
    --prompt='subtrees to pull> ' \
    --header='TAB to multi-select, ENTER to confirm, ESC to cancel' \
    --preview='printf "url: %s\nref: %s\n" {2} {3}' \
    --preview-window=down:3:wrap)"
fi

if [[ -z "$selection" ]]; then
  echo "nothing selected" >&2
  exit 0
fi

fail=0
while IFS=$'\t' read -r prefix url ref; do
  [[ -z "$prefix" ]] && continue
  echo
  echo ">> pulling $prefix from $url ($ref)"
  if git subtree pull --prefix="$prefix" "$url" "$ref" --squash; then
    echo ">> ok: $prefix"
  else
    echo ">> FAILED: $prefix" >&2
    fail=1
  fi
done <<< "$selection"

exit "$fail"
