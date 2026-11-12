#!/bin/bash
# The lockstep comparer over the batch (list5.txt in the folder of the traces): per trace <out>/<name>.log, .json
# (the first differences), .cov (the functions the game ran). Run from the traces' folder:
#   bash lockstep_batch.sh <out folder> [<bundle, default /tmp/claude-0/ct/pm_ls.mjs>] [<only traces matching>]
out=$1; pm=${2:-/tmp/claude-0/ct/pm_ls.mjs}; only=${3:-}
mkdir -p "$out"
while read -r path region end; do
  [ -z "$path" ] && continue
  [ -n "$only" ] && ! echo "$path" | grep -q "$only" && continue
  n=$(echo "$path" | tr '/' '_' | sed 's/\.msgt$//')
  [ -s "$out/$n.json" ] && continue
  # v3's setup for the trace first (tests/replay.ts: its retries), kept in <name>.opts
  [ -s "$out/$n.opts" ] || QUIET=1 OPTS_OUT="$out/$n.opts" timeout 7200 node "${V3REPLAY:-/tmp/claude-0/ct/v3replay.mjs}" "$path" 1000000 > "$out/$n.v3log" 2>&1
  LS_OPTS="$out/$n.opts" LOCKSTEP=1 LS_TOP=12 LS_JSON="$out/$n.json" LS_COV="$out/$n.cov" timeout 7200 node "$pm" auto "$path" "$end" > "$out/$n.log" 2>&1
  echo "$n $(grep -m1 '^LOCKSTEP FIRST' "$out/$n.log" | cut -c1-160)"
done < list5.txt
