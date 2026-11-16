def parse(path):
    D={}
    for l in open(path):
        if not l.startswith('m '): continue
        segs=l.split('|'); h=segs[0].split(); rc=int(h[1])
        if 'cam' not in h: continue
        c=[float(x) for x in h[h.index('cam')+1:]][-44:]
        P=c[0:16]; M=c[32:44]
        ms={}
        for s in segs[1:]:
            t=s.split()
            if len(t)>=4:
                v=tuple(map(float,t[5:8])) if len(t)>=8 and t[4]=='v' else (0,0,1)
                ms[t[0]]=tuple(map(float,t[1:4]))+v
        D[rc]=(P,M,ms)
    return D
def proj(P,M,p,W=320,H=240):
    v=[M[4*r]*p[0]+M[4*r+1]*p[1]+M[4*r+2]*p[2]+M[4*r+3] for r in range(3)]
    w=-v[2]; x=(P[0]*v[0]+P[2]*v[2])/w; y=(P[5]*v[1]+P[6]*v[2])/w
    return ((x+1)/2*W,(1-y)/2*H)
def depth(M,p): return -(M[8]*p[0]+M[9]*p[1]+M[10]*p[2]+M[11])
