# Which single pixels of the stamps the recording fixes: for every pixel of a stamp whose value would be another
# (This tool takes one sample point for every pixel, sim.MODEL: the rule before the four points of a 2 x 2 group.)
# with the sample point elsewhere in a neighbourhood, the stamp is replayed with that other value there; if tests
# then disagree, the recording confirms the model's value at that pixel. A sampling rule must reproduce every
# confirmed value (check.py), which takes no replay.
#   python3 -I tables.py <capture.jsonl> <out.json>
import sys,os,json,itertools; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import numpy as np, sim
from multiprocessing import Pool
init,ev=sim.load(sys.argv[1]); F=sim.FAILED.get(os.path.basename(sys.argv[1]).split('.')[0])
BASE=dict(sim.MODEL,ovr={(0x9a7440,24,4,18):0})
def job(a):
    tex,size,col,row,val=a
    o=dict(BASE['ovr']); o[(tex,size,col,row)]=val; R=dict(BASE,ovr=o)
    bad,first,n,d,S=sim.evaluate(init,ev,R,failed=F); return (tex,size,col,row,val,bad,first)
if __name__=='__main__':
    sizes=sorted({(e['tex'],int(e['q'][2]-e['q'][0])) for e in ev if e['k']=='s' and e['tex'] in sim.TEXN},key=lambda x:(x[0],x[1]))
    if len(sys.argv)>3: sizes=[z for z in sizes if z[1] in [int(v) for v in sys.argv[3].split(',')]]
    jobs=[]; base={}
    for tex,size in sizes:
        m=sim.stamp_alpha(tex,(0,0,size,size),BASE); base[(tex,size)]=m
        alts=[set() for _ in range(size*size)]
        for dx in np.arange(0.25,1.0001,1/32):
            for dy in np.arange(0.125,0.8751,1/32):
                a=sim.stamp_alpha(tex,(0,0,size,size),dict(sim.MODEL,dx=dx,dy=dy))
                for i,(v,mv) in enumerate(zip(a.flat,m.flat)):
                    if v!=mv and abs(int(v)-int(mv))==1: alts[i].add(int(v))
        for i,s in enumerate(alts):
            for v in sorted(s): jobs.append((tex,size,i%size,i//size,v))
    print(len(jobs),'single-pixel changes to try',flush=True)
    out=[]
    with Pool(2) as P:
        for k,r in enumerate(P.imap(job,jobs,chunksize=4)):
            out.append(r)
            if k%50==0: print(k,flush=True); json.dump({'base':{f'{t:x},{s}':base[(t,s)].tolist() for t,s in base},'res':out},open(sys.argv[2],'w'))
    json.dump({'base':{f'{t:x},{s}':base[(t,s)].tolist() for t,s in base},'res':out},open(sys.argv[2],'w'))
    print('done')
