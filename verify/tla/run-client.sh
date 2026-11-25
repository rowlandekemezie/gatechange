#!/bin/sh
set -eu
status=0
here=$(cd "$(dirname "$0")" && pwd)
machine=$1
root=${2:-${TMPDIR:-/tmp}/statechart-client}
dir=$here/$machine
spec=$(ls "$dir"/*.tla | head -n 1)
name=$(basename "$spec" .tla)
out=$root/$machine-$(date +%s)
mkdir -p "$root"
statechart=${STATECHART:-$(ls -d "$HOME"/.claude/plugins/cache/pstack-claude/pstack/*/skills/statechart/scripts/statechart | tail -n 1)}
cd "$dir"
PATH="$(mise where node@24)/bin:$(mise where java)/bin:$PATH" "$statechart" "$name.tla" --config "$name.cfg" --view view.ts --out "$out" || status=$?
if [ -f "$out/chart.mmd" ]; then cp "$out/chart.mmd" "$dir/chart.mmd"; fi
echo "report: $out"
exit "$status"
