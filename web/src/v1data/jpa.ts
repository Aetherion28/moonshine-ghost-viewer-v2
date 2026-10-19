// JPA particle resources (tools/jpa.py, tools/build_jpa.py): parsed blocks and RGBA textures (base64).
import { Bytes, u16, s16, u32, f32, ascii } from './bin.js';
import { btiRgba } from './objparts.js';

const fix = (v: number) => (v === 0x7fff ? 1.0 : v / 32768.0);
const fx = (d: Bytes, o: number) => fix(s16(d, o));
const f3 = (d: Bytes, o: number) => [f32(d, o), f32(d, o + 4), f32(d, o + 8)];

function bem1(d: Bytes) {
    let o = 0x0c;
    const e: any = {};
    e.scale = f3(d, o); o += 12;
    e.trans = f3(d, o); o += 12;
    e.rot = [s16(d, o), s16(d, o + 2), s16(d, o + 4)]; o += 6;
    e.volumeType = d[o]; e.emitInterval = d[o + 1]; o += 4;
    e.volumeSubdiv = u16(d, o); o += 2;
    e.rate = f32(d, o); o += 4;
    e.rateRndm = fx(d, o); o += 2;
    e.maxFrame = s16(d, o); o += 2;
    e.startFrame = s16(d, o); o += 2;
    e.volumeSize = u16(d, o); o += 2;
    e.volumeSweep = fx(d, o); o += 2;
    e.volumeMinRad = fx(d, o); o += 2;
    e.life = s16(d, o); o += 2;
    e.lifeRndm = fx(d, o); o += 2;
    e.weight = fx(d, o); o += 2;
    e.weightRndm = fx(d, o); o += 2;
    e.velRndm = fx(d, o); o += 2;
    e.momentRndm = fx(d, o); o += 2;
    e.airResist = fx(d, o); o += 2;
    e.airResistRndm = fx(d, o); o += 2;
    [e.initVelOmni, e.initVelAxis, e.initVelRndm, e.initVelDir, e.moment] = [0, 1, 2, 3, 4].map((i) => f32(d, o + i * 4)); o += 20;
    e.dir = [0, 1, 2].map((i) => fx(d, o + i * 2)); o += 6;
    e.spread = fx(d, o); o += 2;
    e.flags = u32(d, o); o += 4;
    e.keyMask = u32(d, o); o += 4;
    return e;
}
const colorTable = (d: Bytes, off: number, n: number) => Array.from({ length: n }, (_, i) => [s16(d, off + i * 6), Array.from(d.subarray(off + i * 6 + 2, off + i * 6 + 6))]);
function bsp1(d: Bytes) {
    const b: any = { sizeY: f32(d, 0x18), sizeX: f32(d, 0x1c), loopOffset: s16(d, 0x20), colLoop: d[0x22] & 1, texLoop: d[0x23] & 1,
        globalColAnm: !!(d[0x22] & 2), globalTexAnm: !!(d[0x23] & 2), type: d[0x24], dirType: d[0x25], rotType: d[0x26], tevCol: d[0x30], tevAlpha: d[0x31],
        blendMode: d[0x35], srcFactor: d[0x36], dstFactor: d[0x37], logicOp: d[0x38], aCmp0: d[0x39], aRef0: d[0x3a], aOp: d[0x3b], aCmp1: d[0x3c], aRef1: d[0x3d],
        zCompLoc: +!((d[0x3e] >> 1) & 1), zCmp: d[0x3f], zFunc: d[0x40], zUpd: d[0x41], anmTone: d[0x42], projection: d[0x43], flags: d[0x44],
        texAnmFlags: d[0x4c], texAnmType: d[0x4d], texAnmKeyNum: d[0x4e], texIndex: d[0x4f], colAnmMaxFrm: s16(d, 0x5c), colAnmType: d[0x5e],
        prmFlags: d[0x60], envFlags: d[0x61], prmKeyNum: d[0x62], envKeyNum: d[0x63], prm: Array.from(d.subarray(0x64, 0x68)), env: Array.from(d.subarray(0x68, 0x6c)),
        texStatic: [0, 1, 2, 3].map((i) => fx(d, 0x80 + i * 2) * 10), tiling: [fx(d, 0x88) * 10, fx(d, 0x8a) * 10],
        texScroll: [fx(d, 0x8c), fx(d, 0x8e), fx(d, 0x90) * 0.1, fx(d, 0x92) * 0.1, fx(d, 0x94)], texScrollAnm: d[0x96] };
    // (Python: (d[0x4C] & 1) and keyNum != 0 -> 0, or a bool)
    const flag = d[0x4c] & 1;
    b.texAnm = flag ? b.texAnmKeyNum !== 0 : 0;
    if (b.texAnm) { const o = s16(d, 0x12); b.texIndices = Array.from(d.subarray(o, o + b.texAnmKeyNum)); }
    if (b.prmFlags & 2) b.prmKeys = colorTable(d, s16(d, 0x14), b.prmKeyNum);
    if (b.envFlags & 2) b.envKeys = colorTable(d, s16(d, 0x16), b.envKeyNum);
    return b;
}
const esp1 = (d: Bytes) => ({ alphaIn: fx(d, 0x14), alphaOut: fx(d, 0x16), alphaInVal: fx(d, 0x18), alphaBase: fx(d, 0x1a), alphaOutVal: fx(d, 0x1c),
    alphaFlags: d[0x1e], alphaWaveType: d[0x1f], wave: [fx(d, 0x20), fx(d, 0x22), fx(d, 0x24)], waveRndm: fx(d, 0x26),
    scaleRndm: fx(d, 0x34), scaleIn: fx(d, 0x36), scaleOut: fx(d, 0x38), scaleInY: fx(d, 0x3a) * 10, scaleOutY: fx(d, 0x3e) * 10,
    pivotY: d[0x40], anmTypeY: d[0x41], cycleY: s16(d, 0x42), scaleInX: fx(d, 0x44) * 10, scaleOutX: fx(d, 0x48) * 10,
    pivotX: d[0x4a], anmTypeX: d[0x4b], cycleX: s16(d, 0x4c), scaleFlags: d[0x4e], rotAngle: fx(d, 0x5a), rotSpeed: fx(d, 0x5c), rotSpeedRndm: fx(d, 0x5e),
    rotAngleRndm: fx(d, 0x60), rotDir: fx(d, 0x62), rotate: d[0x64] });
