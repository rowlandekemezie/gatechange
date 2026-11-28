#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=${1:-$here/../out/run-$(date +%Y%m%d-%H%M%S)}
statechart=${STATECHART:-$(ls -d "$HOME"/.claude/plugins/cache/pstack-claude/pstack/*/skills/statechart/scripts/statechart | tail -n 1)}
mkdir -p "$root"
for dir in "$here"/*/; do
  machine=$(basename "$dir")
  spec=$(ls "$dir"*.tla 2>/dev/null | head -n 1)
  [ -n "$spec" ] || continue
  name=$(basename "$spec" .tla)
  view=view.ts
  [ -f "$dir/view.ts" ] || view=view.mjs
  log=$root/$machine.log
  (cd "$dir" && PATH="$(mise where node@24)/bin:$(mise where java)/bin:$PATH" "$statechart" "$name.tla" --config "$name.cfg" --view "$view" --out "$root/$machine" >"$log" 2>&1) || true
  states=$(grep -m 1 -oE "TLC reached [0-9,]+ states" "$log" | grep -oE "[0-9,]+" || echo "?")
  broken=$(sed -n 's/^## \(.*\) breaks$/\1/p' "$log" | paste -sd, -)
  held=$(sed -n '/^## Rules that hold$/{n;p;}' "$log")
  if [ -z "$broken$held" ]; then
    printf '%-26s no result, see %s\n' "$machine" "$log"
  else
    printf '%-26s %6s states  breaks: %s  holds: %s\n' "$machine" "$states" "${broken:-none}" "$held"
  fi
done
echo "logs and charts: $root"
