# The goop map's value at one texel, recomputed from everything the game drew there, under a rule for the GPU's
# texture sampling and blending. The draws come from a log of tests/goopdbg.ts with WATCH=x,y (one line a pixel
# drawn, with the stamp's quad, texture and height window); the stamp textures from stamps.ts's dump of the
# user's disc. A rule R: dx, dy (where in a pixel the texture coordinate is taken), q (how it becomes 1/128
# texels: trunc / round), fbits (bits of the bilinear weights), brnd (the bilinear sum's rounding), blend (a
# number: added before the blender's shift; or 'sept' / 'sepr' / '255r' / '255f'), tu, tv (an offset in texels).
# Model stamps (triangles with vertex alpha) keep the alpha of the log, or with cov in R are rasterised from the
# triangles the log has near the pixel (tri.py: cov 'dolphin' / 'float' with cx, cy / 'fixed' with sub, off, snap;
# ax, ay where the colour is taken (else dx, dy); crnd how it becomes a byte).
import os,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import tri
DIR=os.environ.get('GOOPFIT','/tmp/claude-0/ct')
import re,sys,itertools,math
def loadtex():
    T={}; name=None
    for l in open(DIR+'/sim/bti_dump.txt'):
        l=l.rstrip('\n')
        if l.startswith('map/'): name=l; T[name]=[]; continue
        m=re.match(r'\s*(\d+) ([0-9a-f]{128})$',l)
        if m: T[name].append([int(m.group(2)[i*2:i*2+2],16) for i in range(64)])
    return {'9a8460':T['map/pollute.bti'],'9a7440':T['map/clean.bti']}
TEX=loadtex()
def load(path,px):
    L=open(path).read().split('\n'); cur=''; ev=[]
    pat=re.compile(r'\s+px %s uv (\S+),(\S+) (\S+),(\S+) src (\d+),(\d+) dst (\d+) -> (\d+)'%px)
    tpat=re.compile(r'\s+tri %s (.*)$'%px)
    for l in L:
        if l.startswith('  gx@'): cur=l
        mt=tpat.match(l)
        if mt:
            t=int(re.match(r'  gx@(\d+)',cur).group(1)); f=[float(x) for x in mt.group(1).replace(' ',',').split(',')]
            ev.append(dict(t=t,k='T',tri=[(f[i*4],f[i*4+1],f[i*4+3]) for i in range(3)],c=255,a=0,dst=0,new=0,q=None,tex='',c0=0,c1=0,u=0,v=0)); continue
        m=pat.match(l)
        if m:
            t=int(re.match(r'  gx@(\d+)',cur).group(1)); st=re.search(r'stages (\d)',cur); bl=re.search(r'blend (\w+)',cur); b=int(bl.group(1),16) if bl else -1
            q=re.search(r'\(([-\d.]+),([-\d.]+)\)-\(([-\d.]+),([-\d.]+)\)',cur); tex=re.search(r'tex0 (\w+)',cur); c0=re.search(r'c0 (-?\d+)',cur); c1=re.search(r'c1 (-?\d+)',cur)
            if re.search(r'prim (9|a)',cur): k='M'
            elif st and st.group(1)=='2': k='L'
            elif b>=0 and (b&0x7e1)==0x4a1: k='S'
            elif b>=0 and (b&0x7e1)==0x101: k='K'
            else: k='?'
            ev.append(dict(t=t,k=k,c=int(m.group(5)),a=int(m.group(6)),dst=int(m.group(7)),new=int(m.group(8)),q=tuple(float(x) for x in q.groups()) if q else None,tex=tex.group(1) if tex else '',c0=int(c0.group(1)) if c0 else 0,c1=int(c1.group(1)) if c1 else 0,u=int(m.group(1)),v=int(m.group(2))))
    return ev
