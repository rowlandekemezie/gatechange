#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

if pid="$(dev_pid)" && [[ -f "$RUN_DIR/url" ]] && answers "$(cat "$RUN_DIR/url")"; then
  echo "reusing stage $STAGE (pid $pid) at $(cat "$RUN_DIR/url")"
  exit 0
fi

for other in /tmp/verify-jobs/*/pid; do
  [[ -f "$other" && "$other" != "$RUN_DIR/pid" ]] || continue
  if kill -0 "$(cat "$other")" 2>/dev/null && [[ "$(cat "$(dirname "$other")/repo" 2>/dev/null)" == "$REPO" ]]; then
    echo "stage $(basename "$(dirname "$other")") is already running in this checkout; run down.sh on it first" >&2
    exit 1
  fi
done

if ! (cd "$REPO" && "${PNPM[@]}" turbo run build --filter=@rat-stack/infra...) >"$RUN_DIR/build.log" 2>&1; then
  echo "building the workspace packages alchemy dev imports failed; see $RUN_DIR/build.log" >&2
  exit 1
fi

rm -f "$RUN_DIR/pid" "$RUN_DIR/url" "$RUN_DIR/backend-url"
echo "$REPO" >"$RUN_DIR/repo"
d1_before="$(d1_files)"
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
  if grep -q "alchemy dev: run failed" "$RUN_DIR/dev.log"; then
    echo "alchemy dev failed to plan the stack and is waiting for a file change; run down.sh $STAGE after reading:" >&2
    grep -A3 "run failed" "$RUN_DIR/dev.log" >&2
    exit 1
  fi
  if ((SECONDS > deadline)); then
    echo "alchemy dev did not print websiteUrl within the boot timeout; see $RUN_DIR/dev.log" >&2
    exit 1
  fi
  sleep 0.5
done

backend="$(grep -E '\[JobsBackend\] Started in' "$RUN_DIR/dev.log" | grep -oE 'http://localhost:[0-9]+' | tail -n 1)"
d1_new="$(comm -13 <(echo "$d1_before") <(d1_files) | grep . || true)"
if [[ -n "$d1_new" ]]; then
  d1="$d1_new"
elif [[ -f "$RUN_DIR/d1" && -f "$(cat "$RUN_DIR/d1")" ]]; then
  d1="$(cat "$RUN_DIR/d1")"
elif [[ "$(d1_files | wc -l | tr -d ' ')" == "1" ]]; then
  d1="$(d1_files)"
else
  echo "cannot tell which local D1 belongs to stage $STAGE; run down.sh on the old stages in this checkout, or use a new stage name" >&2
  exit 1
fi
if [[ "$(echo "$d1" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "stage $STAGE created more than one local D1: $d1" >&2
  exit 1
fi

echo "$url" >"$RUN_DIR/url"
echo "$backend" >"$RUN_DIR/backend-url"
echo "$d1" >"$RUN_DIR/d1"
grep -E 'Port [0-9]+ is in use' "$RUN_DIR/dev.log" | sed -E 's/^.*(Port [0-9]+ is in use[^;]*;[^.]*).*/note: \1/' || true
echo "stage $STAGE ready: Website $url, JobsBackend $backend (pid $pid, log $RUN_DIR/dev.log)"
