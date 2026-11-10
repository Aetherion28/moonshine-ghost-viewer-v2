# scans of one or two of a rule's numbers against a capture:  python3 -I scan.py <capture.jsonl>
# (This tool takes one sample point for every pixel, sim.MODEL: the rule before the four points of a 2 x 2 group.)
import sys,os,itertools; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import sim
init,ev=sim.load(sys.argv[1]); F=sim.FAILED.get(os.path.basename(sys.argv[1]).split('.')[0])
def run(**kw):
    R=dict(sim.MODEL,**kw); bad,first,n,d,S=sim.evaluate(init,ev,R,failed=F); return bad,first
def _one(a):
    kw=a; return run(**kw)
def table(px,xs,py,ys,**kw):
    # (two at a time: the machine has two cores)
    from multiprocessing import Pool
    print(f'rows {px}, columns {py} =',[round(y,4) for y in ys],kw or '')
    with Pool(2) as P:
        for x in xs:
            res=P.map(_one,[dict({px:x,py:y},**kw) for y in ys])
            print('%s %.4f '%(px,x),' '.join('%3d@%-4s'%(b,f if f else '-') for b,f in res),flush=True)
if __name__=='__main__':
    print('the model:',run())
    print("Dolphin's sample point (0.495) with the model's grid:",run(dx=0.495,dy=0.495))
    table('dx',[i/48 for i in range(28,36)],'dy',[i/48 for i in range(19,29)])

def sizetable(size,xs,ys,**kw):
    from multiprocessing import Pool
    print(f'stamps {size} pixels wide: rows dx, columns dy =',[round(y,4) for y in ys],kw or '')
    with Pool(2) as P:
        for x in xs:
            res=P.map(_one,[dict(bysize={**kw.get('bysize',{}),size:(x,y)}) for y in ys])
            print('dx %.4f '%x,' '.join('%3d@%-4s'%(b,f if f else '-') for b,f in res),flush=True)
