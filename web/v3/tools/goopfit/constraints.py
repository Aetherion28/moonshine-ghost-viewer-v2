# What the recording says about single texels of Bianco Hills 1's goop (a/trace_41726535_80000003.msgt), and a
# score of a sampling / blending rule against all of it. Each entry came from a replay that stopped: the game's
# goop test there (tests/goopdbg.ts POLL=1) names the texel and what the console had (more than 30: goop, or not).
#   python3 -I constraints.py            the rules' grid around the model's sample point
import sys,os,itertools; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import pixel as ev2
DIR=ev2.DIR
# name, pixel, height, last frame drawn before the game's test, what the console had, log
CON=[('A',(80,191),6,1944,'>','wall2.log'),('C',(172,127),13,2564,'<=','wall2.log'),('D',(172,105),13,2568,'<=','wall2.log'),('F',(162,108),11,2612,'<=','wall2.log'),
     ('E1',(165,115),13,2604,'any>','wall2.log'),('E2',(178,118),13,2604,'any>','wall2.log'),('E3',(170,94),13,2604,'any>','wall2.log'),
     ('G',(166,110),13,2588,'<=','wall2.log'),('H',(194,111),13,2660,'<=','wall2.log'),('I',(164,83),13,2948,'<=','wall2.log'),('K',(175,88),13,3232,'>','wall2.log'),('I2',(164,83),13,2952,'>','wall2.log')]
evs={c[0]:ev2.load(DIR+'/'+c[5],'%d,%d'%c[1]) for c in CON}
def Bcase(R):
    out=[]
    for px in [(156,121),(156,120)]:
        v=0
        for i in range(4):
            a=ev2.sample('9a8460',px[0],px[1],(156.0,120.0,160.0,124.0),R); v=ev2.blend(255,v,a,R)
        out.append(v)
    return out
def score(R):
    r={c[0]:ev2.run(evs[c[0]],c[1],c[2],R,tmax=c[3]) for c in CON}
    b=Bcase(R); ok={}
    for c in CON:
        if c[4]=='>': ok[c[0]]=r[c[0]]>30
        elif c[4]=='<=': ok[c[0]]=r[c[0]]<=30
    ok['E']=max(r['E1'],r['E2'],r['E3'])>30; ok['B']=b[0]>30 and b[1]<=30
    return ok,r,b
def show(R,ok,r,b): return ''.join(k if v else k.lower() for k,v in sorted(ok.items()))+' '+' '.join(f"{k}{v}" for k,v in r.items() if k not in('E1','E3'))+f" B{b}"

if __name__=='__main__':
    dys=[i/96 for i in range(40,49)]; dxs=[i/96 for i in range(58,70)]
    print('the constraints a rule fails (* none), blender as Dolphin has it; columns: dy =',[round(d,3) for d in dys])
    for dx in dxs:
        row=''
        for dy in dys:
            ok,r,b=score(dict(dx=dx,dy=dy,q='trunc',fbits=7,brnd='floor',blend=0))
            f=''.join(k.lower() for k,v in sorted(ok.items()) if not v); row+=' %-4s'%(f if f else '*')
        print('dx %.4f'%dx,row)
