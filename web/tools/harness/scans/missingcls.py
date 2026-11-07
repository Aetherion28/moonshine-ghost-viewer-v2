import re,glob,collections
SIM='/home/claude/moonshine-ghost-viewer-v2/web/src'
txt=''.join(open(f).read() for f in glob.glob(SIM+'/**/*.ts',recursive=True))
simcls=set(re.findall(r'\bclass (\w+)',txt))
D=collections.defaultdict(int); files={}
for l in open('/home/claude/sms-ai-decomp/config/GMSJ01/symbols.txt'):
    m=re.match(r'\w+?__(\d+)T(\w+?)F',l)
    if not m: continue
    n=int(m.group(1)); full=('T'+m.group(2))[:n]
    if len(full)!=n: continue
    s=re.search(r'size:0x([0-9A-F]+)',l); D[full]+=int(s.group(1),16) if s else 0
out=[(v,k) for k,v in D.items() if k[1:] not in simcls and not re.search(re.escape(k[1:]),txt)]
out.sort(reverse=True)
for v,k in out: print(k,v)
print('classes',len(out),'bytes',sum(v for v,_ in out))
