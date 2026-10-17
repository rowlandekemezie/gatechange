#!/usr/bin/env bash
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPTS/../../../.." && pwd)"
STAGE="${1:?usage: $(basename "$0") verify-<name> [args]}"

refuse_stage() {
  echo "refusing stage '$STAGE': $1" >&2
  exit 2
}

[[ "$STAGE" =~ ^verify-[a-z0-9][a-z0-9-]*$ ]] ||
  refuse_stage "verify stages are named verify-<lowercase letters, digits and dashes>"
shopt -s nocasematch
if [[ "$STAGE" =~ prod|staging ]]; then
  refuse_stage "the name looks like a deployed stage"
fi
shopt -u nocasematch

RUN_ROOT=/tmp/verify-jobs
RUN_DIR="$RUN_ROOT/$STAGE"
mkdir -p "$RUN_DIR"

if command -v mise >/dev/null 2>&1; then
  NODE=(mise exec node@24.18.0 -- node)
  PNPM=(mise exec node@24.18.0 pnpm@11.3.0 -- pnpm)
else
  NODE=(node)
  PNPM=(pnpm)
fi

stage_pid() {
  local pid command
  pid="$(cat "$1/pid" 2>/dev/null)" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ "$command" == *"alchemy dev --stage $2 --no-input"* ]] || return 1
  echo "$pid"
}

dev_pid() {
  stage_pid "$RUN_DIR" "$STAGE"
}

D1_DIR="$REPO/apps/infra/.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject"

d1_files() {
  ls "$D1_DIR" 2>/dev/null | grep -E '^[0-9a-f]{64}\.sqlite$' | sed "s|^|$D1_DIR/|" || true
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
