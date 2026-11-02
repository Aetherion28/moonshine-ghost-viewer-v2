#!/usr/bin/env python3
"""The regional code checklist: every version branch in the public decomp that the viewer has to follow.

The decomp is one source tree shared by its regional repositories (Aetherion28/SMS-Decomp-JP-1.0, -JP-1.1,
-US, -KOR, -PAL, -3DAS); every change between releases is behind a VERSION_* check. This lists each
such branch in game code, the viewer files that implement the function it sits in, and its status
from region-status.json, and writes REGIONS.md next to the viewer's README.

It also reads each regional repository's assets/regional-comparison.csv (the ORIGINAL binaries
compared function by function with JP 1.0) and progress-report.json (how much of that region the
decomp has byte-matched), to list the functions the viewer ports that differ in some region's
binary: the evidence, independent of the decomp's source, of what still needs looking at.

    python3 web/tools/region-branches.py --decomp ../pub   # the folder holding the SMS-Decomp-* clones

Standard library only.
"""
import argparse, collections, csv, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.normpath(os.path.join(HERE, '..', 'src'))
REPOS = {'US': 'GMSE01', 'KOR': 'GMSE01 (KR)', 'PAL': 'GMSP01', 'JP-1.1': 'GMSJ01_01', '3DAS': 'GMSP01_NX'}
SKIP_UNITS = ('JSystem', 'dolphin', 'TRK_MINNOW_DOLPHIN', 'PowerPC_EABI_Support', 'THPPlayer', 'OdemuExi2')


def branches(root):
    """Every #if/#ifdef/#ifndef/#elif that names a VERSION_ macro, and every inline VERSION_SELECT / GMSxx()."""
    out = []
    for top in ('src', 'include'):
        for d, _, fs in os.walk(os.path.join(root, top)):
            for f in sorted(fs):
                if not f.endswith(('.cpp', '.hpp', '.h')):
                    continue
                p = os.path.join(d, f)
                rel = os.path.relpath(p, root).replace(os.sep, '/')
                L = open(p, encoding='utf-8', errors='replace').read().split('\n')

                def enclosing(i):
                    for j in range(i, -1, -1):
                        s = L[j]
                        if s and not s[0].isspace() and not s.startswith(('#', '//', '}', '{')) and '(' in s and not s.rstrip().endswith(';'):
                            m = re.match(r'^[^(]*?([~\w]+(?:::[~\w]+)*)\s*\(', s)
                            if m:
                                return m.group(1)
                        if s.startswith('}') and j < i:
                            return None
                    return None
                stack = []
                for i, s in enumerate(L):
                    t = s.strip()
                    m = re.match(r'#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)', t)
                    if m:
                        d2, cond = m.group(1), m.group(2).strip()
                        if d2 in ('if', 'ifdef', 'ifndef'):
                            stack.append({'v': 'VERSION_' in cond, 'start': i, 'cond': f'#{d2} {cond}'})
                        elif d2 == 'elif' and stack and 'VERSION_' in cond:
                            stack[-1]['v'] = True
                        elif d2 == 'endif' and stack:
                            b = stack.pop()
                            if b['v']:
                                out.append({'file': rel, 'line': b['start'] + 1, 'fn': enclosing(b['start']), 'cond': b['cond']})
                        continue
                    if not t.startswith('#') and re.search(r'VERSION_SELECT\(|\bGMS[JEP]01(?:_01|_NX)?\(', s):
                        out.append({'file': rel, 'line': i + 1, 'fn': enclosing(i), 'cond': 'VERSION_SELECT'})
    return out


def viewer_sources():
    src = {}
    for d, _, fs in os.walk(VIEWER):
        for f in fs:
            if f.endswith('.ts'):
                p = os.path.join(d, f)
                src[os.path.relpath(p, VIEWER).replace(os.sep, '/')] = open(p, encoding='utf-8').read()
    return src


def ported_in(src, fn):
    """Viewer files that name this function (Class::method in a comment, or the method with its class)."""
    if not fn:
        return []
    parts = fn.split('::')
    name, cls = parts[-1], (parts[-2] if len(parts) > 1 else None)
    hits = [f for f, t in src.items() if fn in t]
    if not hits and len(name) > 5 and not name.startswith('~'):
        pat = re.compile(r'\b' + re.escape(name) + r'\s*\(')
        hits = [f for f, t in src.items() if pat.search(t)]
        if cls:
            base = cls[1:] if cls.startswith('T') else cls
            hits = [f for f in hits if re.search(re.escape(base), src[f], re.I)]
    return sorted(set(hits))


