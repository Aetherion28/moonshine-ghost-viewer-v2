// scene.bin (JDrama's object tree) as a flat object list, with the helpers the converters read
// payloads with (tools/scene_bin.py, prm.py, spc.py, npc_payload.py, build_objects' _lstr / actor_tail).
import { Bytes, u16, u32, s32, f32, ascii } from './bin.js';

const SJIS = new TextDecoder('shift_jis');
const sj = (b: Bytes) => SJIS.decode(b);

export interface SceneObj { type: string; name: string; hash: number; payload: Bytes; path: string[]; ptypes: string[]; orbit?: any }

function lenStr(d: Bytes, o: number): [string, number] { const ln = u16(d, o + 2); return [sj(d.subarray(o + 4, o + 4 + ln)), o + 4 + ln]; }
function looksLikeObject(d: Bytes, o: number, end: number) {
    if (o + 12 > end) return false;
    const size = u32(d, o);
    if (size < 12 || o + size > end) return false;
    const ln = u16(d, o + 6);
    if (ln === 0 || ln > 64 || o + 8 + ln > end) return false;
    for (let i = 0; i < ln; i++) { const c = d[o + 8 + i]; if (!((c >= 48 && c < 123) || c === 95)) return false; }
    return true;
}
export function parseScene(d: Bytes): SceneObj[] {
    const objects: SceneObj[] = [];
    const walk = (o: number, path: string[], ptypes: string[]): number => {
        const size = u32(d, o);
        const [typ, p0] = lenStr(d, o + 4);
        const nameHash = u16(d, p0);
        const [name, p] = lenStr(d, p0);
        const end = o + size;
        for (const lead of [0, 4]) {
            let q = p + lead;
            if (q + 4 <= end) {
                const cnt = u32(d, q);
                if (cnt > 0 && cnt < 5000 && looksLikeObject(d, q + 4, end)) {
                    q += 4;
                    for (let i = 0; i < cnt; i++) { if (!looksLikeObject(d, q, end)) break; q = walk(q, [...path, name], [...ptypes, typ]); }
                    return end;
                }
            }
        }
        objects.push({ type: typ, name, hash: nameHash, payload: d.subarray(p, end), path, ptypes });
        return end;
    };
    walk(0, [], []);
    return objects;
}

/** position, rotation (degrees), scale; null when the payload is too short or not numbers */
export function placement(payload: Bytes): [number[], number[], number[]] | null {
    if (payload.length < 36) return null;
    const v = Array.from({ length: 9 }, (_, i) => f32(payload, i * 4));
    if (v.some((x) => Math.abs(x) > 1e7 || x !== x)) return null;
    return [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)];
}

/** Python's str.isprintable */
const NONPRINT = /[\p{C}\p{Zl}\p{Zp}]/u, SPACESEP = /\p{Zs}/u;
export const isPrintable = (s: string) => { for (const ch of s) if (NONPRINT.test(ch) || (ch !== ' ' && SPACESEP.test(ch))) return false; return true; };

export function stringsAfter(payload: Bytes, start = 36): string[] {
    const out: string[] = [];
    let o = start;
    while (o + 4 <= payload.length) {
        const ln = u16(payload, o + 2);
        if (ln > 0 && ln < 80 && o + 4 + ln <= payload.length) {
            const s = payload.subarray(o + 4, o + 4 + ln);
            let asciiOk = true;
            for (let i = 0; i < s.length; i++) if (!(s[i] >= 32 && s[i] < 127)) { asciiOk = false; break; }
            const dec = sj(s);
            if (asciiOk || isPrintable(dec)) { out.push(dec); o += 4 + ln; continue; }
        }
        o += 1;
    }
    return out;
}

/** _lstr: [u16 len][bytes] */
export function lstr(b: Bytes, p: number): [Bytes, number] {
    if (p + 2 > b.length) throw new RangeError('struct');
    const n = u16(b, p);
    return [b.subarray(p + 2, p + 2 + n), p + 2 + n];
}
/** just past TActor + TMapObjBase strings: [desc][u32][model key] */
export function actorTail(payload: Bytes) { let [, p] = lstr(payload, 36); p += 4; [, p] = lstr(payload, p); return p; }
export const asciiStr = (b: Bytes) => ascii(b, 0, b.length);
export const sjisStr = sj;

/** JDrama TParams .prm: name -> f32 (or s32 when it doesn't look like a float), u8, or the raw bytes.
 * Which values are floats (Python's isinstance(v, float)) is kept alongside: isFloat(params, name). */
