// J3D models (.bmd / .bdl) into meshes in model space (tools/bmd.py): the scene graph, vertex
// arrays, skinning (EVP1 / DRW1), joints, display lists, materials and textures, posed at the bind
// pose (or a given pose). Matrices are row-major Float64Array(16).
import { Bytes, u16, s16, u32, f32, cstr, ascii } from './bin.js';
import * as gxt from './gxtex.js';

export const PNMTXIDX = 0, TEX0MTXIDX = 1, POS = 9, NRM = 10, CLR0 = 11, CLR1 = 12, TEX0 = 13, NBT = 25, NULL = 0xff;
const VTX_ARRAYS = [POS, NRM, NBT, CLR0, CLR1, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => TEX0 + i)];
const WRAP: Record<number, number> = { 0: 33071, 1: 10497, 2: 33648 };

export type M4 = Float64Array;
export const eye4 = (): M4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul4(a: M4, b: M4): M4 {
    const o = new Float64Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
        o[i * 4 + j] = s;
    }
    return o;
}
/** numpy.linalg.inv of a 4x4 (Gauss-Jordan with partial pivoting, as LAPACK's getrf/getri in effect) */
export function inv4(m: M4): M4 {
    const a = Array.from(m), b = Array.from(eye4());
    for (let c = 0; c < 4; c++) {
        let p = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 4 + c]) > Math.abs(a[p * 4 + c])) p = r;
        if (p !== c) for (let k = 0; k < 4; k++) { [a[c * 4 + k], a[p * 4 + k]] = [a[p * 4 + k], a[c * 4 + k]]; [b[c * 4 + k], b[p * 4 + k]] = [b[p * 4 + k], b[c * 4 + k]]; }
        const d = a[c * 4 + c];
        for (let k = 0; k < 4; k++) { a[c * 4 + k] /= d; b[c * 4 + k] /= d; }
        for (let r = 0; r < 4; r++) if (r !== c) {
            const f = a[r * 4 + c];
            if (f) for (let k = 0; k < 4; k++) { a[r * 4 + k] -= f * a[c * 4 + k]; b[r * 4 + k] -= f * b[c * 4 + k]; }
        }
    }
    return Float64Array.from(b);
}
/** rz @ ry @ rx (3x3, row-major) */
export function eulerMatrix(x: number, y: number, z: number): number[] {
    const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
    const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
    return mul3(mul3(rz, ry), rx);
}
export function mul3(a: number[], b: number[]) {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j]; o[i * 3 + j] = s; }
    return o;
}
/** a 4x4 from TRS (euler radians), as the joint table stores it: R @ diag(s), then t */
export function trsMatrix(sc: number[], rot: number[], tr: number[]): M4 {
    const r = eulerMatrix(rot[0], rot[1], rot[2]), m = eye4();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 4 + j] = r[i * 3 + j] * sc[j];
    m[3] = tr[0]; m[7] = tr[1]; m[11] = tr[2];
    return m;
}

export type TexEntry = [number, number, number[] | null];   // texture index, texcoord attribute, 2x3 texture matrix
export interface TevStage { texmap: number; chan: number; c: number[]; a: number[]; kc: number; ka: number }
export interface Material {
    name: string; translucent: boolean; alphaRef: number | null; blend: boolean; useVertexColor: boolean; matColor: number[];
    base: TexEntry | null; layer: TexEntry | null; cull: number; used: TexEntry[];
    tev: { stages: TevStage[]; regs: number[][]; kregs: number[][] } | null;
    lit: boolean; litMask: number; ambVtx: boolean; diffFn: number; env: any[]; blendMode: number[]; gx: any | null;
}
export type Texture = [string, gxt.Image | null, number, number];
export interface Mesh {
    shape: number; material: number; pos: Float32Array; tris: Uint32Array; uv: Map<number, Float32Array>;
    drw: Int32Array; nrm?: Float64Array; color?: Uint8Array;
}
export interface Model {
    jointsWorld: M4[]; jointNames: string[]; jointParent: number[]; jointTrs: [number[], number[], number[]][];
    drawWeights: [number, number][][]; materials: Material[]; textures: Texture[]; textureMips: Map<number, gxt.Image[]>; meshes: Mesh[];
}

