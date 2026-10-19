// J3D animations the converters read (tools/btk.py, tools/brk.py, build_mario_iso.parse_bck / bck_pose).
import { Bytes, u16, u32, s16, f32, ascii, pyRound } from './bin.js';
import { stringTable, readChunks, eye4, eulerMatrix, M4 } from './bmd.js';

/** .btk (TTK1): {duration, loop, anims: [{mat, tm, center, tracks: {sS, rS, tS, sT, rT, tT, rQ}}]} */
export function parseBtk(data: Bytes): any | null {
    if (ascii(data, 0, 8) !== 'J3D1btk1') return null;
    let o = 0x20;
    while (o < data.length && ascii(data, o, 4) !== 'TTK1') o += u32(data, o + 4);
    if (ascii(data, o, 4) !== 'TTK1') return null;
    const c = data.subarray(o);
    const loop = c[8], rdec = c[9], dur = u16(c, 0x0a), n = Math.floor(u16(c, 0x0c) / 3);
    const animO = u32(c, 0x14), namesO = u32(c, 0x1c), tmO = u32(c, 0x20), centerO = u32(c, 0x24);
    const sO = u32(c, 0x28), rO = u32(c, 0x2c), tO = u32(c, 0x30);
    const rscale = ((1 << rdec) / 0x7fff) * Math.PI;
    const names = stringTable(c, namesO);
    const track = (at: number, table: number, kind: string) => {
        const count = u16(c, at), idx = u16(c, at + 2), tan = u16(c, at + 4);
        const val = (i: number) => (kind === 'r' ? s16(c, rO + i * 2) * rscale : f32(c, table + i * 4));
        if (count === 1) return [pyRound(val(idx), 6)];
        const stride = tan === 0 ? 3 : 4, keys: number[][] = [];
        for (let k = 0; k < count; k++) {
            const base = idx + k * stride;
            const t = kind === 'r' ? s16(c, rO + base * 2) : f32(c, table + base * 4);
            const v = val(base + 1), ti = val(base + 2), to = stride === 4 ? val(base + 3) : ti;
            keys.push([pyRound(t, 4), pyRound(v, 6), pyRound(ti, 6), pyRound(to, 6)]);
        }
        return keys;
    };
    const anims = [];
    for (let i = 0; i < n; i++) {
        const at = animO + i * 0x36;
        const tr = { sS: track(at, sO, 's'), rS: track(at + 0x06, rO, 'r'), tS: track(at + 0x0c, tO, 't'), sT: track(at + 0x12, sO, 's'),
            rT: track(at + 0x18, rO, 'r'), tT: track(at + 0x1e, tO, 't'), rQ: track(at + 0x2a, rO, 'r') };
        const center = [f32(c, centerO + i * 12), f32(c, centerO + i * 12 + 4), f32(c, centerO + i * 12 + 8)];
        anims.push({ mat: i < names.length ? names[i] : '', tm: c[tmO + i], center, tracks: tr });
    }
    return { duration: dur, loop, anims };
}

/** .brk (TRK1): {loop, dur, color: [{mat, reg, rgba: [track x4]}], konst: [...]} */
export function parseBrk(d: Bytes): any {
    if (ascii(d, 0, 8) !== 'J3D1brk1') throw new Error('not a brk');
    const o = 0x20;
    if (ascii(d, o, 4) !== 'TRK1') throw new Error('no TRK1');
    const s = (off: number) => u16(d, o + off), l = (off: number) => u32(d, o + off);
    const loop = d[o + 8], dur = s(0xa), nC = s(0xc), nK = s(0xe);
    const offs = Array.from({ length: 14 }, (_, i) => l(0x20 + i * 4));
    const [cTab, kTab, , , cNames, kNames] = offs;
    const vals = offs.slice(6, 14);
    const track = (baseVals: number, count: number, index: number, tan: number) => {
        const a = o + baseVals;
        if (count === 1) return [[0, s16(d, a + index * 2), 0, 0]];
        const step = tan === 1 ? 4 : 3, ks: number[][] = [];
        for (let k = 0; k < count; k++) {
            const v = Array.from({ length: step }, (_, q) => s16(d, a + (index + k * step + q) * 2));
            ks.push([v[0], v[1], v[2], step === 4 ? v[3] : v[2]]);
        }
        return ks;
    };
    const anims = (tab: number, n: number, vbase: number, names: number) => {
        const out = [], nm = n ? stringTable(d, o + names) : [];
        for (let i = 0; i < n; i++) {
            const e = o + tab + i * 28, tr = [];
            for (let c = 0; c < 4; c++) tr.push(track(vals[vbase + c], u16(d, e + c * 6), u16(d, e + c * 6 + 2), u16(d, e + c * 6 + 4)));
            out.push({ mat: nm[i], reg: d[e + 24], rgba: tr });
        }
        return out;
    };
    return { loop, dur, color: anims(cTab, nC, 0, cNames), konst: anims(kTab, nK, 4, kNames) };
}