export type Prm = Record<string, any> & { [PRM_FLOATS]?: Set<string> };
export const PRM_FLOATS = Symbol('floats');
export function parsePrm(d: Bytes): Prm {
    const n = u32(d, 0), out: Prm = {}, floats = new Set<string>();
    let o = 4;
    for (let i = 0; i < n; i++) {
        const ln = u16(d, o + 2), name = ascii(d, o + 4, ln);
        o += 4 + ln;
        const sz = u32(d, o), raw = d.subarray(o + 4, o + 4 + sz);
        o += 4 + sz;
        if (sz === 4) {
            const f = f32(raw, 0), iv = s32(raw, 0);
            if ((Math.abs(f) > 1e-6 && Math.abs(f) < 1e7) || iv === 0) { out[name] = f; floats.add(name); } else { out[name] = iv; floats.delete(name); }
        } else if (sz === 1) { out[name] = raw[0]; floats.delete(name); }
        else { out[name] = raw; floats.delete(name); }
    }
    Object.defineProperty(out, PRM_FLOATS, { value: floats, enumerable: false });
    return out;
}
export const isFloat = (p: Prm | null | undefined, k: string) => !!p && !!p[PRM_FLOATS] && p[PRM_FLOATS]!.has(k);

// ---------------------------------------------------------------- event scripts (tools/spc.py)
const OPS: [string, number][] = [['int', 4], ['flt', 4], ['str', 4], ['adr', 4], ['var', 8], ['nop', 0], ['inc', 9], ['dec', 9],
    ['add', 0], ['sub', 0], ['mul', 0], ['div', 0], ['mod', 0], ['ass', 9], ['eq', 0], ['ne', 0], ['gt', 0], ['lt', 0], ['ge', 0], ['le', 0],
    ['neg', 0], ['not', 0], ['and', 0], ['or', 0], ['band', 0], ['bor', 0], ['shl', 0], ['shr', 0], ['call', 8], ['func', 8], ['mkfr', 4], ['mkds', 4],
    ['ret', 0], ['ret0', 0], ['jne', 4], ['jmp', 4], ['pop', 0], ['int0', 0], ['int1', 0], ['end', 0]];
const BINARY = new Set(['add', 'sub', 'mul', 'div', 'mod', 'eq', 'ne', 'gt', 'lt', 'ge', 'le', 'and', 'or', 'band', 'bor', 'shl', 'shr']);
const UNKNOWN = Symbol('unknown');
/** a script argument: int, float ({f}), string, or null where it isn't a constant */
export type SpcArg = number | { f: number } | string | null;
function cstrAt(d: Bytes, p: number) { let e = p; while (e < d.length && d[e]) e++; return sj(d.subarray(p, e)); }
export function builtinCalls(d: Bytes): [string, SpcArg[]][] {
    if (ascii(d, 0, 4) !== 'SPCB') return [];
    const text = u32(d, 4), data = u32(d, 8), ndata = u32(d, 12), symo = u32(d, 16), nsym = u32(d, 20);
    const string = (i: number) => cstrAt(d, data + ndata * 4 + u32(d, data + i * 4));
    const names: string[] = [];
    for (let i = 0; i < nsym; i++) names.push(cstrAt(d, symo + nsym * 20 + u32(d, symo + i * 20 + 4)));
    const out: [string, SpcArg[]][] = [];
    let stack: any[] = [], pc = 0;
    const end = data - text;
    const pop = () => (stack.length ? stack.pop() : UNKNOWN);
    while (pc < end) {
        const op = d[text + pc];
        if (op >= OPS.length) break;
        const [name, size] = OPS[op];
        const ao = text + pc + 1;
        pc += 1 + size;
        if (name === 'int') stack.push(s32(d, ao));
        else if (name === 'flt') stack.push({ f: f32(d, ao) });
        else if (name === 'str') stack.push(string(u32(d, ao)));
        else if (name === 'int0') stack.push(0);
        else if (name === 'int1') stack.push(1);
        else if (['adr', 'var', 'inc', 'dec'].includes(name)) stack.push(UNKNOWN);
        else if (name === 'ass' || name === 'pop' || name === 'jne') pop();
        else if (BINARY.has(name)) { pop(); pop(); stack.push(UNKNOWN); }
        else if (name === 'neg' || name === 'not') { pop(); stack.push(UNKNOWN); }
        else if (name === 'call') { const argc = s32(d, ao + 4); for (let i = 0; i < argc; i++) pop(); stack.push(UNKNOWN); }
        else if (name === 'func') {
            const sym = u32(d, ao), argc = u32(d, ao + 4);
            const args = []; for (let i = 0; i < argc; i++) args.push(pop());
            args.reverse();
            out.push([sym < names.length ? names[sym] : `?${sym}`, args.map((a) => (a === UNKNOWN ? null : a))]);
            stack.push(UNKNOWN);
        } else if (['ret', 'ret0', 'end', 'jmp'].includes(name)) stack = [];
    }
    return out;
}

/** NPC per-instance data (tools/npc_payload.py npc_fields) */
export function npcFields(payload: Bytes) {
    try {
        let o = 36;
        const skip = (q: number) => { if (q + 2 > payload.length) throw new RangeError(); return q + 2 + u16(payload, q); };
        o = skip(o) + 4; o = skip(o); o = skip(o);
        if (o + 36 > payload.length) return null;
        const vals = Array.from({ length: 9 }, (_, k) => s32(payload, o + k * 4));
        return { c0: vals.slice(0, 3), c1: vals.slice(3, 6), parts: Math.max(0, vals[6]), action: vals[7], throw: vals[8] };
    } catch { return null; }
}
