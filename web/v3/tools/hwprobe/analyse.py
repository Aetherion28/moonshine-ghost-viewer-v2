# Reads an answer of tools/hwprobe (a console's, or ppc/gx.ts's own from `v3hwprobe.mjs model`) with the script's
# cases, and works out from the grid cases where in each pixel a stamp's texture is taken.
#   python3 -I analyse.py <script.gxps.cases.json> <answer.gxpo> [size ...]
# For every stamp of the ramp textures: the texture coordinate at each pixel (from the coarse ramp, refined by the
# two saw-tooth textures), as the place in the pixel it belongs to: columns (x) from the S textures, rows (y) from T.
import sys,json,struct,collections
import numpy as np

def unrle(s,n):
    d=bytearray(); i=0
    while i<len(s):
        c=s[i]; i+=1
        if c<128: d+=s[i:i+c+1]; i+=c+1
        else: d+=bytes([s[i]])*(c-126); i+=1
    assert len(d)==n; return bytes(d)
def answer(path):
    b=open(path,'rb').read(); assert b[:4]==b'GXPO'
    out=[]; p=16; info=None
    while p+16<=len(b):
        kind,a,bb,ln=struct.unpack('>IIII',b[p:p+16]); data=b[p+16:p+16+ln]; p+=16+((ln+3)&~3)
        if kind==100: info=struct.unpack('>4I',data)
        elif kind==5 or kind==7: out.append(data)
        elif kind==9: out.append(unrle(data,bb))
    return info,out
def i8(data,w,h):
    a=np.frombuffer(data,dtype=np.uint8).reshape((h+3)//4,(w+7)//8,4,8)
    return a.transpose(0,2,1,3).reshape(((h+3)//4)*4,((w+7)//8)*8)[:h,:w].astype(np.int64)
def alpha(R,goop):
    """the stamp's alpha at a texel from the map's value there (goop on a map of 0, cleaning on a map of 255)"""
    R=R.astype(np.int64)
    return np.where(R==0,0,np.where(R>=128,R,R+1)) if goop else np.where(R>=128,255-R,254-R)

def load(cases_path,answer_path):
    cases=json.load(open(cases_path)); info,got=answer(answer_path)
    maps={}
    for i,c in enumerate(cases):
        if 2*i+1<len(got): maps[c['label']]=i8(got[2*i+1],c['w'],c['h'])
    return cases,maps,info

def coords(cases,maps,type_,layout,axis):
    """{(x, y, size): the texture coordinate (texels; None where it can't be read) along S (axis 0) or T (1) at each pixel [row][col]}"""
    A='ST'[axis]; name=lambda v: f"grid {'goop' if type_ else 'clean'} {v} layout {layout}"
    need=[name(f'ramp{A}'),name(f'saw{A}0'),name(f'saw{A}8'),name(f'fine{A}0'),name(f'fine{A}2')]
    if any(n not in maps for n in need): return {}
    c=[q for q in cases if q['label']==need[0]][0]
    M=[alpha(maps[n],type_) for n in need]
    out={}
    for st in c['stamps']:
        x1,y1,x2,y2=map(int,st['q']); size=x2-x1
        r,s0,s8,f0,f2=[m[y1:y2,x1:x2] for m in M]
        u=r/4.0                                   # the coordinate less half a texel, to a quarter texel
        # the 16-a-texel saw (period 16 texels): the phase whose wrap is far from here
        use8=((u%16)>11)|((u%16)<3)
        fr=np.where(use8,((s8-128)%256)/16.0,s0/16.0)       # (u mod 16)
        k=np.round((u-fr)/16.0); u16=16*k+fr
        use2=((u16%4)>2.75)|((u16%4)<0.75)
        fr4=np.where(use2,((f2-128)%256)/64.0,f0/64.0)      # (u mod 4)
        k4=np.round((u16-fr4)/4.0); u64=4*k4+fr4
        out[(x1,y1,size)]=dict(coarse=u+0.5,mid=u16+0.5,fine=u64+0.5)
    return out

if __name__=='__main__':
    cases,maps,info=load(sys.argv[1],sys.argv[2]); sizes=[int(a) for a in sys.argv[3:]]
    print('console:',[hex(v) for v in info] if info else None,'cases answered:',len(maps),'of',len(cases))
    for axis in (0,1):
        print(f"--- the place in the pixel ({'x, from S' if axis==0 else 'y, from T'}) by stamp size, the corner's parity and the pixel's column/row parity: lowest .. highest over the stamps (fine saw)")
        acc=collections.defaultdict(list)
        for type_ in (0,1):
            for layout in (0,1,2):
                for (x1,y1,size),d in coords(cases,maps,type_,layout,axis).items():
                    u=d['fine']; n=size
                    idx=np.arange(n)
                    pos=u*size/64.0-(idx[None,:] if axis==0 else idx[:,None])   # the place in the pixel
                    # (leave out the border, where the texture clamps)
                    lo=int(np.ceil(0.5*size/64+1)); 
                    for j in range(n):
                        for i in range(n):
                            t=i if axis==0 else j
                            if u[j,i]<1.0 or u[j,i]>63.0: continue
                            acc[(size,(x1 if axis==0 else y1)&1,t&1,type_)].append(pos[j,i])
        for key in sorted(acc):
            if sizes and key[0] not in sizes: continue
            v=np.array(acc[key]); print(f"size {key[0]:3d} corner {'odd ' if key[1] else 'even'} pixel {'odd ' if key[2] else 'even'} {'goop ' if key[3] else 'clean'}: {v.min():.4f} .. {v.max():.4f}  mean {v.mean():.4f}  ({len(v)} pixels)")
