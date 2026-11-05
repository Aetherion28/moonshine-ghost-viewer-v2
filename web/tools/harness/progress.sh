#!/bin/bash
# progress.sh start <label> <total> <done file> | finish: the test-progress pane's file (/tmp/claude-0/progress.json).
# Each finished run adds one line to <done file>; the pane counts them.
P=/tmp/claude-0/progress.json
case "$1" in
  start) : > "$4"; printf '{"label":%s,"total":%d,"doneFile":"%s","startedAt":%d,"finishedAt":null}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")" "$3" "$4" "$(date +%s)" > "$P" ;;
  finish) [ -f "$P" ] && python3 - "$P" <<'PY'
import json, sys, time
p = sys.argv[1]; j = json.load(open(p)); j['finishedAt'] = int(time.time()); json.dump(j, open(p, 'w'))
PY
  ;;
esac
