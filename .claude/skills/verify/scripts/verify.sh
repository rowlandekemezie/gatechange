#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
shift

started=$(date +%s)
OUT="${VERIFY_OUT:-$RUN_DIR/shots}"

"$SCRIPTS/up.sh" "$STAGE"
"$SCRIPTS/seed.sh" "$STAGE"
"$SCRIPTS/doctor.sh" "$STAGE"

drive_status=0
"${NODE[@]}" "$SCRIPTS/drive.ts" --url "$(cat "$RUN_DIR/url")" --out "$OUT" "$@" || drive_status=$?
elapsed=$(($(date +%s) - started))

if ! dev_pid >/dev/null; then
  echo "FAIL alchemy dev for stage $STAGE exited during the run; see $RUN_DIR/dev.log" >&2
  exit 1
fi
if ((drive_status != 0)); then
  echo "FAIL drive exited $drive_status after ${elapsed}s; failure screenshot in $OUT" >&2
  exit "$drive_status"
fi
echo "PASS in ${elapsed}s from start to screenshot; evidence in $OUT"
