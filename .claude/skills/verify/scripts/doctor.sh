#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

status=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; status=1; fi
}

pid="$(dev_pid || true)"
url="$(cat "$RUN_DIR/url" 2>/dev/null || true)"
port="${url##*:}"

check "alchemy dev for stage $STAGE is running (pid ${pid:-none})" '[[ -n "$pid" ]]'
check "Website answers 200 at ${url:-unknown}" '[[ -n "$url" ]] && answers "$url"'
check "port ${port:-unknown} is held by a process this stage started" \
  '[[ -n "$pid" && -n "$port" ]] && lsof -nP -a -p "$(tree_pids "$pid" | paste -sd, -)" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1'
check "local D1 holds every fixture job" '"${NODE[@]}" "$SCRIPTS/seed-local-d1.ts" --check >/dev/null'
exit "$status"
