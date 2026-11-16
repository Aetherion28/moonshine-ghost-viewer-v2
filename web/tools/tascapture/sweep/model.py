import cv2,numpy as np,math
from proj2 import proj,depth
def predmask(P,M,ms,Lf,Ls,dy,shape=(240,320)):
    m=np.zeros(shape,np.uint8)
    for a,p in ms.items():
        hx,hz=p[3],p[5]; n=math.hypot(hx,hz) or 1; hx/=n; hz/=n
        pts=[]
        for k in range(24):
            th=2*math.pi*k/24; f=Lf*math.cos(th); s=Ls*math.sin(th)
            q=(p[0]+f*hx-s*hz,p[1]+dy,p[2]+f*hz+s*hx)
            if depth(M,q)<50: continue
            pts.append(proj(P,M,q))
        if len(pts)>=3: cv2.fillPoly(m,[np.array(pts,np.int32)],1)
    return m
def excl(m):
    m=m.copy(); m[:22,:110]=0; m[30:118,195:]=0; m[150:,245:]=0; return m
def iou(a,b):
    a=excl(a);b=excl(b); u=(a|b).sum(); return (a&b).sum()/u if u else 0
