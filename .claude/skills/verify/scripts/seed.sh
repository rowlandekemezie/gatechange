#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

dev_pid >/dev/null || { echo "stage $STAGE is not running; run up.sh $STAGE first" >&2; exit 1; }
"${NODE[@]}" "$SCRIPTS/seed-local-d1.ts" --db "$(cat "$RUN_DIR/d1")"
