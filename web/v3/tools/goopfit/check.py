# A sampling rule against the stamp pixels the recording fixed (tables.py's result): no replay needed.
# (This tool takes one sample point for every pixel, sim.MODEL: the rule before the four points of a 2 x 2 group.)
#   python3 -I check.py <capture.jsonl> <tables.json>
import sys,os,json; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import numpy as np, sim
def facts(path):
    d=json.load(open(path)); F={}
    for key,base in d['base'].items():
        tex,size=key.split(','); F[(int(tex,16),int(size))]=dict(base=np.array(base),bad=set())
    for tex,size,col,row,val,bad,first in d['res']:
        if bad: F[(tex,size)]['bad'].add((col,row,val))
    return F
def conflicts(F,R):
    """the pixels where the rule gives a value the recording refutes: [(tex, size, col, row, the rule's, the base's)]"""
    out=[]
    for (tex,size),f in F.items():
        a=sim.stamp_alpha(tex,(0,0,size,size),R)
        for col,row,val in f['bad']:
            v=int(a[row,col]); b=int(f['base'][row,col])
            # refuted: the value val at this pixel (one step from the base); anything further on that side counts too
            if (val<b and v<=val) or (val>b and v>=val): out.append((tex,size,col,row,v,b))
    return out
if __name__=='__main__':
    sim.load(sys.argv[1]); F=facts(sys.argv[2])
    print({k:len(v['bad']) for k,v in F.items()})
    for name,kw in [('the model',{}),('dx .55 dy .57',dict(dx=.55,dy=.57)),('dx .5 dy .5833',dict(dx=.5,dy=.5833)),('dx .5833 dy .5833',dict(dx=.5833,dy=.5833))]:
        c=conflicts(F,dict(sim.MODEL,**kw)); print(name,len(c),sorted((x[2],x[3],x[4],x[5]) for x in c if x[1]==24)[:40])
