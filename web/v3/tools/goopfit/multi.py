# Rules against several captures at once (two at a time: the machine has two cores).
#   python3 -I multi.py <capture.jsonl> [<capture.jsonl> ...]     ppc/gx.ts's rule on each
# As a module: caps (name -> (init, events)), run(rule) -> [(tests that disagree, the first's tick)] per capture,
# many(rules, label) prints one line a rule. A capture's open texel (the test its replay stopped on) is sim.FAILED's.
import sys,os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import sim
from multiprocessing import Pool
PATHS=[a for a in sys.argv[1:] if a.endswith('.jsonl')] or [p for p in os.environ.get('CAPS','').split(',') if p]
caps={os.path.basename(p).split('.')[0]:sim.load(p) for p in PATHS}
def run(kw):
    out=[]
    for n,(init,ev) in caps.items():
        bad,first,cnt,d,S=sim.evaluate(init,ev,dict(sim.MODEL,**kw),failed=sim.FAILED.get(n)); out.append((bad,first))
    return out
def many(rules,label=str):
    with Pool(2) as pool:
        for kw,out in zip(rules,pool.imap(run,rules)):
            print(label(kw),' '.join('%d@%s'%o for o in out),'TOTAL',sum(o[0] for o in out),flush=True)
if __name__=='__main__':
    print("ppc/gx.ts's rule:",dict(zip(caps,run(dict(par4=sim.PAR4)))))
