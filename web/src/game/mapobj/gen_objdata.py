#!/usr/bin/env python3
"""Generates objdata.ts: the map objects' data table (sObjDataTable, MoveBG/MapObjInit.cpp) from
the decomp, with the actor types and hit categories resolved to numbers.

    python3 gen_objdata.py /path/to/sms-ai-decomp > objdata.ts
"""
import json, re, sys

root = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/sms-ai-decomp'
src = open(root + '/src/MoveBG/MapObjInit.cpp', encoding='utf-8').read()
src = re.sub(r'//[^\n]*', '', src)
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)

# ---- enum values (ActorTypes.hpp)
consts = {}
at = open(root + '/include/Strategic/ActorTypes.hpp', encoding='utf-8').read()
at = re.sub(r'//[^\n]*', '', at)
for m in re.finditer(r'\b([A-Z][A-Z0-9_]*)\s*=\s*([^,\n}]+)', at):
    name, expr = m.group(1), m.group(2).strip()
    e = re.sub(r'\b([A-Z][A-Z0-9_]*)\b', lambda k: str(consts.get(k.group(1), 0)), expr)
    try:
        consts[name] = eval(e)
    except Exception:
        pass


# ---- the sound effect IDs (MSound/SoundEffects.hpp)
se = open(root + '/include/MSound/SoundEffects.hpp', encoding='utf-8').read()
se = re.sub(r'//[^\n]*', '', se)
for m in re.finditer(r'\b(MSD_SE_[A-Z0-9_]+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)', se):
    consts[m.group(1)] = int(m.group(2), 0)


def s32(v):
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v & 0x80000000 else v


def value(tok):
    tok = ' '.join(tok.split())
    if tok in ('nullptr', 'NULL'):
        return None
    if tok.startswith('"'):
        return json.loads(tok)
    if tok.startswith('&'):
        return {'ref': tok[1:].strip()}
    if re.fullmatch(r'[A-Za-z_]\w*', tok) and tok not in consts:
        return {'ref': tok}
    t = re.sub(r'(\d)[fF]\b', r'\1', tok)
    t = re.sub(r'\b([A-Z][A-Z0-9_]*)\b', lambda k: str(consts.get(k.group(1), 0)), t)
    try:
        v = eval(t)
    except Exception:
        return {'expr': tok}
    return v


def parse_init(s, i):
    """A brace initializer at s[i] == '{': nested lists of values."""
    assert s[i] == '{'
    i += 1
    out, cur = [], ''
    while True:
        c = s[i]
        if c == '{':
            sub, i = parse_init(s, i)
            out.append(sub)
            cur = None
            continue
        if c == '"':
            j = i + 1
            while s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            if cur is None:
                cur = ''
            cur += s[i:j + 1]
            i = j + 1
            continue
        if c in ',}':
            if cur is not None and cur.strip():
                out.append(value(cur))
            cur = ''
            i += 1
            if c == '}':
                return out, i
            continue
        if cur is None:
            cur = ''
        cur += c
        i += 1


defs = {}
for m in re.finditer(r'(?:static\s+)?(?:const\s+)?(TMapObj\w+)\s*\*?\s+([\w:]+)\s*(\[\s*\])?\s*=\s*', src):
    kind, name, arr = m.group(1), m.group(2), m.group(3)
    i = m.end()
    if src[i] != '{':
        continue
    val, _ = parse_init(src, i)
    defs[name] = (kind, bool(arr), val)


def flat(v):
    # `= { a, b }` for a struct, `= { { a, b }, ... }` for an array of them
    return v


def get(name):
    return defs[name][2] if name in defs else None


def anim_info(r):
    if r is None:
        return None
    n, mx, ents = get(r['ref'])
    entries = []
    if ents is not None:
        for e in get(ents['ref']) or []:
            entries.append({'bmd': e[0], 'anm': e[1], 'type': e[2], 'unkC': e[3], 'bas': e[4]})
    return {'num': n, 'max': mx, 'entries': entries[:n] if n else entries}


def hit_info(r):
    if r is None:
        return None
    n, filt, unk8, tab = get(r['ref'])
    t = get(tab['ref'])
    if t and not isinstance(t[0], list):
        t = [t]
    rows = [[float(x) for x in row] for row in (t or [])]
    return {'num': n, 'filter': s32(filt), 'unk8': float(unk8), 'entries': rows}


def col_info(r):
    if r is None:
        return None
    n, mx, ents = get(r['ref'])
    e = get(ents['ref'])
    if e and not isinstance(e[0], list):
        e = [e]
    return {'num': n, 'max': mx, 'entries': [{'file': x[0], 'flags': x[1]} for x in e[:n]]}


def phys_info(r):
    if r is None:
        return None
    a, data, wall = get(r['ref'])
    d = get(data['ref'])
    return {'data': [float(x) for x in d], 'wall': wall}


def sink(r):
    if r is None:
        return None
    d = get(r['ref'])
    return {'sink': float(d[0]), 'recover': float(d[1])}


def hold(r):
    if r is None:
        return None
    d = get(r['ref'])
    return {'bmd': d[0], 'joint': d[1]}


def sound(r):
    if r is None:
        return None
    n, data = get(r['ref'])
    d = get(data['ref']) if data else None
    if d and len(d) == 1 and isinstance(d[0], list):
        d = d[0]
    return [s32(x) if isinstance(x, int) else -1 for x in (d or [])][:n]


def move(r):
    if r is None:
        return None
    d = get(r['ref'])
    return {'bck': d[0]}


table = []
for ref in get('sObjDataTable'):
    d = get(ref['ref'])
    table.append({
        'name': d[0], 'type': s32(d[1]) if d[1] is not None else 0, 'manager': d[2], 'group': d[3],
        'anim': anim_info(d[4]), 'hit': hit_info(d[5]), 'col': col_info(d[6]),
        'sound': sound(d[7]), 'physical': phys_info(d[8]), 'sink': sink(d[9]), 'hold': hold(d[10]), 'move': move(d[11]),
        'unk30': float(d[12]), 'flags': d[13],
    })

print('// sObjDataTable (MoveBG/MapObjInit.cpp): every map object\'s data, by its individual name.')
print('// Generated by gen_objdata.py from the decomp; don\'t edit by hand.')
print('/* eslint-disable */')
print('import type { MapObjData } from \'./types.js\';')
print('export const OBJ_DATA: MapObjData[] = ' + json.dumps(table, ensure_ascii=False, separators=(',', ':')) + ';')
