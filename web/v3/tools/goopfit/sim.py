# The goop maps of a whole recording, replayed from tests/goopcap.ts's capture under a rule for the GPU's
# arithmetic, and every goop test of the game checked against what the recording fixed.
#   python3 -I sim.py <capture.jsonl>             the model's rule: how many tests disagree, and the first
# A rule (dict): dx, dy (where in a pixel texture coordinates are taken), mx, my (a factor on them), tu, tv (an
# offset in texels), q ('trunc' / 'round' to 1/128 texel), brnd (the bilinear sum: 'floor' / 'round'), bias (added
# before the blender's shift), sub / mid / snap (the grid screen positions are kept in, where a pixel is tested,
# 'floor' / 'round'), cx, cy (where colours are taken, from the gridded positions), par4 (a sample point for each pixel
# of a 2 x 2 group: {(x & 1, y & 1): (dx, dy)}; the model's is PAR4).
import json,base64,math,sys,os
import numpy as np
MODEL=dict(dx=2/3,dy=11/24,mx=1.0,my=1.0,tu=0.0,tv=0.0,q='trunc',brnd='floor',bias=0,sub=12,mid=6,snap='floor',cx=0.5,cy=0.5)
# ppc/gx.ts's sample points (Gx.samplePoint), and its whole rule (MODEL alone is one point for every pixel: field.py, check.py)
PAR4={(0,0):(0.65625,0.46875),(1,0):(0.59375,0.625),(0,1):(0.65625,0.46875),(1,1):(0.59375,0.46875)}
GX=dict(MODEL,par4=PAR4)
TEXN={}   # the stamps' textures, by address (from the capture)

def load(path):
    ev=[]
    for l in open(path):
        try: ev.append(json.loads(l))
        except Exception: pass
    init=[e for e in ev if e['k']=='init'][0]
    for e in ev:
        if e['k']=='tex' and e['fmt']==1: TEXN[e['addr']]=np.frombuffer(base64.b64decode(e['data']),dtype=np.uint8).reshape(e['h'],e['w']).astype(np.int64)
    return init,ev

