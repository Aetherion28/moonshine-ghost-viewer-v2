# Where in a pixel each stamp pixel the recordings fixed may be sampled: for every refuted single-pixel change of
# tables.py (and the texels below, found by hand), the set of sample points (dx, dy) that give an allowed value.
#   python3 -I field.py <capture.jsonl> <tables.json> [field.pkl]
# Prints, for subsets of the pixels (a size, a triangle of the quad, a half), the sample points all of them allow.
# A rule that moves the sample point by the pixel can then be tested by lookup in the saved field
# ({(kind, size, col, row): bool grid [dx, dy]}, kind 'c' the clean stamp, 'p' the pollute stamp).
import sys,os,pickle; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import numpy as np, sim, check
CLEAN=0x9a7440; POLLUTE=0x9a8460       # the stamps' textures (GMSJ01 revision 0)
G=96; LO=-0.5; HI=1.5
ds=[LO+(HI-LO)*(i+0.5)/G for i in range(G)]; edge=lambda i: LO+(HI-LO)*i/G
# found by hand, each from one stopped replay:
#   Bianco Hills 5, tick 2,933: texel (305,95) is goop on the console; two 18-pixel clean stamps sit on it, and
#   only pixel (6,13) can be less than here (4): it must be 3 or less
EXTRA_CLEAN=[(18,6,13,4)]
#   Bianco Hills 1, tick 2,426 (Mario's dirty flag): texel (156,121) got four draws of a 4-pixel pollute stamp's
#   pixel (0,1) and is goop on the console: its alpha is 9 or more (four draws of 8 end at 28, the limit is 30)
EXTRA_POLLUTE=[(4,0,1,9)]
def build(F):
    ok={}
    for (tex,size),f in F.items():
        bad=set(f['bad'])
        if tex==CLEAN: bad|={(c,r,v) for s,c,r,v in EXTRA_CLEAN if s==size}
        if tex!=CLEAN or not bad: continue
        A=np.zeros((G,G,size,size),dtype=np.int64)
        for i,dx in enumerate(ds):
            for j,dy in enumerate(ds): A[i,j]=sim.stamp_alpha(tex,(0,0,size,size),dict(sim.MODEL,dx=dx,dy=dy))
        for col,row,val in bad:
            b=int(f['base'][row,col]); v=A[:,:,row,col]
            good=(v>val) if val<b else (v<val)
            k=('c',size,col,row); ok[k]=ok.get(k,np.ones((G,G),bool))&good
    for size,col,row,amin in EXTRA_POLLUTE:
        m=np.zeros((G,G),bool)
        for i,dx in enumerate(ds):
            for j,dy in enumerate(ds): m[i,j]=sim.stamp_alpha(POLLUTE,(0,0,size,size),dict(sim.MODEL,dx=dx,dy=dy))[row,col]>=amin
        ok[('p',size,col,row)]=m
    return ok
def region(ok,keys):
    m=np.ones((G,G),bool)
    for k in keys: m&=ok[k]
    return m
def show(name,m):
    idx=np.argwhere(m)
    if not len(idx): print(f'{name}: none'); return
    print(f'{name}: {len(idx)} cells, dx {edge(idx[:,0].min()):.3f}..{edge(idx[:,0].max()+1):.3f}, dy {edge(idx[:,1].min()):.3f}..{edge(idx[:,1].max()+1):.3f}')
if __name__=='__main__':
    sim.load(sys.argv[1]); F=check.facts(sys.argv[2]); ok=build(F); K=list(ok)
    if len(sys.argv)>3: pickle.dump((ds,ok),open(sys.argv[3],'wb'))
    print(len(K),'pixels')
    N=('c',24,4,18); B=('c',18,6,13); P=('p',4,0,1)
    show('all',region(ok,K))
    for name,drop in (('all but N',(N,)),('all but B',(B,)),('all but P',(P,)),('all but N and P',(N,P)),('all but N and B',(N,B)),('all but B and P',(B,P))):
        show(name,region(ok,[k for k in K if k not in drop]))
    for s in sorted({k[1] for k in K}):
        show(f'size {s}',region(ok,[k for k in K if k[1]==s]))
        show(f'size {s}, col >= row',region(ok,[k for k in K if k[1]==s and k[2]>=k[3]]))
        show(f'size {s}, col < row',region(ok,[k for k in K if k[1]==s and k[2]<k[3]]))
