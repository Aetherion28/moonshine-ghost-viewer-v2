# a model stamp's triangle at a pixel: is the pixel covered, and the interpolated alpha, under a rule
import math
def edge(ax,ay,bx,by,px,py): return (bx-ax)*(py-ay)-(by-ay)*(px-ax)
def covered_float(tri,px,py,cx,cy):
    (x0,y0,_),(x1,y1,_),(x2,y2,_)=tri; sx=px+cx; sy=py+cy
    e0=edge(x0,y0,x1,y1,sx,sy); e1=edge(x1,y1,x2,y2,sx,sy); e2=edge(x2,y2,x0,y0,sx,sy)
    return (e0>0 and e1>0 and e2>0) or (e0<0 and e1<0 and e2<0)
def covered_fixed(tri,px,py,sub,off,rnd):
    """positions in 1/sub pixel (rnd: 'round' or 'floor'), minus off (a number, or one for x and one for y); the
    pixel's own corner is the test point; top-left rule (Dolphin's software renderer: sub 16, off 9, round)"""
    ox,oy=off if isinstance(off,tuple) else (off,off)
    q=(lambda v,o: int(math.floor(sub*v+0.5))-o) if rnd=='round' else (lambda v,o: int(math.floor(sub*v))-o)
    P=[(q(x,ox),q(y,oy)) for x,y,_ in tri]
    # counter-clockwise as the rasteriser wants (y down): make the area sign fixed
    (X1,Y1),(X2,Y2),(X3,Y3)=P
    area=(X2-X1)*(Y3-Y1)-(X3-X1)*(Y2-Y1)
    if area==0: return False
    if area>0: (X2,Y2),(X3,Y3)=(X3,Y3),(X2,Y2)
    DX12=X1-X2; DX23=X2-X3; DX31=X3-X1; DY12=Y1-Y2; DY23=Y2-Y3; DY31=Y3-Y1
    C1=DY12*X1-DX12*Y1; C2=DY23*X2-DX23*Y2; C3=DY31*X3-DX31*Y3
    if DY12<0 or (DY12==0 and DX12>0): C1+=1
    if DY23<0 or (DY23==0 and DX23>0): C2+=1
    if DY31<0 or (DY31==0 and DX31>0): C3+=1
    x=px*sub; y=py*sub
    return C1+DX12*y-DY12*x>0 and C2+DX23*y-DY23*x>0 and C3+DX31*y-DY31*x>0
def alpha(tri,px,py,ax,ay,rnd='trunc'):
    (x0,y0,a0),(x1,y1,a1),(x2,y2,a2)=tri; sx=px+ax; sy=py+ay
    den=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0)
    if den==0: return 0
    w1=((sx-x0)*(y2-y0)-(x2-x0)*(sy-y0))/den; w2=((x1-x0)*(sy-y0)-(sx-x0)*(y1-y0))/den
    v=a0+w1*(a1-a0)+w2*(a2-a0)
    v=math.floor(v+0.5) if rnd=='round' else math.trunc(v)
    return max(0,min(255,v))
def covered(tri,px,py,R):
    m=R.get('cov','dolphin')
    if m=='dolphin': return covered_fixed(tri,px,py,16,9,'round')
    if m=='float': return covered_float(tri,px,py,R['cx'],R['cy'])
    if m=='fixed': return covered_fixed(tri,px,py,R['sub'],R['off'],R.get('snap','floor'))

def snapped(tri,sub,rnd='floor'):
    q=(lambda v: math.floor(sub*v+0.5)/sub) if rnd=='round' else (lambda v: math.floor(sub*v)/sub)
    return [(q(x),q(y),a) for x,y,a in tri]
