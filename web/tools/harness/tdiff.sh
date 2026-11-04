#!/bin/bash
# tdiff.sh trace a b : sim vs rec per tick
cd /tmp/claude-0/ct
TICK=$2-$3 timeout 300 node --max-old-space-size=2500 pm_fb.mjs auto $1 $(( $3 + 1 )) 2>&1 | grep "^  tick" > /tmp/claude-0/s_t.txt
node gv.mjs $1 $2 $3 > /tmp/claude-0/r_t.txt
python3 - <<'PY'
S={};R={}
for l in open('/tmp/claude-0/s_t.txt'):
    p=l.split(); S[int(p[1])]=p
for l in open('/tmp/claude-0/r_t.txt'):
    p=l.split()
    try: R[int(p[0])]=p
    except: pass
for t in sorted(S):
    if t not in R: print(t,'norec'); continue
    s=S[t]; r=R[t]
    d=max(abs(float(a)-float(b)) for a,b in zip(s[2:5],r[1:4]))
    fs=s[s.index('fl')+1]; fr_=r[r.index('fl')+1]
    print(t,'d %.4f'%d,'st',s[6],r[5],'fv',s[8][:9],r[7][:9],'vy',s[11][:8],r[10][:8],'fa',s[14],r[16],'fl',fs,fr_)
PY
