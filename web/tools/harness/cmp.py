import re, glob, os, json, sys, collections
# cmp.py <old runs dir> <new runs dir>: Simulate's first drift per ghost, before vs after
old, new = sys.argv[1], sys.argv[2]
cat = {}
for l in open('/tmp/claude-0/up3/catalog.tsv'):
    p = l.rstrip('\n').split('\t')
    if len(p) >= 10: cat[p[0].replace('/', '_')] = p
def first(path):
    if not os.path.exists(path): return None
    t = open(path, errors='replace').read()
    if '\nRC ' not in t and not t.startswith('RC '): return None
    d = re.search(r'drift (\{.*\})', t)
    return json.loads(d.group(1))['firstQf'] if d else 'crash'
def scene(path):
    m = re.search(r'^(\S+) t3 .*spawn', open(path, errors='replace').read(), re.M); return m.group(1) if m else '?'
def bucket(f, secs):
    if f == -1: return 'never'
    t = f / 120
    return '<1s' if t < 1 else '1-5s' if t < 5 else '5-15s' if t < 15 else '15-30s' if t < 30 else '30s+'
B = collections.Counter(); A = collections.Counter(); rows = []
for f in sorted(glob.glob(new + '/*.log')):
    k = os.path.basename(f)[:-4]
    a = first(f); b = first(os.path.join(old, os.path.basename(f)))
    if a is None or b is None or a == 'crash' or b == 'crash': rows.append((k, b, a, '?')); continue
    c = cat.get(k); secs = float(c[7]) if c else 0
    B[bucket(b, secs)] += 1; A[bucket(a, secs)] += 1
    A_ = 1e12 if a == -1 else a; B_ = 1e12 if b == -1 else b
    rows.append((k, b, a, 'better' if A_ > B_ else 'worse' if A_ < B_ else 'same', scene(f)))
order = ['<1s', '1-5s', '5-15s', '15-30s', '30s+', 'never']
print('bucket  before after'); [print(f'{o:7} {B[o]:6} {A[o]:5}') for o in order]
print(collections.Counter(r[3] for r in rows))
for r in rows:
    if r[3] in ('better', 'worse', '?'): print(r)