/** parse_bck (ANK1): {d, l, j: per joint [sx sy sz rx ry rz tx ty tz] constants or [t, v, in, out]* key lists} */
export function parseBck(data: Bytes): any {
    const a = readChunks(data).get('ANK1')!;
    const loop = a[8], rdec = a[9], dur = u16(a, 0x0a);
    const jcount = u16(a, 0x0c), sc = u16(a, 0x0e), rc = u16(a, 0x10), tc = u16(a, 0x12);
    const jt = u32(a, 0x14), st = u32(a, 0x18), rt = u32(a, 0x1c), tt = u32(a, 0x20);
    const stab = Array.from({ length: sc }, (_, i) => f32(a, st + i * 4));
    const rtab = Array.from({ length: rc }, (_, i) => s16(a, rt + i * 2));
    const ttab = Array.from({ length: tc }, (_, i) => f32(a, tt + i * 4));
    const rscale = (2 ** rdec / 0x7fff) * Math.PI;
    let o = jt;
    const joints = [];
    for (let j = 0; j < jcount; j++) {
        const tracks: any[] = [];
        for (let comp = 0; comp < 3; comp++) for (const [table, scale] of [[stab, 1.0], [rtab, rscale], [ttab, 1.0]] as [number[], number][]) {
            const count = u16(a, o), index = u16(a, o + 2), tangent = u16(a, o + 4);
            o += 6;
            if (count === 1) tracks.push(pyRound(table[index] * scale, 5));
            else {
                const stride = tangent === 0 ? 3 : 4, keys: number[] = [];
                for (let k = 0; k < count; k++) {
                    const b = index + k * stride;
                    const tm = table[b], v = table[b + 1] * scale, ti = table[b + 2] * scale, to = stride === 4 ? table[b + 3] * scale : ti;
                    keys.push(pyRound(tm, 3), pyRound(v, 5), pyRound(ti, 5), pyRound(to, 5));
                }
                tracks.push(keys);
            }
        }
        joints.push([tracks[0], tracks[3], tracks[6], tracks[1], tracks[4], tracks[7], tracks[2], tracks[5], tracks[8]]);
    }
    return { d: Math.max(dur, 1), l: loop, j: joints };
}

const hermite = (p0: number, p1: number, s0: number, s1: number, t: number) => {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * s0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * s1;
};
export function sampleTrack(tr: any, f: number): number {
    if (!Array.isArray(tr)) return tr;
    const n = Math.floor(tr.length / 4);
    if (f < tr[0]) return tr[1];
    for (let i = 1; i < n; i++) {
        const t1 = tr[i * 4];
        if (f < t1) { const b = (i - 1) * 4, ln = t1 - tr[b]; return hermite(tr[b + 1], tr[i * 4 + 1], tr[b + 3] * ln, tr[i * 4 + 2] * ln, (f - tr[b]) / ln); }
    }
    return tr[(n - 1) * 4 + 1];
}
/** bck_pose: local joint matrices at a frame */
export function bckPose(anim: any, frame: number): Map<number, M4> {
    const out = new Map<number, M4>();
    anim.j.forEach((j: any[], i: number) => {
        const v = j.map((t) => sampleTrack(t, frame));
        const r = eulerMatrix(v[3], v[4], v[5]), m = eye4();
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a * 4 + b] = r[a * 3 + b] * v[b];
        m[3] = v[6]; m[7] = v[7]; m[11] = v[8];
        out.set(i, m);
    });
    return out;
}
