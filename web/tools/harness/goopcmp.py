# goopcmp.py <oracle output> <sim output> [offset]: the goop maps of the game and the sim per tick and layer
# (GOOP <tick> <index> <address> <class> <log2 w> <log2 h> <threshold> <base64>; the game's tick + offset against the sim's tick)
import sys, base64
def load(p):
    D = {}
    for l in open(p, errors='replace'):
        if l.startswith('GOOP ') and len(l.split()) == 9 and l.split()[-2].isdigit():
            q = l.split(); D.setdefault(int(q[1]), {})[int(q[2])] = (q[4], int(q[-2]), base64.b64decode(q[-1]))
    return D
G, S = load(sys.argv[1]), load(sys.argv[2]); off = int(sys.argv[3]) if len(sys.argv) > 3 else 0
for t in sorted(G):
    if t - off not in S: continue
    row = []
    for k in sorted(G[t]):
        gc, thr, gm = G[t][k]; sm = S[t - off].get(k, (0, 0, b''))[2]
        if len(sm) != len(gm): row.append('L%d size?' % k); continue
        d = [i for i in range(len(gm)) if gm[i] != sm[i]]
        row.append('L%d %d' % (k, len(d)) + ((' (first byte %d: game %d sim %d; over thr game %d sim %d)' % (d[0], gm[d[0]], sm[d[0]], sum(1 for a in gm if a > thr), sum(1 for a in sm if a > thr))) if d else ''))
    print('tick', t, ' '.join(row))
