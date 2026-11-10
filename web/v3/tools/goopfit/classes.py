# What each kind of stamp pixel allows: the sample point of one kind moved at a time, the others as ppc/gx.ts has
# them. A kind is (the stamp's corner even or odd in x, in y; the pixel's column and row in the stamp even or odd;
# which of the quad's two triangles), 32 in all.
#   CAPS=a.jsonl,b.jsonl python3 -I classes.py          (about 20 minutes for three captures)
# Each line: the kind, x or y, then value:disagreeing tests per capture.
import sys,os,itertools; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import sim, multi
from multiprocessing import Pool
KEYS=list(itertools.product((0,1),repeat=5))
def base():
    return {(ox,oy,rx,ry,t):sim.PAR4[((ox+rx)%2,(oy+ry)%2)] for ox,oy,rx,ry,t in KEYS}
def with_(S,ch):
    S=dict(S)
    for k,(i,v) in ch.items(): t=list(S[k]); t[i]=v; S[k]=tuple(t)
    return S
if __name__=='__main__':
    B=base(); print('base',multi.run(dict(par32=B)),flush=True)
    vals={0:[i/48 for i in range(22,36,2)],1:[i/48 for i in range(18,38,2)]}
    with Pool(2) as pool:
        for k in KEYS:
            for i in (0,1):
                res=pool.map(multi.run,[dict(par32=with_(B,{k:(i,v)})) for v in vals[i]])
                print('corner %d%d pixel %d%d %s %s now %.3f |'%(k[0],k[1],k[2],k[3],'under' if k[4] else 'over ','xy'[i],B[k][i]),' '.join('%.3f:%s'%(v,'/'.join(str(o[0]) for o in r)) for v,r in zip(vals[i],res)),flush=True)