const ssp1 = (d: Bytes) => ({ type: d[0x10], dirType: d[0x11], rotType: d[0x12], life: s16(d, 0x14), rate: s16(d, 0x16), timing: fx(d, 0x18), step: d[0x1a],
    posRndm: f32(d, 0x28), baseVel: f32(d, 0x2c), velInh: fx(d, 0x30), baseVelRndm: fx(d, 0x32), moment: fx(d, 0x34), fields: d[0x36], unk49: d[0x44],
    scaleOut: d[0x45], alphaOut: d[0x46], texIndex: d[0x47], inhScale: fx(d, 0x48), inhAlpha: fx(d, 0x4a), scaleY: f32(d, 0x4c), scaleX: f32(d, 0x50),
    rotSpeed: fx(d, 0x54), rotate: d[0x56], unk4E: d[0x57], prm: Array.from(d.subarray(0x58, 0x5c)), env: Array.from(d.subarray(0x5c, 0x60)), inhRGB: fx(d, 0x60) });
const etx1 = (d: Bytes) => ({ indMode: d[0x10], mtxType: d[0x11], mtx: [0, 1, 2, 3, 4, 5].map((i) => fx(d, 0x12 + i * 2)), expScale: d[0x1e], indTex: d[0x1f], subTex: d[0x20], flags: d[0x30], secondTex: d[0x33] });
const fld1 = (d: Bytes) => ({ type: d[0x0c], unk51: d[0x0d], addType: d[0x0e], cycle: d[0x0f], status: u16(d, 0x10), mag: f32(d, 0x14), magRndm: f32(d, 0x18), maxDist: f32(d, 0x1c),
    pos: f3(d, 0x20), dir: f3(d, 0x2c), param1: f32(d, 0x38), param2: f32(d, 0x3c), param3: u32(d, 0x40),
    fadeInEnd: fx(d, 0x44), fadeOutStart: fx(d, 0x46), fadeInStart: fx(d, 0x48), fadeOutEnd: fx(d, 0x4a) });
