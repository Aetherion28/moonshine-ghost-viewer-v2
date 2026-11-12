#!/usr/bin/env python3
"""The coverage ledger: the game functions v3 ran in the batch recordings, each against v2.

Input: the lockstep batch's <name>.cov files (lockstep_v3.ts: every function whose code the game ran).
Each function is classified:
  exact      a function-level differential test (difftests.json) shows v2's port equal to the DOL's
  stand-in   v2 has it, but its code there says stand-in / approximated / TODO
  unchecked  v2 has a function of that name in a file that names the class
  missing    no counterpart found in v2
  (middleware: JSystem, the dolphin SDK, MSL and the runtime are listed apart, by translation unit)
Usage: python3 ledger.py <cov folder> [<out .tsv>]  (prints the counts; the .tsv has every function)
"""
import re, sys, glob, os, json, collections

ROOT = '/home/claude/moonshine-ghost-viewer-v2/web'
DECOMP = '/home/claude/sms-ai-decomp/config/GMSJ01'
SIM = ROOT + '/src/game'
covdir = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else ROOT + '/tools/harness/ledger.tsv'

# translation units by .text range
tus = []
cur = None
for l in open(DECOMP + '/splits.txt'):
    m = re.match(r'^(\S.*):\s*$', l)
    if m: cur = m.group(1); continue
    m = re.match(r'\s+\.text\s+start:0x([0-9A-F]+) end:0x([0-9A-F]+)', l)
    if m and cur: tus.append((int(m.group(1), 16), int(m.group(2), 16), cur))
tus.sort()
def tu_of(a):
    lo, hi = 0, len(tus) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if tus[mid][0] <= a: lo = mid + 1
        else: hi = mid - 1
    return tus[hi][2] if hi >= 0 and a < tus[hi][1] else '?'
addr = {}
for l in open(DECOMP + '/symbols.txt'):
    m = re.match(r'(\S+) = \.text:0x([0-9A-F]+); // type:function size:0x([0-9A-F]+)', l)
    if m: addr[m.group(1)] = (int(m.group(2), 16), int(m.group(3), 16))
MIDDLEWARE = re.compile(r'^(JSystem|dolphin|MSL_C|Runtime|TRK|OdemuExi|amcstubs|odenotstub|THP|MetroTRK|PowerPC_EABI)')

# runs per function
runs = collections.Counter()
traces = 0
for f in glob.glob(os.path.join(covdir, '*.cov')):
    traces += 1
    for n in open(f).read().split():
        runs[n] += 1

src = {f: open(f).read() for f in glob.glob(SIM + '/**/*.ts', recursive=True)}
exact = set(json.load(open(ROOT + '/tools/harness/difftests.json'))) if os.path.exists(ROOT + '/tools/harness/difftests.json') else set()
STANDIN = re.compile(r'stand-?in|approximat|TODO', re.I)

def demangle(n):
    # method__<len><Class>F...  or  method__Q2<..>  or a free function
    m = re.match(r'^(\w+?)__(\d+)(\w+)$', n)
    if m:
        k = int(m.group(2)); rest = m.group(3)
        if len(rest) >= k: return rest[:k], m.group(1)
    m = re.match(r'^(\w+?)__Q\d((?:\d+\w+?)+?)F', n)
    if m:
        parts = re.findall(r'(\d+)', m.group(2))
        return None, m.group(1)
    m = re.match(r'^(\w+?)__F', n)
    if m: return None, m.group(1)
    return None, n

def classify(n):
    if n in exact: return 'exact', ''
    cls, meth = demangle(n)
    if meth.startswith('__') and meth not in ('__ct', '__dt'): return 'missing', ''
    meth_re = re.compile(r'\b' + re.escape(meth) + r'\s*(?:\(|=|:|<)')
    names = [cls, cls[1:]] if cls and cls.startswith('T') else [cls] if cls else []
    if meth in ('__ct', '__dt'):
        hits = [f for f, s in src.items() if any(re.search(r'\bclass ' + re.escape(c) + r'\b', s) for c in names)] if names else []
        return ('unchecked', os.path.relpath(hits[0], SIM)) if hits else ('missing', '')
    best = None
    for f, s in src.items():
        if names and not any(c in s for c in names): continue
        m = meth_re.search(s)
        if not m: continue
        line = s.count('\n', 0, m.start())
        lines = s.split('\n')[max(0, line - 3):line + 8]
        kind = 'stand-in' if any(STANDIN.search(x) for x in lines) else 'unchecked'
        best = (kind, os.path.relpath(f, SIM))
        if kind == 'unchecked': break
    return best or ('missing', '')

rows = []
counts = collections.Counter()
for n, k in runs.items():
    a = addr.get(n, (0, 0))
    tu = tu_of(a[0])
    if MIDDLEWARE.match(tu):
        rows.append(('middleware', n, tu, k, a[1], ''))
        counts['middleware'] += 1
        continue
    kind, where = classify(n)
    rows.append((kind, n, tu, k, a[1], where))
    counts[kind] += 1
rows.sort(key=lambda r: (['missing', 'stand-in', 'unchecked', 'exact', 'middleware'].index(r[0]), -r[3], r[1]))
with open(out, 'w') as o:
    o.write('# The coverage ledger (tools/harness/ledger.py): game functions v3 ran in %d batch recordings\n' % traces)
    o.write('# status\tfunction\ttranslation unit\trecordings that ran it\tsize\tv2 file\n')
    for r in rows: o.write('\t'.join(str(x) for x in r) + '\n')
print('recordings', traces, 'functions', len(rows), ' '.join(f'{k} {counts[k]}' for k in ['exact', 'unchecked', 'stand-in', 'missing', 'middleware']))