export function stringTable(b: Bytes, off: number) {
    const n = u16(b, off), out: string[] = [];
    for (let i = 0; i < n; i++) out.push(cstr(b, off + u16(b, off + 4 + i * 4 + 2)));
    return out;
}

export function readChunks(data: Bytes): Map<string, Bytes> {
    if (ascii(data, 0, 3) !== 'J3D') throw new Error('not a J3D file');
    const chunks = new Map<string, Bytes>();
    let off = 0x20;
    const n = u32(data, 0x0c);
    for (let i = 0; i < n; i++) {
        if (off + 8 > data.length) break;
        const id = ascii(data, off, 4), size = u32(data, off + 4);
        chunks.set(id, data.subarray(off, off + size));
        off += size;
    }
    return chunks;
}

export interface ParseOpts { decodeTextures?: boolean; bmt?: Bytes | null; pose?: Map<number, M4> | null; bmtTexOnly?: boolean }

export function parse(data: Bytes, opts: ParseOpts = {}): Model {
    const decodeTextures = opts.decodeTextures !== false;
    const chunks = readChunks(data);
    let tableMat: Bytes | null = null;
    if (opts.bmt) {
        const over = readChunks(opts.bmt);
        const t1 = over.get('TEX1');
        if (t1 && u16(t1, 8)) chunks.set('TEX1', t1);
        if (!opts.bmtTexOnly) tableMat = over.get('MAT3') || over.get('MAT2') || null;
    }
    const m: Model = { jointsWorld: [], jointNames: [], jointParent: [], jointTrs: [], drawWeights: [], materials: [], textures: [], textureMips: new Map(), meshes: [] };
    const inf = chunks.get('INF1')!, vtx = chunks.get('VTX1')!, evp = chunks.get('EVP1')!, drw = chunks.get('DRW1')!, jnt = chunks.get('JNT1')!, shp = chunks.get('SHP1')!;
    const mat = chunks.get('MAT3') || chunks.get('MAT2'), tex = chunks.get('TEX1');

    // --- JNT1
    const jcount = u16(jnt, 8), jdata = u32(jnt, 0x0c), jremap = u32(jnt, 0x10);
    m.jointNames = stringTable(jnt, u32(jnt, 0x14));
    const local: M4[] = [];
    for (let i = 0; i < jcount; i++) {
        const o = jdata + u16(jnt, jremap + i * 2) * 0x40;
        const sc = [0, 1, 2].map((k) => f32(jnt, o + 4 + k * 4));
        const rot = [0, 1, 2].map((k) => (s16(jnt, o + 0x10 + k * 2) / 0x7fff) * Math.PI);
        const tr = [0, 1, 2].map((k) => f32(jnt, o + 0x18 + k * 4));
        m.jointTrs.push([sc, rot, tr]);
        local.push(opts.pose && opts.pose.has(i) ? opts.pose.get(i)! : trsMatrix(sc, rot, tr));
    }

    // --- INF1
    let h = u32(inf, 0x14);
    const parent = new Array(jcount).fill(-1);
    const shapeMat = new Map<number, number>();
    let lastJoint = -1, lastMat = -1;
    const jointStack = [-1];
    for (;;) {
        const t = u16(inf, h), idx = u16(inf, h + 2);
        h += 4;
        if (t === 0x00) break;
        if (t === 0x01) jointStack.push(lastJoint);
        else if (t === 0x02) lastJoint = jointStack.pop()!;
        else if (t === 0x10) { parent[idx] = jointStack[jointStack.length - 1]; lastJoint = idx; }
        else if (t === 0x11) lastMat = idx;
        else if (t === 0x12) shapeMat.set(idx, lastMat);
    }
    const world: (M4 | null)[] = new Array(jcount).fill(null);
    const jointWorld = (i: number): M4 => world[i] || (world[i] = parent[i] < 0 ? local[i] : mul4(jointWorld(parent[i]), local[i]));
    for (let i = 0; i < jcount; i++) m.jointsWorld.push(jointWorld(i));
    m.jointParent = parent;

    // --- EVP1 / DRW1
    const envCount = u16(evp, 8);
    const [cntO, idxO, wO, ibO] = [0, 1, 2, 3].map((k) => u32(evp, 0x0c + k * 4));
    const envelopes: [number, number][][] = [];
    let k = 0;
    for (let i = 0; i < envCount; i++) {
        const n = evp[cntO + i], e: [number, number][] = [];
        for (let j = 0; j < n; j++) e.push([u16(evp, idxO + (k + j) * 2), f32(evp, wO + (k + j) * 4)]);
        envelopes.push(e);
        k += n;
    }
    const invBind = (j: number) => { const mm = eye4(); for (let q = 0; q < 12; q++) mm[q] = f32(evp, ibO + j * 0x30 + q * 4); return mm; };
    const dcount = u16(drw, 8), dkind = u32(drw, 0x0c), ddata = u32(drw, 0x10);
    const drawMtx: M4[] = [];
    for (let i = 0; i < dcount; i++) {
        const kind = drw[dkind + i], p = u16(drw, ddata + i * 2);
        if (kind === 0) { drawMtx.push(m.jointsWorld[p]); m.drawWeights.push([[p, 1.0]]); }
        else {
            const acc = new Float64Array(16);
            for (const [j, wgt] of envelopes[p]) { const x = mul4(m.jointsWorld[j], invBind(j)); for (let q = 0; q < 16; q++) acc[q] += wgt * x[q]; }
            drawMtx.push(acc);
            m.drawWeights.push(envelopes[p].slice());
        }
    }

    // --- VTX1
    const fmtO = u32(vtx, 8);
    const vat = new Map<number, [number, number, number]>();
    for (let o = fmtO; ; o += 0x10) {
        const a = u32(vtx, o);
        if (a === NULL) break;
        vat.set(a, [u32(vtx, o + 4), u32(vtx, o + 8), vtx[o + 12]]);
    }
    const starts = VTX_ARRAYS.map((_, i) => u32(vtx, 0x0c + i * 4));
    const arrays = new Map<number, { n: number; c: number; d: Float32Array | Uint8Array }>();
    VTX_ARRAYS.forEach((a, i) => {
        if (!starts[i] || !vat.has(a)) return;
        let end = vtx.length;
        for (const s of starts.slice(i + 1)) if (s) { end = s; break; }
        const [cnt, ctype, shift] = vat.get(a)!;
        const raw = vtx.subarray(starts[i], end);
        if (a === POS || a === NRM || a === NBT || a >= TEX0) {
            const ncomp = a === POS ? 2 + cnt : a === NRM ? 3 : a === NBT ? 9 : 1 + cnt;
            const size = ctype === 4 ? 4 : ctype >= 2 ? 2 : 1;
            const n = Math.floor(raw.length / (size * ncomp));
            const out = new Float32Array(n * (a === POS && ncomp === 2 ? 3 : ncomp));
            const stride = a === POS && ncomp === 2 ? 3 : ncomp;
            const div = Math.fround(1 << shift);
            for (let v = 0; v < n; v++) for (let c = 0; c < ncomp; c++) {
                const o = (v * ncomp + c) * size;
                let x: number;
                if (ctype === 0) x = raw[o]; else if (ctype === 1) x = (raw[o] << 24) >> 24;
                else if (ctype === 2) x = u16(raw, o); else if (ctype === 3) x = s16(raw, o); else x = f32(raw, o);
                out[v * stride + c] = ctype !== 4 ? Math.fround(Math.fround(x) / div) : x;
            }
            arrays.set(a, { n, c: stride, d: out });
        } else {
            const d = decodeColors(raw, ctype);
            arrays.set(a, { n: d.length / 4, c: 4, d });
        }
    });

    // --- MAT3
    if (mat) {
        m.materials = parseMaterials(mat);
        const indO = u32(mat, 0x18), namesO = u32(mat, 0x14);
        if (indO && indO - namesO > 4) m.materials.forEach((x, i) => { if (x.gx) x.gx.ind = parseIndirect(mat, indO, i); });
        if (tableMat) {
            const byName = new Map(parseMaterials(tableMat).map((t) => [t.name, t]));
            m.materials = m.materials.map((x) => byName.get(x.name) || x);
        }
    }

    // --- TEX1
    if (tex) {
        const tcount = u16(tex, 8), th = u32(tex, 0x0c);
        const names = stringTable(tex, u32(tex, 0x10));
        const cache = new Map<string, gxt.Image | null>();
        for (let i = 0; i < tcount; i++) {
            const ho = th + i * 0x20;
            const fmt = tex[ho], w = u16(tex, ho + 2), hgt = u16(tex, ho + 4);
            const ws = tex[ho + 6], wt = tex[ho + 7], palFmt = tex[ho + 9], palCnt = u16(tex, ho + 10), palOff = u32(tex, ho + 12);
            const doff = u32(tex, ho + 0x1c);
            const pal = palOff ? tex.subarray(ho + palOff, ho + palOff + palCnt * 2) : null;
            let img: gxt.Image | null = null;
            if (decodeTextures) {
                const key = `${ho + doff},${fmt},${w},${hgt}`;
                if (!cache.has(key)) { try { cache.set(key, gxt.decode(tex.subarray(ho + doff), fmt, w, hgt, pal, palFmt)); } catch { cache.set(key, null); } }
                img = cache.get(key)!;
            }
            m.textures.push([i < names.length ? names[i] : `tex${i}`, img, WRAP[ws] ?? 10497, WRAP[wt] ?? 10497]);
            const mips = tex[ho + 0x18];
            if (decodeTextures && img && mips > 1) {
                const levels = [img];
                let o2 = ho + doff + gxt.dataSize(fmt, w, hgt), lw = w, lh = hgt;
                for (let q = 0; q < mips - 1; q++) {
                    lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
                    try { levels.push(gxt.decode(tex.subarray(o2), fmt, lw, lh, pal, palFmt)); } catch { break; }
                    o2 += gxt.dataSize(fmt, lw, lh);
                }
                const mean = (im: gxt.Image) => { let s = 0; for (let q = 0; q < im.d.length; q++) s += im.d[q]; return s / im.d.length; };
                const m0 = mean(img), m1 = levels.length > 1 ? mean(levels[1]) : m0;
                if (levels.length > 1 && Math.abs(m1 - m0) > Math.max(8.0, 0.5 * m0)) m.textureMips.set(m.textures.length - 1, levels);
            }
        }
    }

    // --- SHP1
    const scount = u16(shp, 8);
    const [sInit, , , declO, mtxtabO, dlO, mtxinitO, drawinitO] = [0, 1, 2, 3, 4, 5, 6, 7].map((q) => u32(shp, 0x0c + q * 4));
    for (let si = 0; si < scount; si++) {
        const so = sInit + si * 0x28;
        const groups = u16(shp, so + 2), declIdx = u16(shp, so + 4), mtxinitIdx = u16(shp, so + 6), drawinitIdx = u16(shp, so + 8);
        const decl: [number, number][] = [];
        for (let d = declO + declIdx; u32(shp, d) !== NULL; d += 8) decl.push([u32(shp, d), u32(shp, d + 4)]);
        decl.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        const slots = new Array(10).fill(0);
        const verts: [number, Map<number, number>][] = [];
        const tris: number[] = [];
        for (let g = 0; g < groups; g++) {
            const mo = mtxinitO + (mtxinitIdx + g) * 8;
            const useIdx = u16(shp, mo), useCnt = u16(shp, mo + 2), useFirst = u32(shp, mo + 4);
            for (let q = 0; q < useCnt; q++) { const v = u16(shp, mtxtabO + (useFirst + q) * 2); if (v !== 0xffff) slots[q] = v; }
            const def = useIdx !== 0xffff ? useIdx : slots[0];
            const dO = drawinitO + (drawinitIdx + g) * 8;
            const size = u32(shp, dO), start = dlO + u32(shp, dO + 4);
            let p = start;
            while (p < start + size) {
                const op = shp[p++];
                if (op === 0 || op < 0x80) continue;
                const prim = op & 0xf8, n = u16(shp, p);
                p += 2;
                const first = verts.length;
                for (let q = 0; q < n; q++) {
                    const attrs = new Map<number, number>();
                    for (const [a, t] of decl) {
                        if (t === 1) {
                            if (a === PNMTXIDX || (TEX0MTXIDX <= a && a < POS)) attrs.set(a, shp[p++]);
                            else throw new Error('direct vertex data not supported');
                        } else if (t === 2) attrs.set(a, shp[p++]);
                        else if (t === 3) { attrs.set(a, u16(shp, p)); p += 2; }
                    }
                    const mi = attrs.has(PNMTXIDX) ? slots[Math.floor(attrs.get(PNMTXIDX)! / 3)] : def;
                    verts.push([mi, attrs]);
                }
                if (prim === 0x90) { for (let i = 0; i + 2 < n; i += 3) tris.push(first + i, first + i + 1, first + i + 2); }
                else if (prim === 0x98) { for (let i = 0; i < n - 2; i++) { if (i % 2 === 0) tris.push(first + i, first + i + 1, first + i + 2); else tris.push(first + i + 1, first + i, first + i + 2); } }
                else if (prim === 0xa0) { for (let i = 1; i < n - 1; i++) tris.push(first, first + i, first + i + 1); }
                else if (prim === 0x80) { for (let i = 0; i + 3 < n; i += 4) tris.push(first + i, first + i + 1, first + i + 2, first + i, first + i + 2, first + i + 3); }
            }
        }
        const posA = arrays.get(POS);
        if (!tris.length || !posA) continue;
        const nv = verts.length;
        const pos = new Float32Array(nv * 3);
        const mats = verts.map(([mi]) => (mi < drawMtx.length ? drawMtx[mi] : eye4()));
        const clampI = (i: number, len: number) => Math.min(Math.max(i, 0), len - 1);
        for (let v = 0; v < nv; v++) {
            const pi = clampI(verts[v][1].get(POS) ?? 0, posA.n), M = mats[v];
            const x = posA.d[pi * 3], y = posA.d[pi * 3 + 1], z = posA.d[pi * 3 + 2];
            for (let r = 0; r < 3; r++) pos[v * 3 + r] = M[r * 4] * x + M[r * 4 + 1] * y + M[r * 4 + 2] * z + M[r * 4 + 3];
        }
        const mesh: Mesh = { shape: si, material: shapeMat.has(si) ? shapeMat.get(si)! : -1, pos, tris: Uint32Array.from(tris), uv: new Map(), drw: Int32Array.from(verts.map(([mi]) => mi)) };
        for (let a = TEX0; a < TEX0 + 8; a++) {
            const A = arrays.get(a);
            if (!A || !verts.some(([, at]) => at.has(a))) continue;
            const uv = new Float32Array(nv * 2);
            for (let v = 0; v < nv; v++) { const ti = clampI(verts[v][1].get(a) ?? 0, A.n); uv[v * 2] = A.d[ti * A.c]; uv[v * 2 + 1] = A.d[ti * A.c + 1]; }
            mesh.uv.set(a, uv);
        }
        for (const na of [NRM, NBT]) {
            const A = arrays.get(na);
            if (!A || !verts.some(([, at]) => at.has(na))) continue;
            const nrm = new Float64Array(nv * 3);
            for (let v = 0; v < nv; v++) {
                const ni = clampI(verts[v][1].get(na) ?? 0, A.n), M = mats[v];
                const x = A.d[ni * A.c], y = A.d[ni * A.c + 1], z = A.d[ni * A.c + 2];
                const r0 = M[0] * x + M[1] * y + M[2] * z, r1 = M[4] * x + M[5] * y + M[6] * z, r2 = M[8] * x + M[9] * y + M[10] * z;
                const l = Math.max(Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2), 1e-6);   // (np.linalg.norm)
                nrm[v * 3] = r0 / l; nrm[v * 3 + 1] = r1 / l; nrm[v * 3 + 2] = r2 / l;
            }
            mesh.nrm = nrm;
            break;
        }
        const C = arrays.get(CLR0);
        if (C && verts.some(([, at]) => at.has(CLR0))) {
            const col = new Uint8Array(nv * 4);
            for (let v = 0; v < nv; v++) { const ci = clampI(verts[v][1].get(CLR0) ?? 0, C.n); col.set(C.d.subarray(ci * 4, ci * 4 + 4) as Uint8Array, v * 4); }
            mesh.color = col;
        }
        m.meshes.push(mesh);
    }
    return m;
}