def category(b):
    f = b['file']
    if '/GC2D/' in f or f.startswith(('include/GC2D', 'include/version.h')):
        return 'menus / 2D'
    if '/MSound/' in f or 'MSoundMainSide' in f:
        return 'sound'
    if any(k in f for k in ('RenderModeObj', 'Resolution', 'GCLogoDir', 'CardManager', 'ProcessMeter', 'marerr', 'MovieDirector', 'Application')):
        return 'system / video'
    return 'game'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--decomp', required=True, help='folder holding the SMS-Decomp-* clones')
    ap.add_argument('--out', default=os.path.normpath(os.path.join(HERE, '..', '..', 'REGIONS.md')))
    a = ap.parse_args()
    shared = os.path.join(a.decomp, 'SMS-Decomp-PAL')
    status = json.load(open(os.path.join(HERE, 'region-status.json'), encoding='utf-8'))
    src = viewer_sources()
    B = branches(shared)
    rows = collections.defaultdict(list)
    counts = collections.Counter()
    for b in B:
        key = f"{b['file']}:{b['line']}"
        cat = category(b)
        st = status.get(key)
        v = ported_in(src, b['fn']) if cat != 'menus / 2D' else []
        if not st:
            st = 'not simulated' if not v else 'todo'
        b.update(cat=cat, status=st, viewer=v)
        rows[cat].append(b)
        counts[(cat, st.split(':')[0])] += 1

    # the original binaries: functions the viewer ports that differ from JP 1.0 in some region
    changed = collections.defaultdict(dict)
    for repo, ver in REPOS.items():
        d = os.path.join(a.decomp, f'SMS-Decomp-{repo}', 'assets')
        if not os.path.exists(os.path.join(d, 'regional-comparison.csv')):
            continue
        rep = json.load(open(os.path.join(d, 'progress-report.json'), encoding='utf-8'))
        fm = {}
        for u in rep['units']:
            for fn in u.get('functions', []):
                fm[(u['name'].replace('mario/', ''), fn['name'])] = fn.get('fuzzy_match_percent', 0)
        for x in csv.DictReader(open(os.path.join(d, 'regional-comparison.csv'), encoding='utf-8')):
            if x['status'] not in ('changed', 'not_paired') or x['unit'].split('/')[0] in SKIP_UNITS or x['unit'].startswith('GC2D'):
                continue
            changed[(x['unit'], x['name'])][repo] = (x['status'], fm.get((x['unit'].rsplit('.', 1)[0], x['name'])))

    L = ['# Regional code in the viewer', '',
         'Generated by `web/tools/region-branches.py` from the public decomp (one source tree shared by',
         '[JP 1.0](https://github.com/Aetherion28/SMS-Decomp-JP-1.0), [JP 1.1](https://github.com/Aetherion28/SMS-Decomp-JP-1.1),',
         '[US](https://github.com/Aetherion28/SMS-Decomp-US), [KOR](https://github.com/Aetherion28/SMS-Decomp-KOR),',
         '[PAL](https://github.com/Aetherion28/SMS-Decomp-PAL) and [3DAS](https://github.com/Aetherion28/SMS-Decomp-3DAS)).',
         'Status overrides live in `web/tools/region-status.json`; regenerate after changing it.', '',
         'A ghost runs the code of the build it was played on: its game ID and disc revision (`src/game/version.ts`).',
         'Branches are written in the viewer exactly as the decomp writes them: `#if !defined(VERSION_GMSJ01)` is `if (!V.GMSJ01)`.', '',
         '## Summary', '', '| Area | Status | Branches |', '|---|---|---|']
    for (cat, st), n in sorted(counts.items()):
        L.append(f'| {cat} | {st} | {n} |')
    for cat in ('game', 'system / video', 'sound', 'menus / 2D'):
        L += ['', f'## {cat}', '', '| Decomp | Function | Condition | Viewer | Status |', '|---|---|---|---|---|']
        for b in sorted(rows[cat], key=lambda b: (b['file'], b['line'])):
            url = f"https://github.com/Aetherion28/SMS-Decomp-PAL/blob/main/{b['file']}#L{b['line']}"
            L.append(f"| [{b['file']}:{b['line']}]({url}) | `{b['fn'] or '(file scope)'}` | `{b['cond'][:60]}` | {', '.join(b['viewer'][:3]) or '-'} | {b['status']} |")
    L += ['', '## Functions the viewer ports that differ in an original binary', '',
          'From each repository\'s `assets/regional-comparison.csv` (the original executables against JP 1.0) and',
          '`assets/progress-report.json` (the decomp\'s match in that region). A changed function with no version',
          'branch in its own body differs through an inlined callee, a constant, or code not yet matched there.', '',
          '| Unit | Function | ' + ' | '.join(REPOS) + ' |', '|---|---|' + '---|' * len(REPOS)]
    for (unit, name), per in sorted(changed.items()):
        mname = re.match(r'^(.+?)__', name)
        short = mname.group(1) if mname else name
        if not any(re.search(r'\b' + re.escape(short) + r'\b', t) for t in src.values()) or len(short) < 5:
            continue
        cells = []
        for repo in REPOS:
            if repo in per:
                st, m = per[repo]
                cells.append(f"{'changed' if st == 'changed' else 'new'} ({m:.0f}%)" if m is not None else st)
            else:
                cells.append('')
        L.append(f'| {unit} | `{name[:70]}` | ' + ' | '.join(cells) + ' |')
    open(a.out, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(f'{len(B)} branches; wrote {a.out}')
    for (cat, st), n in sorted(counts.items()):
        print(f'  {cat:15} {st:15} {n}')


if __name__ == '__main__':
    main()
