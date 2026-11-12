# rc.py <rk.mjs output> <sim output with RC lines>: the first ticks where the sim takes a different number of random
# numbers than the game (the game's calls by label from rk.mjs: "<index> <label> <caller>"; the sim's "RC <tick> <total>").
# The sim's total as Mario's perform of tick t begins (probes/p_rc.js) is the game's through label t - offset (default 2: the sim counts ticks from 1, and the label changes after the cap)
# plus a constant while the two are in step; a new value of the difference is where the consumers first differ.
import sys, collections
g = collections.Counter(); first = None
for l in open(sys.argv[1], errors='replace'):
    q = l.split()
    if len(q) >= 3 and q[0].isdigit() and q[1].lstrip('-').isdigit():
        g[int(q[1])] += 1
        if first is None: first = int(q[0])
S = {}
for l in open(sys.argv[2], errors='replace'):
    if l.startswith('RC '): q = l.split(); S[int(q[1])] = int(q[2])
cum = 0; G = {}
for t in sorted(g):
    cum += g[t]; G[t] = cum
off = int(sys.argv[4]) if len(sys.argv) > 4 else 2
ticks = [t for t in sorted(S) if t - off in G and t >= 1]
if not ticks: print('no ticks in common'); sys.exit()
seen = collections.Counter(); news = []
for t in ticks:
    d = S[t] - G[t - off]
    if seen[d] == 0: news.append((t, d))
    seen[d] += 1
# (the values the difference takes while in step all show up within the first frames; later new ones are what to look at)
late = [(t, d) for t, d in news if d != seen.most_common(1)[0][0]]
for t, d in late[:int(sys.argv[3]) if len(sys.argv) > 3 else 8]: print('tick', t, ': a new difference', d, '(%d ticks have it)' % seen[d])
print('checked', len(ticks), 'ticks;', len(news), 'different values;', 'the usual ones:', dict(seen.most_common(5)))
