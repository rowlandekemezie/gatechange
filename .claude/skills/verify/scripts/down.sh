#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

if pid="$(dev_pid)"; then
  pids=($(tree_pids "$pid"))
  commands=()
  for p in "${pids[@]}"; do
    commands+=("$(ps -o command= -p "$p" 2>/dev/null || true)")
  done
  unchanged() {
    [[ -n "${commands[$1]}" && "$(ps -o command= -p "${pids[$1]}" 2>/dev/null || true)" == "${commands[$1]}" ]]
  }
  signal() {
    local i now
    for i in "${!pids[@]}"; do
      if unchanged "$i"; then
        kill "-$1" "${pids[$i]}" 2>/dev/null || true
      elif now="$(ps -o command= -p "${pids[$i]}" 2>/dev/null)"; then
        echo "pid ${pids[$i]} now runs '$now', not what it ran when listed; did not send it SIG$1"
      fi
    done
  }
  signal TERM
  for _ in $(seq 1 20); do
    alive=0
    for i in "${!pids[@]}"; do
      if unchanged "$i"; then alive=1; fi
    done
    ((alive)) || break
    sleep 0.5
  done
  signal KILL
  echo "stopped alchemy dev for stage $STAGE (pids ${pids[*]})"
elif [[ -f "$RUN_DIR/pid" ]]; then
  echo "pid $(cat "$RUN_DIR/pid") recorded for stage $STAGE is not its alchemy dev any more; signalled nothing"
else
  echo "no running alchemy dev recorded for stage $STAGE"
fi

alchemy() {
  (cd "$REPO" && DOCKER_CONFIG="$RUN_DIR/docker-config" "${PNPM[@]}" --silent alchemy "$@") 2>>"$RUN_DIR/destroy.log"
}

mkdir -p "$RUN_DIR/docker-config"
: >"$RUN_DIR/destroy.log"
if ! listed="$(alchemy state ls "JobBoard/$STAGE" --recursive)" &&
  ! grep -q "JobBoard/$STAGE: path does not exist" "$RUN_DIR/destroy.log"; then
  echo "could not read the state of stage $STAGE, so nothing was destroyed; see $RUN_DIR/destroy.log" >&2
  exit 1
fi
rows="$(grep -E "^JobBoard/$STAGE/" <<<"$listed" | grep -v "^JobBoard/$STAGE/output$" || true)"

for row in $rows; do
  if ! alchemy state read "$row" | "${NODE[@]}" "$SCRIPTS/local-only-state.ts" "$row"; then
    echo "refusing to destroy stage $STAGE: $row is not a local alchemy dev resource" >&2
    exit 1
  fi
done

if [[ -z "$rows" ]]; then
  echo "stage $STAGE has no resources in the Alchemy state; skipped alchemy destroy"
elif alchemy destroy --stage "$STAGE" --yes --no-input >>"$RUN_DIR/destroy.log"; then
  echo "destroyed the $(wc -l <<<"$rows" | tr -d ' ') local-mode resources of stage $STAGE and their state rows"
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
