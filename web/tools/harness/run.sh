#!/bin/bash
# run.sh <ghost relpath> <region> <endQF>: one ghost through $PM (default pm.mjs, the viewer's game code), log to $RUNS/.
# STOPDRIFT (default 120): stop that many ticks after the first drift, since a batch only compares first drifts; STOPDRIFT= runs to the end.
RUNS=${RUNS:-runs}; f=$1; reg=$2; end=$3; out=/tmp/claude-0/up3/$RUNS/$(echo "$f" | tr '/' '_').log
export STOPDRIFT=${STOPDRIFT-120}
cd /tmp/claude-0/ct || exit 1
if [ "$reg" = PAL ]; then export SCENEDIR=/tmp/claude-0/palscene/data/scene; fi
s=$(date +%s); timeout 300 node --max-old-space-size=2500 ${PM:-pm.mjs} auto "/tmp/claude-0/up3/$f" "$end" > "$out" 2>&1; echo "RC $? SECS $(( $(date +%s)-s ))" >> "$out"
