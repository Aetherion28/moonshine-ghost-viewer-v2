import sys
for l in sys.stdin:
    p=l.split()
    try:
        d=float(p[2]); a=int(p[16],16); b=int(p[17],16)
    except Exception: continue
    if d>0.0005 or p[4]!=p[5] or p[13]!=p[14] or (a&~1)!=(b&~1): print(l.rstrip()); n=1; break
