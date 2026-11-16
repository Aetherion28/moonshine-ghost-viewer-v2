#!/usr/bin/env bash
# The built page loads in headless Chrome without an uncaught error or a missing file of its own.
# No disc: the site hosts no game data, so this checks the page shell (scripts, styles, vendor files).
#   bash tools/ci/pagecheck.sh [site dir, default ../site]
set -u
site=${1:-../site}
port=8766
srvlog=$(mktemp)
python3 -m http.server $port --bind 127.0.0.1 --directory "$site" > "$srvlog" 2>&1 & srv=$!
trap 'kill $srv 2> /dev/null' EXIT
sleep 1
chrome=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)
[ -n "$chrome" ] || { echo "no Chrome found"; exit 1; }
log=$(mktemp) dom=$(mktemp)
fail=0
for page in index.html legal.html; do
  "$chrome" --headless=new --no-sandbox --enable-logging=stderr --v=0 --use-angle=swiftshader --enable-unsafe-swiftshader \
    --window-size=1280,800 --virtual-time-budget=10000 --dump-dom "http://127.0.0.1:$port/$page" > "$dom" 2> "$log"
  echo "== $page"
  grep -o 'CONSOLE.*' "$log" | cut -c1-300 || true
  if grep -E 'CONSOLE[^"]*"Uncaught' "$log"; then fail=1; fi
  [ -s "$dom" ] || { echo "$page: nothing rendered"; fail=1; }
done
# a file of the site's own that's missing (Chrome doesn't log failed loads; the server does; other
# sites' failures, such as the shared-ghost listing being down, are not the page's)
if grep -E '" [45][0-9][0-9] ' "$srvlog" | grep -v 'GET /favicon.ico '; then echo "(missing files above)"; fail=1; fi
if [ $fail = 1 ]; then echo "The page logged errors (above)"; exit 1; fi
echo "pages load without errors"
