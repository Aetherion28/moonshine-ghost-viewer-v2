// The decomp's class layouts, read from its headers: for a class, every data member with its offset and type,
// its bases' members first (a base's members sit at the same offsets in the derived class: SMS uses single
// inheritance for the data, a second base being a vtable-only interface). Used by the lockstep comparer to read
// a game object's fields out of v3's memory and find the v2 object's property of the same name.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FieldType = 'f32' | 'f64' | 's8' | 'u8' | 's16' | 'u16' | 's32' | 'u32' | 'bool' | 'v3f' | 'v3s16' | 'ptr';
export interface Field { name: string; off: number; type: FieldType; cls: string }
interface RawClass { name: string; bases: string[]; fields: Field[] }

const TYPES: [RegExp, FieldType][] = [
    [/^(f32|float)$/, 'f32'], [/^(f64|double)$/, 'f64'], [/^s8$/, 's8'], [/^(u8|char|unsigned char)$/, 'u8'],
    [/^(s16|short)$/, 's16'], [/^u16$/, 'u16'], [/^(s32|int|long)$/, 's32'], [/^(u32|unsigned int|unsigned long|BOOL)$/, 'u32'],
    [/^bool$/, 'bool'], [/^(JGeometry::)?TVec3<f32>$|^Vec$|^TVec3f$/, 'v3f'], [/^(JGeometry::)?TVec3<s16>$/, 'v3s16'],
];
export const SIZE: Record<FieldType, number> = { f32: 4, f64: 8, s8: 1, u8: 1, s16: 2, u16: 2, s32: 4, u32: 4, bool: 1, v3f: 12, v3s16: 6, ptr: 4 };

function walk(dir: string, out: string[]) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n), s = statSync(p);
        if (s.isDirectory()) walk(p, out); else if (/\.(hpp|h)$/.test(n)) out.push(p);
    }
}

/** Every class body in the headers (at any nesting: a nested class is named as written). */
function parseHeaders(roots: string[]): Map<string, RawClass> {
    const files: string[] = []; for (const r of roots) { try { walk(r, files); } catch { /* a root that isn't there */ } }
    const classes = new Map<string, RawClass>();
    for (const f of files) {
        const lines = readFileSync(f, 'utf8').split('\n');
        // a stack of open braces: each a class being read or something else
        const stack: (RawClass | null)[] = [];
        let pending: RawClass | null = null;
        for (const raw of lines) {
            const line = raw.replace(/\/\/.*$/, '');
            const head = /^\s*(?:class|struct)\s+(?:\w+\s+)?([A-Za-z_]\w*)\s*(?::\s*([^{]*))?\{?\s*$/.exec(line);
            if (head && !/;\s*$/.test(line)) {
                const bases = (head[2] || '').split(',').map((b) => b.replace(/\b(public|private|protected|virtual)\b/g, '').trim()).filter((b) => b);
                pending = { name: head[1], bases: bases.map((b) => b.replace(/<.*$/, '').replace(/^.*::/, '')), fields: [] };
            }
            const m = /\/\*\s*0x([0-9A-Fa-f]+)\s*\*\/\s*(?:mutable\s+)?(?:volatile\s+)?([\w:<>, *]+?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/.exec(raw);
            if (m && stack.length && stack[stack.length - 1]) {
                const cur = stack[stack.length - 1]!;
                let t = m[2].replace(/\bconst\b/g, '').trim();
                let type: FieldType | null = null;
                if (t.includes('*')) type = 'ptr';
                else for (const [re, ty] of TYPES) if (re.test(t)) { type = ty; break; }
                if (type && !m[4]) cur.fields.push({ name: m[3], off: parseInt(m[1], 16), type, cls: cur.name });
            }
            for (const ch of line) {
                if (ch === '{') { stack.push(pending); pending = null; }
                else if (ch === '}') { const c = stack.pop(); if (c && !classes.has(c.name)) classes.set(c.name, c); }
            }
        }
    }
    return classes;
}

let cache: Map<string, RawClass> | null = null;
const flat = new Map<string, Field[]>();
export function layoutOf(cls: string, decomp = process.env.DECOMP_SRC || '/home/claude/sms-ai-decomp'): Field[] {
    if (!cache) cache = parseHeaders([join(decomp, 'include'), join(decomp, 'libs/JSystem/include')]);
    const got = flat.get(cls); if (got) return got;
    const c = cache.get(cls);
    const out: Field[] = [];
    if (c) {
        // the first base's members (the data base); then the class's own
        if (c.bases.length) out.push(...layoutOf(c.bases[0], decomp));
        const seen = new Set(out.map((f) => f.off));
        for (const f of c.fields) if (!seen.has(f.off)) out.push(f);
    }
    flat.set(cls, out);
    return out;
}
export function knownClass(cls: string) { layoutOf('TMario'); return cache!.has(cls); }
