# watercmp.py <oracle output> <sim output> [lines] [offset]: the first ticks where the game's and the sim's water drops differ
# (offset, default 1: the game's label t + offset is compared with the sim's t; the oracle prints before the tick's water
# has moved, a pm_probe script after)
# (both in the oracle's `water` format: "<tick> WATER <n> slot life flags attack x y z vx vy vz size type | ...")
import sys
def load(p):
    D = {}
    for l in open(p, errors='replace'):
        q = l.split(' WATER ', 1)
        if len(q) != 2 or not q[0].strip().split()[-1].isdigit(): continue
        t = int(q[0].strip().split()[-1]); n, _, rest = q[1].partition(' ')
        D[t] = (int(n), [r.split() for r in rest.strip().split(' | ') if r.strip()])
    return D
G, S = load(sys.argv[1]), load(sys.argv[2]); shown = 0; lim = int(sys.argv[3]) if len(sys.argv) > 3 else 5; off = int(sys.argv[4]) if len(sys.argv) > 4 else 1
names = ['slot', 'life', 'flags', 'attack', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'size', 'type']
for t in sorted(G):
    if t - off not in S: continue
    (gn, g), (sn, s) = G[t], S[t - off]
    bad = []
    if gn != sn: bad.append('count game %d sim %d' % (gn, sn))
    for a, b in zip(g, s):
        d = [(names[k], x, y) for k, (x, y) in enumerate(zip(a, b)) if x != y]
        if d: bad.append('slot %s: ' % a[0] + ', '.join('%s game %s sim %s' % e for e in d[:5]))
    if bad:
        print('tick', t, '; '.join(bad[:4]) + (' ... %d more' % (len(bad) - 4) if len(bad) > 4 else '')); shown += 1
        if shown >= lim: break
if not shown: print('the same over', len([t for t in G if t in S]), 'ticks')
