# a random search of a rule's numbers in given ranges:  python3 -I search.py <capture.jsonl> <n> name=lo:hi ...
# (This tool takes one sample point for every pixel, sim.MODEL: the rule before the four points of a 2 x 2 group.)
import sys,os,random; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import sim
from multiprocessing import Pool
init,ev=sim.load(sys.argv[1]); F=sim.FAILED.get(os.path.basename(sys.argv[1]).split('.')[0])
def job(kw):
    bad,first,n,d,S=sim.evaluate(init,ev,dict(sim.MODEL,**kw),failed=F); return bad,first,kw
if __name__=='__main__':
    n=int(sys.argv[2]); rng={a.split('=')[0]:tuple(float(x) for x in a.split('=')[1].split(':')) for a in sys.argv[3:]}
    random.seed(int(os.environ.get('SEED','1')))
    jobs=[{k:random.uniform(*v) for k,v in rng.items()} for _ in range(n)]
    best=[]
    with Pool(2) as P:
        for bad,first,kw in P.imap_unordered(job,jobs,chunksize=8):
            best.append((bad,first,kw))
    best.sort(key=lambda x:(x[0],-(x[1] or 99999)))
    import collections
    print(collections.Counter(b[0] for b in best).most_common(6))
    for b in best[:25]: print(b[0],b[1],{k:round(v,4) for k,v in b[2].items()})