def stamp_alpha(tex,q,R,pos=(0,0)):
    """the stamp texture's value at every pixel of its quad (rows y, columns x)"""
    x1,y1,x2,y2=q; w=int(x2-x1); h=int(y2-y1); T=TEXN[tex]; th,tw=T.shape
    C,Rw=np.meshgrid(np.arange(w),np.arange(h))
    ku=tw/w; kv=th/h
    if R.get('sbits') is not None:        # (experiments) the step of the texture coordinate a pixel, kept with so many fractional bits
        f=2.0**R['sbits']; rd={'round':lambda z: math.floor(z*f+0.5)/f,'trunc':lambda z: math.floor(z*f)/f,'ceil':lambda z: math.ceil(z*f)/f}[R.get('srnd','round')]
        ku=rd(ku); kv=rd(kv)
    dx=R['dx']; dy=R['dy']
    if 'bysize' in R and w in R['bysize']: dx,dy=R['bysize'][w]      # (experiments) a stamp size's own sample point
    if 'byphase' in R:                   # (experiments) by where the stamp is: {(size, modulus): {(x1 % m, y1 % m): (dx, dy)}}
        for (sz,m),tab in R['byphase'].items():
            if sz==w and (pos[0]%m,pos[1]%m) in tab: dx,dy=tab[(pos[0]%m,pos[1]%m)]
    if 'par' in R:                        # (experiments) by the pixel's own place on the screen, even or odd: (dx even x, dx odd x, dy even y, dy odd y)
        p=R['par']; dx=np.where((pos[0]+C)%2==0,p[0],p[1]); dy=np.where((pos[1]+Rw)%2==0,p[2],p[3])
    if 'par4' in R:                       # (experiments) each pixel of a 2 x 2 group its own point: {(x & 1, y & 1): (dx, dy)}
        xo=(pos[0]+C)%2; yo=(pos[1]+Rw)%2; dx=np.zeros(C.shape); dy=np.zeros(C.shape)
        for (a,b),(px,py) in R['par4'].items(): m=(xo==a)&(yo==b); dx=np.where(m,px,dx); dy=np.where(m,py,dy)
    if 'par16' in R:                      # (experiments) by the stamp's own corner too: {(x1 & 1, y1 & 1, col & 1, row & 1): (dx, dy)}
        ox=pos[0]%2; oy=pos[1]%2; dx=np.zeros(C.shape); dy=np.zeros(C.shape)
        for rx in (0,1):
            for ry in (0,1):
                m=(C%2==rx)&(Rw%2==ry); px,py=R['par16'][(ox,oy,rx,ry)]; dx=np.where(m,px,dx); dy=np.where(m,py,dy)
    if 'par32' in R:                      # (experiments) ... and by the quad's triangle: {(x1 & 1, y1 & 1, col & 1, row & 1, 1 under the diagonal): (dx, dy)}
        ox=pos[0]%2; oy=pos[1]%2; dx=np.zeros(C.shape); dy=np.zeros(C.shape)
        for rx in (0,1):
            for ry in (0,1):
                for t in (0,1):
                    m=(C%2==rx)&(Rw%2==ry)&((C<Rw)==bool(t)); px,py=R['par32'][(ox,oy,rx,ry,t)]; dx=np.where(m,px,dx); dy=np.where(m,py,dy)
    if 'dx2' in R or 'dy2' in R:          # (experiments) the quad's second triangle (under its diagonal) sampled elsewhere
        t2=C<Rw; dx=np.where(t2,R.get('dx2',dx),dx); dy=np.where(t2,R.get('dy2',dy),dy)
    if 'dxa' in R or 'dya' in R:          # (experiments) the quad cut along its other diagonal: the upper left triangle sampled elsewhere
        ta=(C+Rw)<(w-1) if R.get('tie','lr')=='lr' else (C+Rw)<=(w-1)
        dx=np.where(ta,R.get('dxa',R['dx']),dx); dy=np.where(ta,R.get('dya',R['dy']),dy)
    u=R['mx']*(C+dx)*ku+R['tu']; v=R['my']*(Rw+dy)*kv+R['tv']
    if 'dyb' in R: v=np.where(Rw*2>=h,R['my']*(Rw+R['dyb'])*kv+R['tv'],v)      # (experiments) the lower half's own offset
    if 'dxr' in R: u=np.where(C*2>=w,R['mx']*(C+R['dxr'])*ku+R['tu'],u)       # (experiments) the right half's own offset
    if 'shv' in R: v=v+R['shv']*(C+0.5-w/2)*ku        # (experiments) a shear: v by the column, u by the row (in texels a texel)
    if 'shu' in R: u=u+R['shu']*(Rw+0.5-h/2)*kv
    if 'tri' in R:                        # (experiments) a quad's two triangles each with its own plane: the corner off the
        # diagonal taken as if it sat (ax, ay) pixels inside the quad; {'ll': (ax, ay), 'ur': (ax, ay)}
        x=C+dx; y=Rw+dy; ur=C>=Rw
        def plane(p0,p1,p2):              # (x, y, value) three times -> value = a x + b y + c
            M=np.array([[p0[0],p0[1],1.0],[p1[0],p1[1],1.0],[p2[0],p2[1],1.0]]); return lambda val: np.linalg.solve(M,np.array(val,dtype=float))
        lx,ly=R['tri'].get('ll',(0,0)); rx,ry=R['tri'].get('ur',(0,0))
        PL=plane((0,0),(w,h),(lx,h-ly)); PU=plane((0,0),(w,h),(w-rx,ry))
        ul=PL((0,tw,0)); vl=PL((0,th,th)); uu=PU((0,tw,tw)); vu=PU((0,th,0))
        u=np.where(ur,uu[0]*x+uu[1]*y+uu[2],ul[0]*x+ul[1]*y+ul[2])+R['tu']; v=np.where(ur,vu[0]*x+vu[1]*y+vu[2],vl[0]*x+vl[1]*y+vl[2])+R['tv']
    if 'abs' in R:                        # (experiments) the coordinate's step a pixel kept with F fractional bits (cut), its error
        # growing with the screen position from an anchor: {'F': bits, 'ax': x, 'ay': y, 'sx': +-1, 'sy': +-1, 'rnd': 'floor'}
        A=R['abs']; f=2.0**A['F']; rd={'floor':math.floor,'round':lambda z: math.floor(z+0.5),'ceil':math.ceil}[A.get('rnd','floor')]
        eu=rd(ku*f)/f-ku; ev=rd(kv*f)/f-kv
        u=u+A.get('sx',1)*eu*(pos[0]+C+dx-A.get('ax',0)); v=v+A.get('sy',1)*ev*(pos[1]+Rw+dy-A.get('ay',0))
    if 'uv' in R: u,v=R['uv'](u,v,C,Rw,w,h,tw,th)     # (experiments) any other rule
    if R['q']=='trunc': su=np.trunc(u*128).astype(np.int64); sv=np.trunc(v*128).astype(np.int64)
    else: su=np.floor(u*128+0.5).astype(np.int64); sv=np.floor(v*128+0.5).astype(np.int64)
    su-=64; sv-=64
    iu=su>>7; fu=su&127; iv=sv>>7; fv=sv&127
    cu0=np.clip(iu,0,tw-1); cu1=np.clip(iu+1,0,tw-1); cv0=np.clip(iv,0,th-1); cv1=np.clip(iv+1,0,th-1)
    fb=R.get('fbits',7)                   # (experiments) the fraction's bits, and the two lerps one after the other
    if fb!=7: fu=fu>>(7-fb) if R.get('frnd','trunc')=='trunc' else np.minimum((fu+(1<<(6-fb)))>>(7-fb),(1<<fb)); fv=fv>>(7-fb) if R.get('frnd','trunc')=='trunc' else np.minimum((fv+(1<<(6-fb)))>>(7-fb),(1<<fb))
    one=1<<fb; t00=T[cv0,cu0].astype(np.int64); t01=T[cv0,cu1].astype(np.int64); t10=T[cv1,cu0].astype(np.int64); t11=T[cv1,cu1].astype(np.int64)
    bil=R.get('bil','joint'); half=(one>>1) if R.get('lrnd','floor')=='round' else 0
    if bil=='joint':
        a=t00*(one-fv)*(one-fu)+t01*(one-fv)*fu+t10*fv*(one-fu)+t11*fv*fu
        a=(a+((one*one)>>1 if R['brnd']=='round' else 0))>>(2*fb)
    elif bil=='sepS':                     # two lerps along S cut back to 8 bits, then one along T
        top=(t00*(one-fu)+t01*fu+half)>>fb; bot=(t10*(one-fu)+t11*fu+half)>>fb
        a=(top*(one-fv)+bot*fv+half)>>fb
    elif bil=='sepT':
        l=(t00*(one-fv)+t10*fv+half)>>fb; r=(t01*(one-fv)+t11*fv+half)>>fb
        a=(l*(one-fu)+r*fu+half)>>fb
    elif bil=='sepSd':                    # a + ((b - a) * f >> bits), the shift an arithmetic one
        top=t00+(((t01-t00)*fu+half)>>fb); bot=t10+(((t11-t10)*fu+half)>>fb)
        a=top+(((bot-top)*fv+half)>>fb)
    elif bil=='sepSz':                    # the same, cut towards zero
        z=lambda d: np.sign(d)*((np.abs(d)+half)>>fb)
        top=t00+z((t01-t00)*fu); bot=t10+z((t11-t10)*fu)
        a=top+z((bot-top)*fv)
    for (t,size,col,row),val in R.get('ovr',{}).items():       # (experiments) single pixels of a stamp set by hand
        if t==tex and size==w: a[row,col]=val
    for (t,size,col,row,cx,cy),val in R.get('ovr4',{}).items():   # (experiments) ... for the pixel of one place in a 2 x 2 group; a number, or '+1' / '-1'
        if t==tex and size==w and (pos[0]+col)%2==cx and (pos[1]+row)%2==cy: a[row,col]=max(0,a[row,col]+int(val)) if isinstance(val,str) else val
    return a

