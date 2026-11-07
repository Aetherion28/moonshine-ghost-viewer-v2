import re,os,glob,collections
SIM='/home/claude/moonshine-ghost-viewer-v2/web/src/game'
src={}
for f in glob.glob(SIM+'/**/*.ts',recursive=True): src[f]=open(f).read()
# sim classes: name -> file text
cls={}
for f,s in src.items():
    for m in re.finditer(r'\bclass (\w+)',s): cls.setdefault(m.group(1),[]).append(f)
syms=open('/home/claude/sms-ai-decomp/config/GMSJ01/symbols.txt').read().splitlines()
miss=collections.defaultdict(list)
for l in syms:
    m=re.match(r'(\w+?)__(\d+)T(\w+?)F',l)
    if not m: continue
    meth, n, rest = m.group(1), int(m.group(2)), m.group(3)
    full=('T'+rest)[:n]
    if len(full)!=n: continue
    name=full[1:]
    if name not in cls: continue
    if meth.startswith('__') or meth in ('load','perform','init','loadAfter'): pass
    if meth.startswith('__'): continue
    text=''.join(src[f] for f in cls[name])
    if not re.search(r'\b'+re.escape(meth)+r'\s*[(=:]',text):
        size=int(re.search(r'size:0x([0-9A-F]+)',l).group(1),16)
        miss[name].append((meth,size))
tot=0
for k,v in sorted(miss.items(), key=lambda kv:-sum(s for _,s in kv[1])):
    tot+=len(v); print(k, sum(s for _,s in v), ' '.join(f'{m}:{s:x}' for m,s in v))
print('classes',len(miss),'methods',tot)
