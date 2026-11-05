#!/bin/bash
# run1.sh <ghost relpath> <region> <endQF>: one ghost through pm.mjs (the viewer's game code), log to runs2/
RUNS=${RUNS:-runs}; f=$1; reg=$2; end=$3; out=/tmp/claude-0/up3/$RUNS/$(echo "$f" | tr '/' '_').log
cd /tmp/claude-0/ct || exit 1
if [ "$reg" = PAL ]; then export SCENEDIR=/tmp/claude-0/palscene/data/scene; fi
s=$(date +%s); timeout 300 node --max-old-space-size=2500 pm.mjs auto "/tmp/claude-0/up3/$f" "$end" > "$out" 2>&1; echo "RC $? SECS $(( $(date +%s)-s ))" >> "$out"