def blend(c,d,a,R):
    bm=R.get('bmode')
    if bm=='no1': a=np.where(a<2,0,a)                  # (experiments: other blenders)
    elif bm=='a7': a=a&~1
    elif bm=='a6': a=a&~3
    elif bm=='lerp0':                                  # d + (c-d)*a/256 rounded toward zero
        sf=a+(a>>7); p=(c-d)*sf; return d+np.where(p<0,-((-p)>>8),p>>8)
    elif bm=='sepr':
        sf=a+(a>>7); df=(255-a)+((255-a)>>7); return np.minimum(255,((c*sf+128)>>8)+((d*df+128)>>8))
    elif bm=='dround':                                 # the frame buffer's part rounded, the source's truncated
        sf=a+(a>>7); df=(255-a)+((255-a)>>7); return np.minimum(255,((c*sf)>>8)+((d*df+128)>>8))
    elif bm=='biasd':                                  # a rounding that grows with what is in the frame buffer
        sf=a+(a>>7); df=(255-a)+((255-a)>>7); return np.minimum(255,(c*sf+d*df+d)>>8)
    sf=a+(a>>7); df=(255-a)+((255-a)>>7)
    return np.minimum(255,(c*sf+d*df+R['bias'])>>8)

def tri_pixels(v,R):
    """the pixels a model's triangle covers, with the alpha there: [(x, y, alpha)]"""
    sub=R['sub']; mid=R['mid']
    sn=(lambda p: math.floor(sub*p+0.5)) if R['snap']=='round' else (lambda p: math.floor(sub*p))
    P=[(sn(x)-mid,sn(y)-mid) for x,y,_,_ in v]; A=[p[3] for p in v]
    (X1,Y1),(X2,Y2),(X3,Y3)=P
    area=(X2-X1)*(Y3-Y1)-(X3-X1)*(Y2-Y1)
    if area==0: return []
    i2,i3=1,2
    if area>0: (X2,Y2),(X3,Y3)=(X3,Y3),(X2,Y2); i2,i3=2,1
    DX12=X1-X2; DX23=X2-X3; DX31=X3-X1; DY12=Y1-Y2; DY23=Y2-Y3; DY31=Y3-Y1
    C1=DY12*X1-DX12*Y1; C2=DY23*X2-DX23*Y2; C3=DY31*X3-DX31*Y3
    if DY12<0 or (DY12==0 and DX12>0): C1+=1
    if DY23<0 or (DY23==0 and DX23>0): C2+=1
    if DY31<0 or (DY31==0 and DX31>0): C3+=1
    up=lambda n: -((-n)//sub)
    out=[]
    # the plane of alpha over the gridded positions
    px=[(p[0]+mid)/sub for p in P]; py=[(p[1]+mid)/sub for p in P]
    x0,y0=px[0],py[0]; xa,ya=(X2+mid)/sub,(Y2+mid)/sub; xb,yb=(X3+mid)/sub,(Y3+mid)/sub
    den=(xa-x0)*(yb-y0)-(xb-x0)*(ya-y0); a0=A[0]; a1=A[i2]; a2=A[i3]
    for y in range(max(0,up(min(Y1,Y2,Y3))),up(max(Y1,Y2,Y3))):
        for x in range(max(0,up(min(X1,X2,X3))),up(max(X1,X2,X3))):
            if C1+DX12*(y*sub)-DY12*(x*sub)>0 and C2+DX23*(y*sub)-DY23*(x*sub)>0 and C3+DX31*(y*sub)-DY31*(x*sub)>0:
                sx=x+R['cx']; sy=y+R['cy']
                w1=((sx-x0)*(yb-y0)-(xb-x0)*(sy-y0))/den; w2=((xa-x0)*(sy-y0)-(sx-x0)*(ya-y0))/den
                al=math.trunc(a0+w1*(a1-a0)+w2*(a2-a0))
                out.append((x,y,max(0,min(255,al))))
    return out

class Sim:
    def __init__(self,init,R):
        self.R=R; self.L={}
        for l in init['layers']:
            m=np.frombuffer(base64.b64decode(l['map']),dtype=np.uint8).reshape(l['h'],l['w']).astype(np.int64)
            hm=np.frombuffer(base64.b64decode(l['hmap']),dtype=np.uint8).reshape(l['h'],l['w']).astype(np.int64)
            self.L[l['i']]=dict(map=m,hmap=hm,thr=l['thr'],delta=l['delta'],cthr=l['cthr'],w=l['w'],h=l['h'])
        self.pending=[]; self.inframe=False; self.unknown=set(); self.tab={}
        self.phm=math.lcm(*[m for (_,m) in R['byphase']]) if R.get('byphase') else (2 if ('par' in R or 'par4' in R or 'ovr4' in R or 'par16' in R or 'par32' in R) else 0)
    def event(self,e):
        k=e['k']
        if k=='q':
            b=e['blend']&0x7e1
            if e['stages']==1 and b==0x101 and e['gens']==0: self.pending=[]; self.inframe=True; return   # the black quad: a layer's frame starts
            if not self.inframe: return
            self.pending.append(e)
        elif k in('s','m'):
            if self.inframe: self.pending.append(e)
        elif k=='c':
            if e['layer']>=0 and self.inframe: self.frame(self.L[e['layer']],self.pending)
            self.pending=[]; self.inframe=False
    def frame(self,L,evs):
        R=self.R; m=L['map']; hm=L['hmap']; H,W=m.shape
        drawn=False
        for e in evs:
            k=e['k']
            if k=='q':
                b=e['blend']&0x7e1
                if e['stages']==2:      # the layer's own map, fading: values under cthr lose delta
                    m=np.where(m<L['cthr'],np.maximum(m-L['delta'],0),m); drawn=True
                elif e['stages']==1 and b==0x401 and e['gens']==1:   # no goop where there is no ground (height over the register's)
                    m=np.where(hm>e['reg'][11],0,m)
                elif e['stages']==1 and (b==0x4a1) and e['gens']==0:  # a revival stamp: the material's colour and alpha over its quad
                    x1,y1,x2,y2=[int(v) for v in e['q']]; x1=max(0,x1); y1=max(0,y1); x2=min(W,x2); y2=min(H,y2)
                    if x2>x1 and y2>y1:
                        a=e['col'][3]; blk=m[y1:y2,x1:x2]; m[y1:y2,x1:x2]=blend(e['col'][0],blk,np.full(blk.shape,a,dtype=np.int64),R)
                else: self.unknown.add((e['stages'],hex(e['blend']),e['gens']))
            elif k=='s':
                x1,y1,x2,y2=[int(v) for v in e['q']]
                if e['tex'] not in TEXN: self.unknown.add(('stamp texture',hex(e['tex']))); continue
                ph=(x1,y1) if 'abs' in R else (x1%self.phm,y1%self.phm) if self.phm else (0,0)
                key=(e['tex'],x2-x1,y2-y1,ph); a=self.tab.get(key)
                if a is None: a=self.tab[key]=stamp_alpha(e['tex'],(0,0,x2-x1,y2-y1),R,ph)
                # clip to the map
                cx1=max(0,x1); cy1=max(0,y1); cx2=min(W,x2); cy2=min(H,y2)
                if cx2<=cx1 or cy2<=cy1: continue
                a=a[cy1-y1:cy2-y1,cx1-x1:cx2-x1]
                hh=hm[cy1:cy2,cx1:cx2]; a=np.where((hh>e['c0'])&(hh<e['c1']),a,0)
                d=m[cy1:cy2,cx1:cx2]; c=a if e['type']==0 else np.full(a.shape,255,dtype=np.int64)
                m[cy1:cy2,cx1:cx2]=blend(c,d,a,R)
            elif k=='m':
                if (e['blend']&0x7e1)!=0x4a1: self.unknown.add(('m',hex(e['blend']))); continue
                ck=(R['sub'],R['mid'],R['snap'],R['cx'],R['cy']); c=e.get('_px')
                if c is None or c[0]!=ck: c=(ck,tri_pixels(e['v'],R)); e['_px']=c      # (kept: the same for every rule of the stamps)
                for x,y,al in c[1]:
                    if 0<=x<W and 0<=y<H and al: m[y,x]=int(blend(np.int64(255),m[y,x],np.int64(al),R))
        L['map']=m

# Where a replay stopped, the game's own verdict of that tick isn't the console's: what the console had instead
# (worked out from which rand() call was the odd one), by capture: {tick: [(layer, x, z, goop there on the console)]}
FAILED={'cap_b1':{4532:[(0,199,114,False)]},'cap_b5':{3457:[(0,292,294,True)]},'cap_pv1':{1688:[(0,116,444,True)]}}   # (captures of Bianco Hills 1 to tick 4,533 and Bianco Hills 5 to 3,457)

def evaluate(init,ev,R,upto=None,verbose=False,failed=None):
    """(tests that disagree, the first's tick, tests checked)"""
    S=Sim(init,R); bad=0; first=None; n=0; grp={}; cur=None; detail=[]
    for e in ev:
        k=e['k']
        if upto is not None and e.get('t',0)>upto: break
        if k in('q','s','m','c'): S.event(e)
        elif k=='t':
            L=S.L[e['layer']]; inside=0<=e['x']<L['w'] and 0<=e['z']<L['h']
            val=int(L['map'][e['z'],e['x']]) if inside else -1
            mine=bool(e['hok'] and val>L['thr']); theirs=bool(e['hok'] and e['val']>L['thr'])
            if e['ctx']=='A':
                # (the fifth try of an action is no evidence: polluted or not, the same number of rand() calls follows)
                if e['n']>=4 and not (failed and e['t'] in failed): continue
                if failed and e['t'] in failed:
                    o=[f for f in failed[e['t']] if f[0]==e['layer'] and f[1]==e['x'] and f[2]==e['z']]
                    if not o: continue
                    theirs=o[0][3]
                n+=1
                if mine!=theirs:
                    bad+=1
                    if first is None: first=e['t']
                    if verbose and len(detail)<12: detail.append((e['t'],e['layer'],e['x'],e['z'],'console',e['val'],'here',val))
            else:
                g=grp.setdefault(e['group'],[[]]); g[-1].append(mine)
        elif k=='p': grp.setdefault(e['group'],[]).append([])
        elif k=='g':
            g=grp.pop(e['group'],None)
            if g:
                places=[p for p in g if p is not None]
                mine=all(any(p) for p in places) if len(places)>=9 else None
                if mine is not None:
                    n+=1
                    if mine!=bool(e['dirty']):
                        bad+=1
                        if first is None: first=e['t']
                        if verbose and len(detail)<12: detail.append((e['t'],'mario dirty: console',e['dirty'],'here',mine))
    return bad,first,n,detail,S

if __name__=='__main__':
    init,ev=load(sys.argv[1])
    bad,first,n,detail,S=evaluate(init,ev,GX,verbose=True,failed=FAILED.get(os.path.basename(sys.argv[1]).split('.')[0]))
    print(n,'tests;',bad,'disagree; first at tick',first)
    for d in detail: print('  ',d)
    if S.unknown: print('draws not understood:',S.unknown)