f32=lambda x: __import__('struct').unpack('f',__import__('struct').pack('f',x))[0]
def sample(tex,px,py,q,R):
    """the stamp texture's value at a pixel under rule R"""
    x1,y1,x2,y2=q; s=x2-x1; T=TEX[tex]
    u=(px-x1+R['dx'])*64.0/s; v=(py-y1+R['dy'])*64.0/(y2-y1)
    if R['q']=='trunc': su=int(u*128); sv=int(v*128)
    else: su=int(math.floor(u*128+0.5)); sv=int(math.floor(v*128+0.5))
    su-=64-int(round(R.get('tu',0)*128)); sv-=64-int(round(R.get('tv',0)*128))
    iu=su>>7; iv=sv>>7; fu=su&127; fv=sv&127
    fb=R['fbits']
    if fb<7: fu=(fu>>(7-fb))<<(7-fb); fv=(fv>>(7-fb))<<(7-fb)
    def at(x,y): return T[min(63,max(0,y))][min(63,max(0,x))]
    acc=at(iu,iv)*(128-fu)*(128-fv)+at(iu+1,iv)*fu*(128-fv)+at(iu,iv+1)*(128-fu)*fv+at(iu+1,iv+1)*fu*fv
    if R['brnd']=='floor': return acc>>14
    if R['brnd']=='round': return (acc+8192)>>14
    if R['brnd']=='sep':   # each axis rounded apart
        a=(at(iu,iv)*(128-fu)+at(iu+1,iv)*fu+64)>>7; b=(at(iu,iv+1)*(128-fu)+at(iu+1,iv+1)*fu+64)>>7; return (a*(128-fv)+b*fv+64)>>7
    if R['brnd']=='sepf':
        a=(at(iu,iv)*(128-fu)+at(iu+1,iv)*fu)>>7; b=(at(iu,iv+1)*(128-fu)+at(iu+1,iv+1)*fu)>>7; return (a*(128-fv)+b*fv)>>7
def blend(c,d,a,R):
    m=R['blend']
    if m=='255r': return min(255,(c*a+d*(255-a)+127)//255)
    if m=='255f': return min(255,(c*a+d*(255-a))//255)
    sf=a+(a>>7); df=(255-a)+((255-a)>>7)
    if m=='sept': return min(255,((c*sf)>>8)+((d*df)>>8))
    if m=='sepr': return min(255,((c*sf+128)>>8)+((d*df+128)>>8))
    return min(255,(c*sf+d*df+m)>>8)
def run(ev,px,h,R,tmax=10**9,thr=50,delta=8,check=False):
    x,y=px; v=None; t0=None; layer=-1; bad=0
    for e in ev:
        t=e['t']
        if t>tmax: break
        if t!=t0: t0=t; layer=-1
        k=e['k']
        if k=='K':
            layer+=1
            if layer==0 and v is not None and v<thr: v=max(0,v-delta)
            continue
        if layer!=0: continue
        if k=='L':
            if v is None: v=e['new']
            continue
        if v is None: v=0                        # (no layer draw seen yet: the texel was 0, which the layer's alpha test drops)
        if k=='T':
            if 'cov' not in R: continue          # (the log's own model stamps are used)
            if not tri.covered(e['tri'],x,y,R): continue
            c=255; a=tri.alpha(tri.snapped(e['tri'],R['asnap'],R.get('snap','floor')) if 'asnap' in R else e['tri'],x,y,R.get('ax',R['dx']),R.get('ay',R['dy']),R.get('crnd','trunc'))
        elif k=='M':
            if 'cov' in R: continue              # (recomputed from the triangles)
            c,a=e['c'],e['a']
        else:
            win=e['c0']<h<e['c1']
            ta=sample(e['tex'],x,y,e['q'],R) if win else 0
            a=ta; c=ta if e['tex']=='9a7440' else 255
            if check and (a!=e['a'] or c!=e['c']):
                bad+=1
                if bad<4: print('   differs from the log',e['t'],e['q'],e['tex'],'log',e['c'],e['a'],'here',c,a,'win',win)
        v=blend(c,v,a,R)
    return v
