#!/bin/bash
# run.sh <ghost relpath> <region> <endQF>: one ghost through $PM (default pm.mjs, the viewer's game code), log to $RUNS/.
# STOPDRIFT (default 120): stop that many ticks after the first drift, since a batch only compares first drifts; STOPDRIFT= runs to the end.
RUNS=${RUNS:-runs}; f=$1; reg=$2; end=$3; out=/tmp/gv/up3/$RUNS/$(echo "$f" | tr '/' '_').log
export STOPDRIFT=${STOPDRIFT-120}
cd /tmp/gv/ct || exit 1
if [ "$reg" = PAL ]; then export SCENEDIR=/tmp/gv/palscene/data/scene; fi
s=$(date +%s); timeout 300 node --max-old-space-size=2500 ${PM:-pm.mjs} auto "/tmp/gv/up3/$f" "$end" > "$out" 2>&1; echo "RC $? SECS $(( $(date +%s)-s ))" >> "$out"; echo "$f" >> "/tmp/gv/up3/$RUNS/.done"
