#!/bin/bash
# batch.sh <runs dir> [bundle] [previous runs dir]: every ghost in list5.txt (list4.txt without the two TAS runs), two at a time, longest first
# (by the previous batch's times) so the last minutes aren't one long run alone.
RUNS=$1; PM=${2:-pm.mjs}; PREV=${3:-}
cd /tmp/claude-0/up3 && mkdir -p "$RUNS"
python3 - "$PREV" > "/tmp/claude-0/up3/.order_$RUNS.txt" <<'PY'
import sys, re, os
prev = sys.argv[1]
rows = [l for l in open('/tmp/claude-0/up3/list5.txt') if l.strip()]
def secs(l):
    p = os.path.join('/tmp/claude-0/up3', prev, l.split()[0].replace('/', '_') + '.log') if prev else ''
    if p and os.path.exists(p):
        m = re.search(r'SECS (\d+)', open(p, errors='replace').read())
        if m: return int(m.group(1))
    return 0
for l in sorted(rows, key=secs, reverse=True): print(l.rstrip('\n'))
PY
H=/home/claude/moonshine-ghost-viewer-v2/web/tools/harness
$H/progress.sh start "${LABEL:-Full test $RUNS}" "$(wc -l < "/tmp/claude-0/up3/.order_$RUNS.txt")" "/tmp/claude-0/up3/$RUNS/.done"
cat "/tmp/claude-0/up3/.order_$RUNS.txt" | RUNS=$RUNS PM=$PM xargs -P 2 -L 1 $H/run.sh
$H/progress.sh finish
