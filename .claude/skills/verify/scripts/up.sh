#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

if pid="$(dev_pid)" && [[ -f "$RUN_DIR/url" ]] && answers "$(cat "$RUN_DIR/url")"; then
  echo "reusing stage $STAGE (pid $pid) at $(cat "$RUN_DIR/url")"
  exit 0
fi

rm -f "$RUN_DIR/pid" "$RUN_DIR/url" "$RUN_DIR/backend-url"
set -m
(cd "$REPO" && exec "${PNPM[@]}" dev --stage "$STAGE" --no-input) >"$RUN_DIR/dev.log" 2>&1 &
pid=$!
set +m
echo "$pid" >"$RUN_DIR/pid"

deadline=$((SECONDS + ${VERIFY_BOOT_TIMEOUT:-150}))
until url="$(grep -oE "websiteUrl: 'http://localhost:[0-9]+'" "$RUN_DIR/dev.log" | grep -oE 'http://localhost:[0-9]+')"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "alchemy dev exited before the Website was ready. Last log lines:" >&2
    tail -n 20 "$RUN_DIR/dev.log" >&2
    exit 1
  fi
  if ((SECONDS > deadline)); then
    echo "alchemy dev did not print websiteUrl within the boot timeout; see $RUN_DIR/dev.log" >&2
    exit 1
  fi
  sleep 0.5
done

backend="$(grep -E '\[JobsBackend\] Started in' "$RUN_DIR/dev.log" | grep -oE 'http://localhost:[0-9]+' | tail -n 1)"
echo "$url" >"$RUN_DIR/url"
echo "$backend" >"$RUN_DIR/backend-url"
grep -E 'Port [0-9]+ is in use' "$RUN_DIR/dev.log" | sed -E 's/^.*(Port [0-9]+ is in use[^;]*;[^.]*).*/note: \1/' || true
echo "stage $STAGE ready: Website $url, JobsBackend $backend (pid $pid, log $RUN_DIR/dev.log)"
