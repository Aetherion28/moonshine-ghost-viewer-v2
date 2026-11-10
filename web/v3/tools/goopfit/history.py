# one constraint's texel, frame by frame, under a rule:  python3 -I history.py <name> [from tick]
import sys,os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import constraints as C, pixel, tri
def history(name,R,frm=0):
    c=[c for c in C.CON if c[0]==name][0]; (X,Y),H,tmax=c[1],c[2],c[3]
    t0=None; layer=-1; v=None; lines=[]
    for e in C.evs[name]:
        if e['t']>tmax: break
        if e['t']!=t0: t0=e['t']; layer=-1; cur=[]; lines.append((t0,cur))
        if e['k']=='K':
            layer+=1
            if layer==0 and v is not None and v<50: v=max(0,v-8)
            if layer==0: cur.append(f"L{v}")
            continue
        if layer!=0: continue
        if e['k']=='L':
            if v is None: v=e['new']
            continue
        if v is None: v=0
        if e['k']=='T':
            if 'cov' not in R or not tri.covered(e['tri'],X,Y,R): continue
            c_=255; a=tri.alpha(tri.snapped(e['tri'],R['asnap']) if 'asnap' in R else e['tri'],X,Y,R.get('ax',R['dx']),R.get('ay',R['dy']))
        elif e['k']=='M':
            if 'cov' in R: continue
            c_,a=e['c'],e['a']
        else:
            win=e['c0']<H<e['c1']; a=pixel.sample(e['tex'],X,Y,e['q'],R) if win else 0; c_=a if e['tex']=='9a7440' else 255
        if a:
            v=pixel.blend(c_,v,a,R); cur.append(f"{e['k']}{c_}/{a}>{v}")
    for t,c in lines:
        if len(c)>1 and t>=frm: print(t,' '.join(c)[:200])
    print('at',tmax,':',v,'(the console:',[c for c in C.CON if c[0]==name][0][4],'30)')
MODEL=dict(dx=2/3,dy=11/24,q='trunc',fbits=7,brnd='floor',blend=0,cov='fixed',sub=12,off=6,snap='floor',asnap=12,ax=.5,ay=.5)
if __name__=='__main__': history(sys.argv[1],MODEL,int(sys.argv[2]) if len(sys.argv)>2 else 0)
