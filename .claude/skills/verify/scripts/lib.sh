#!/usr/bin/env bash
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPTS/../../../.." && pwd)"
STAGE="${1:?usage: $(basename "$0") <stage> [args]}"
case "$STAGE" in
  prod | production) echo "refusing to drive stage $STAGE" >&2; exit 2 ;;
esac
RUN_DIR="${VERIFY_RUN_DIR:-/tmp/verify-jobs/$STAGE}"
mkdir -p "$RUN_DIR"

if command -v mise >/dev/null 2>&1; then
  NODE=(mise exec node@24.18.0 -- node)
  PNPM=(mise exec node@24.18.0 pnpm@11.3.0 -- pnpm)
else
  NODE=(node)
  PNPM=(pnpm)
fi

dev_pid() {
  [[ -f "$RUN_DIR/pid" ]] || return 1
  local pid
  pid="$(cat "$RUN_DIR/pid")"
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

tree_pids() {
  local child
  echo "$1"
  for child in $(pgrep -P "$1"); do
    tree_pids "$child"
  done
}

answers() {
  [[ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1")" == "200" ]]
}
