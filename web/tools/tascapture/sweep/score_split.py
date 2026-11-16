#!/usr/bin/env python3
"""Score Manta-split logs (sweep/*.txt, 'm <field> ... cam ... | addr x y z v vx vy vz') against the TAS video.
Each live Manta is drawn as a flat world ellipse (700 along its heading, 1100 across, fitted on our own
screenshots vs our own logs), projected with the logged camera; the union is compared (IoU) with the
peach-pixel mask of the video frame for the same field, fields 173196..LAST step 4.
Also: centroid distance (px) and principal-axis angle difference of the masks.
usage: score_split.py [--last 173400] log1.txt log2.txt ...   (default: sweep/bootmlog.txt sweep/smlog_*.txt)"""
import sys,os,glob,math,subprocess
import cv2,numpy as np
H=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,H)
from proj2 import parse,proj; from seg import mask; from model import predmask,excl
LF,LS,DY=700,1100,0
def vframe(f):
    p=os.path.join(H,'vs','%d.png'%f)
    if not os.path.exists(p):
        t=round((f+8)/59.94+3.7-2800,4)
        subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-ss',str(t),'-i',os.path.join(H,'sirena.mp4'),'-frames:v','1','-vf','scale=320:240',p])
    m=excl(mask(cv2.imread(p)))
    n,l,st,_=cv2.connectedComponentsWithStats(m)
    keep=np.zeros_like(m)
    for i in range(1,n):
        if st[i,4]>=450: keep[l==i]=1
    return keep
def stats(m):
    ys,xs=np.nonzero(m)
    if len(xs)<20: return None
    c=np.cov(np.vstack([xs,ys])); w,v=np.linalg.eigh(c)
    return xs.mean(),ys.mean(),math.degrees(math.atan2(v[1,1],v[0,1]))%180
def score(D,fields,V):
    ious=[];cds=[];ads=[]
    keys=sorted(D)
    for f in fields:
        if f>keys[-1]+2 or f<keys[0]-2: continue
        k=min(keys,key=lambda x:abs(x-f)); P,M,ms=D[k]
        pm=excl(predmask(P,M,ms,LF,LS,DY)); vm=V[f]
        u=(pm|vm).sum(); ious.append((pm&vm).sum()/u if u else 0)
        a,b=stats(pm),stats(vm)
        if a and b:
            cds.append(math.hypot(a[0]-b[0],a[1]-b[1])); d=abs(a[2]-b[2])%180; ads.append(min(d,180-d))
    if not ious: return None
    return np.mean(ious),np.mean(cds) if cds else 0,np.mean(ads) if ads else 0,len(ious),(min(keys),max(keys))
def main():
    a=sys.argv[1:]; last=173400
    if a[:1]==['--last']: last=int(a[1]); a=a[2:]
    S=os.path.expanduser('~/mnt/ghosts/_incoming/tas/sweep/')
    logs=a or [S+'bootmlog.txt']+sorted(glob.glob(S+'smlog_*.txt'))
    fields=list(range(173196,last+1,4)); V={f:vframe(f) for f in fields}
    rows=[]
    for p in logs:
        D=parse(p)
        if not D: print('no data',p); continue
        r=score(D,fields,V)
        if r: rows.append((r[0],os.path.basename(p),r))
    rows.sort(key=lambda x:-x[0])
    print('%-22s %6s %7s %7s %4s  %s'%('log','IoU','cent_px','axis_dg','n','fields'))
    for s,n,r in rows: print('%-22s %6.3f %7.1f %7.1f %4d  %d-%d'%(n,r[0],r[1],r[2],r[3],r[4][0],r[4][1]))
if __name__=='__main__': main()