const kfa1 = (d: Bytes) => { const n = d[0x10]; return { loop: d[0x12], keys: Array.from({ length: n * 4 }, (_, i) => f32(d, 0x20 + i * 4)) }; };

function b64(u: Uint8Array) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }

export function parseJpa(data: Bytes) {
    if (ascii(data, 0, 8) !== 'JEFFjpa1') throw new Error('not a JPA');
    const n = u32(data, 0x0c);
    let o = 0x20;
    const r: any = { fields: [], keys: [], tex: [] };
    for (let i = 0; i < n; i++) {
        const tag = ascii(data, o, 4), sz = u32(data, o + 4), d = data.subarray(o, o + sz);
        if (tag === 'BEM1') r.emitter = bem1(d); else if (tag === 'BSP1') r.base = bsp1(d); else if (tag === 'ESP1') r.extra = esp1(d);
        else if (tag === 'SSP1') r.sweep = ssp1(d); else if (tag === 'ETX1') r.extex = etx1(d);
        else if (tag === 'FLD1') r.fields.push(d); else if (tag === 'KFA1') r.keys.push(d); else if (tag === 'TEX1') r.tex.push(d);
        o += sz;
    }
    const out: any = { em: r.emitter, bs: r.base };
    if (r.extra) out.es = r.extra;
    if (r.sweep) out.ss = r.sweep;
    if (r.extex) out.ex = r.extex;
    out.fld = r.fields.map(fld1);
    out.key = r.keys.map(kfa1);
    out.tex = r.tex.map((d: Bytes) => {
        let e = 0x0c; while (e < 0x20 && d[e]) e++;
        const name = ascii(d, 0x0c, e - 0x0c), b = d.subarray(0x20), px = btiRgba(b);
        return { name, w: u16(b, 2), h: u16(b, 4), wrapS: b[6], wrapT: b[7], rgba: b64(px.d) };
    });
    return out;
}

export const EFFECTS: Record<string, string> = { nozzlesmoke: 'ms_nozzlesmoke.jpa', watslide_a: 'ms_m_watslide_a.jpa', watslide_b: 'ms_m_watslide_b.jpa', watslide_c: 'ms_m_watslide_c.jpa',
    slipsmoke: 'ms_m_slipsmoke.jpa', shine_promi: 'ms_shine_promi.jpa', shine_senko: 'ms_shine_senko.jpa', shine_kira: 'ms_shine_kira.jpa', shine_bow: 'ms_shine_bow.jpa' };
export const BW_EFFECTS: Record<string, string> = Object.fromEntries(['hityuge', 'downyuge', 'deadyuge', 'kira', 'jump_rock', 'jump_smoke', 'hibana', 'yugami'].map((n) => [`bw_${n}`, `bwanwan/jpa/ms_bwan_${n}.jpa`]));
export const BG_EFFECTS: Record<string, string> = Object.fromEntries(['attack_a', 'attack_b', 'attack_c', 'attack_d', 'blur', 'blur_f', 'blur_j', 'canon_a', 'canon_b', 'damage_a', 'damage_b',
    'hit_a', 'hit_b', 'hit_c', 'hitdown', 'jump', 'kizetsu', 'kizetsu_r', 'odanhit_a', 'odanhit_b', 'osen', 'ase', 'namida', 'kiseki', 'wash'].map((n) => [`bg_${n}`, `bgeso/jpa/ms_boge_${n}.jpa`]));
export function exportJpa(todo: [string, Map<string, Bytes>, string][]) {
    const res: any = {};
    for (const [key, arc, fn] of todo) res[key] = parseJpa(arc.get(fn)!);
    return res;
}
export { b64 };
