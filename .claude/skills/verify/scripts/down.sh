#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

if pid="$(dev_pid)"; then
  pids=$(tree_pids "$pid")
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    alive=$(for p in $pids; do if kill -0 "$p" 2>/dev/null; then echo "$p"; fi; done)
    [[ -z "$alive" ]] && break
    sleep 0.5
  done
  [[ -n "${alive:-}" ]] && kill -KILL $alive 2>/dev/null || true
  echo "stopped alchemy dev for stage $STAGE (pids $(echo $pids))"
else
  echo "no running alchemy dev recorded for stage $STAGE"
fi

if (cd "$REPO" && "${PNPM[@]}" alchemy destroy --stage "$STAGE" --no-input --yes) >"$RUN_DIR/destroy.log" 2>&1; then
  echo "destroyed the local resources and state of stage $STAGE"
else
  echo "alchemy destroy failed for stage $STAGE; see $RUN_DIR/destroy.log" >&2
  exit 1
fi

if [[ -f "$RUN_DIR/d1" ]]; then
  d1="$(cat "$RUN_DIR/d1")"
  rm -f "$d1" "$d1-wal" "$d1-shm"
  echo "removed the stage's local D1 file $(basename "$d1")"
fi

rm -f "$RUN_DIR/pid" "$RUN_DIR/url" "$RUN_DIR/backend-url" "$RUN_DIR/d1" "$RUN_DIR/repo"
echo "evidence kept in ${VERIFY_OUT:-$RUN_DIR/shots}"