function decodeColors(raw: Bytes, ctype: number): Uint8Array {
    const size = ({ 0: 2, 1: 3, 2: 4, 3: 2, 4: 3, 5: 4 } as Record<number, number>)[ctype];
    const n = Math.floor(raw.length / size), out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const b = raw.subarray(i * size, i * size + size), o = i * 4;
        if (ctype === 5 || ctype === 2) { out[o] = b[0]; out[o + 1] = b[1]; out[o + 2] = b[2]; out[o + 3] = ctype === 2 ? 255 : b[3]; }
        else if (ctype === 1) { out[o] = b[0]; out[o + 1] = b[1]; out[o + 2] = b[2]; out[o + 3] = 255; }
        else if (ctype === 0) gxt.rgb565((b[0] << 8) | b[1], out, o);
        else if (ctype === 3) { const v = (b[0] << 8) | b[1]; out[o] = ((v >> 12) & 15) * 17; out[o + 1] = ((v >> 8) & 15) * 17; out[o + 2] = ((v >> 4) & 15) * 17; out[o + 3] = (v & 15) * 17; }
        else { const v = (b[0] << 16) | (b[1] << 8) | b[2]; const c = [(v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63]; for (let q = 0; q < 4; q++) out[o + q] = (c[q] << 2) | (c[q] >> 4); }
    }
    return out;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
function parseIndirect(ind: Bytes, base: number, i: number) {
    const o = base + i * 0x138;
    if (o + 0x138 > ind.length || ind[o] !== 1 || !ind[o + 1]) return null;
    const n = ind[o + 1];
    const order = [0, 1, 2, 3].map((j) => [ind[o + 4 + j * 4], ind[o + 5 + j * 4]]);
    const mtx = [0, 1, 2].map((j) => { const mo = o + 0x14 + j * 0x1c; return [...[0, 1, 2, 3, 4, 5].map((q) => round6(f32(ind, mo + q * 4))), (ind[mo + 0x18] << 24) >> 24]; });
    const sc = [0, 1, 2, 3].map((j) => [ind[o + 0x68 + j * 4], ind[o + 0x69 + j * 4]]);
    const tev = Array.from({ length: 16 }, (_, j) => Array.from(ind.subarray(o + 0x78 + j * 0x0c, o + 0x78 + j * 0x0c + 9)));
    return { n, ord: order.slice(0, n), sc: sc.slice(0, n), mtx, tev };
}

function texMatrix(mat: Bytes, tbl: number, idx: number): number[] {
    const o = tbl + idx * 0x64, info = mat[o + 1];
    const cs = f32(mat, o + 4), ct = f32(mat, o + 8), ss = f32(mat, o + 0x10), st = f32(mat, o + 0x14);
    const r = (s16(mat, o + 0x18) / 0x7fff) * Math.PI, ts = f32(mat, o + 0x1c), tt = f32(mat, o + 0x20);
    const c = Math.cos(r), s = Math.sin(r);
    if (info >> 7) return [ss * c, ss * s, ss * (-0.5 * c - (0.5 * s - 0.5) - ts), st * -s, st * c, st * (-0.5 * c + (0.5 * s - 0.5) + tt) + 1.0];
    const a00 = ss * c, a01 = ss * -s, a10 = st * s, a11 = st * c;
    return [a00, a01, ts + cs - (a00 * cs + a01 * ct), a10, a11, tt + ct - (a10 * cs + a11 * ct)];
}

function parseMaterials(mat: Bytes): Material[] {
    const count = u16(mat, 8), entries = u32(mat, 0x0c), remap = u32(mat, 0x10);
    const names = stringTable(mat, u32(mat, 0x14));
    const cullO = u32(mat, 0x1c), matcolO = u32(mat, 0x20), chanO = u32(mat, 0x28);
    const texcoordO = u32(mat, 0x38), texmtxO = u32(mat, 0x40), texnoO = u32(mat, 0x48), tevorderO = u32(mat, 0x4c);
    const alphacmpO = u32(mat, 0x6c), blendO = u32(mat, 0x70);
    const out: Material[] = [];
    for (let i = 0; i < count; i++) {
        const e = entries + 0x14c * u16(mat, remap + i * 2);
        const mode = mat[e], cull = u32(mat, cullO + mat[e + 1] * 4);
        const mc = u16(mat, e + 8);
        const matColor = mc !== 0xffff ? Array.from(mat.subarray(matcolO + mc * 4, matcolO + mc * 4 + 4)) : [255, 255, 255, 255];
        const ch = u16(mat, e + 0x0c);
        const useVtx = ch !== 0xffff ? mat[chanO + ch * 8 + 1] === 1 : true;
        const texgens: (number[] | null)[] = [];
        for (let j = 0; j < 8; j++) { const ti = s16(mat, e + 0x28 + j * 2); if (ti < 0) { texgens.push(null); continue; } const to = texcoordO + ti * 4; texgens.push([mat[to], mat[to + 1], mat[to + 2]]); }
        const texmtx: (number[] | null)[] = [];
        for (let j = 0; j < 8; j++) { const ti = s16(mat, e + 0x48 + j * 2); texmtx.push(texmtxO && ti >= 0 ? texMatrix(mat, texmtxO, ti) : null); }
        const texnos: number[] = [];
        for (let j = 0; j < 8; j++) { const ti = u16(mat, e + 0x84 + j * 2); texnos.push(ti !== 0xffff ? u16(mat, texnoO + ti * 2) : -1); }
        const stages: [number, number][] = [], tevStages: TevStage[] = [];
        const tevcolorO = u32(mat, 0x50), kcolorO = u32(mat, 0x54), stageO = u32(mat, 0x5c);
        for (let j = 0; j < 16; j++) {
            const si = s16(mat, e + 0xe4 + j * 2);
            if (si < 0) continue;
            const oi = u16(mat, e + 0xbc + j * 2), oo = tevorderO + oi * 4;
            stages.push([mat[oo], mat[oo + 1]]);
            const so = stageO + si * 0x14, tm = mat[oo + 1];
            tevStages.push({ texmap: tm < 8 ? texnos[tm] : -1, chan: mat[oo + 2], c: Array.from(mat.subarray(so + 1, so + 10)), a: Array.from(mat.subarray(so + 10, so + 19)), kc: mat[e + 0x9c + j], ka: mat[e + 0xac + j] });
        }
        const regs: number[][] = [];
        for (let j = 0; j < 4; j++) { const ti = u16(mat, e + 0xdc + j * 2); regs.push(ti !== 0xffff && tevcolorO ? [0, 1, 2, 3].map((q) => s16(mat, tevcolorO + ti * 8 + q * 2)) : [0, 0, 0, 0]); }
        const kregs: number[][] = [];
        for (let j = 0; j < 4; j++) { const ti = u16(mat, e + 0x94 + j * 2); kregs.push(ti !== 0xffff && kcolorO ? Array.from(mat.subarray(kcolorO + ti * 4, kcolorO + ti * 4 + 4)) : [255, 255, 255, 255]); }
        const tev = { stages: tevStages, regs, kregs };
        const used: TexEntry[] = [];
        for (const [tc, tm] of stages) {
            if (tm !== 0xff && tm < 8 && texnos[tm] >= 0 && tc < 8 && texgens[tc]) {
                const [, src, gmtx] = texgens[tc]!;
                if (src >= 4 && src <= 11) {
                    const entry: TexEntry = [texnos[tm], TEX0 + (src - 4), gmtx !== 60 ? texmtx[tc] : null];
                    if (used.every((u) => u[0] !== entry[0])) used.push(entry);
                }
            }
        }
        const ac = alphacmpO + u16(mat, e + 0x146) * 8;
        const comp = mat[ac], ref = mat[ac + 1];
        const alphaRef = comp === 7 ? null : Math.max(ref, 1) / 255;
        const bm = blendO + u16(mat, e + 0x148) * 4;
        const blend = mat[bm] === 1 && mode === 4 && !(mat[bm + 1] === 1 && mat[bm + 2] === 0);
        const mo: Material = {
            name: i < names.length ? names[i] : `mat${i}`, translucent: mode === 4, alphaRef, blend, useVertexColor: useVtx, matColor,
            base: used[0] || null, layer: used[1] || null, cull, used, tev, lit: false, litMask: 0, ambVtx: false, diffFn: 0, env: [], blendMode: [0, 1, 0, 3], gx: null,
        };
        const texmtxRaw: (number[] | null)[] = [];
        for (let j = 0; j < 8; j++) {
            const ti = s16(mat, e + 0x48 + j * 2);
            if (ti >= 0 && texmtxO) { const o = texmtxO + ti * 0x64; texmtxRaw.push([mat[o + 1], f32(mat, o + 0x10), f32(mat, o + 0x14), f32(mat, o + 0x1c), f32(mat, o + 0x20)]); }
            else texmtxRaw.push(null);
        }
        stages.forEach(([tc, tm], sti) => {
            const ts = tevStages[sti];
            if (tm >= 8 || texnos[tm] < 0 || tc >= 8 || !texgens[tc] || texgens[tc]![1] !== 1) return;
            const gm = texgens[tc]![2];
            const tmx = gm >= 30 && gm < 60 && (gm - 30) % 3 === 0 ? texmtxRaw[(gm - 30) / 3] : null;
            if (ts.c[0] !== 15 || ts.c[1] !== 14 || ts.c[2] !== 8) return;
            const ksel = ts.kc;
            let kcol: number[];
            if (ksel >= 0x0c && ksel <= 0x0f) kcol = kregs[ksel - 0x0c].slice(0, 3);
            else if (ksel >= 0x10 && ksel <= 0x1f) { const v = kregs[(ksel - 0x10) % 4][Math.floor((ksel - 0x10) / 4)]; kcol = [v, v, v]; }
            else kcol = [255, 255, 255];
            mo.env.push({ tex: texnos[tm], k: kcol, s: tmx ? [tmx[1], tmx[2]] : [1.0, 1.0], t: tmx ? [tmx[3], tmx[4]] : [0.0, 0.0] });
        });
        if (ch !== 0xffff) {
            const c0 = mat.subarray(chanO + ch * 8, chanO + ch * 8 + 6);
            mo.lit = !!c0[0]; mo.litMask = c0[2]; mo.diffFn = c0[3]; mo.ambVtx = c0[5] === 1;
        }
        mo.blendMode = Array.from(mat.subarray(bm, bm + 4));
        const ambO = u32(mat, 0x2c);
        const chans: (number[] | null)[] = [];
        for (let j = 0; j < 4; j++) { const ci = u16(mat, e + 0x0c + j * 2); chans.push(ci !== 0xffff ? Array.from(mat.subarray(chanO + ci * 8, chanO + ci * 8 + 6)) : null); }
        const colAt = (base: number, idx: number, def: number[]) => (idx !== 0xffff && base ? Array.from(mat.subarray(base + idx * 4, base + idx * 4 + 4)) : def);
        mo.gx = {
            chans, matc: [0, 1].map((j) => colAt(matcolO, u16(mat, e + 8 + j * 2), [255, 255, 255, 255])),
            amb: [0, 1].map((j) => colAt(ambO, u16(mat, e + 0x14 + j * 2), [0, 0, 0, 0])),
            texgens, texmtx, texmtx_raw: texmtxRaw, texnos, orders: stages, acmp: Array.from(mat.subarray(ac, ac + 5)),
        };
        out.push(mo);
    }
    return out;
}
