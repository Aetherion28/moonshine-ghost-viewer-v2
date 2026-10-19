// The disc formats the HUD reads, decoded by hand so the HUD bundle needs no WebAssembly: BTI
// textures (the GX formats the 2D files use: I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CMPR),
// BFN fonts (JUTResFont: INF1, WID1, MAP1, GLY1), BMG messages (INF1 / DAT1) and JDrama .prm
// parameter files.

export interface Tex { w: number; h: number; rgba: Uint8ClampedArray; /** ResTIMG's alpha flag: the TEV takes the texture's alpha (else 255) */ alpha: boolean; }

const BLOCK: Record<number, [number, number]> = { 0: [8, 8], 1: [8, 4], 2: [8, 4], 3: [4, 4], 4: [4, 4], 5: [4, 4], 6: [4, 4], 14: [8, 8] };
/** decode GX texture data of format fmt (w x h) at src[o..] to RGBA */
export function decodeGX(fmt: number, w: number, h: number, src: Uint8Array, o: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * h * 4);
    const [bw, bh] = BLOCK[fmt] || [4, 4];
    const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
        if (x >= w || y >= h) return;
        const i = (y * w + x) * 4; out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    };
    const c565 = (v: number): [number, number, number] => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
    let p = o;
    for (let by = 0; by < h; by += bh) for (let bx = 0; bx < w; bx += bw) {
        if (fmt === 0) {   // I4
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) { const v = src[p++]; const a = (v >> 4) * 17, b = (v & 15) * 17; put(bx + x, by + y, a, a, a, a); put(bx + x + 1, by + y, b, b, b, b); }
        } else if (fmt === 1) {   // I8
            for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { const v = src[p++]; put(bx + x, by + y, v, v, v, v); }
        } else if (fmt === 2) {   // IA4
            for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { const v = src[p++]; const i = (v & 15) * 17; put(bx + x, by + y, i, i, i, (v >> 4) * 17); }
        } else if (fmt === 3) {   // IA8
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const a = src[p], i = src[p + 1]; p += 2; put(bx + x, by + y, i, i, i, a); }
        } else if (fmt === 4) {   // RGB565
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const [r, g, b] = c565((src[p] << 8) | src[p + 1]); p += 2; put(bx + x, by + y, r, g, b, 255); }
        } else if (fmt === 5) {   // RGB5A3
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
                const v = (src[p] << 8) | src[p + 1]; p += 2;
                if (v & 0x8000) put(bx + x, by + y, ((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0, 255);
                else put(bx + x, by + y, ((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 7) * 255 / 7 | 0);
            }
        } else if (fmt === 6) {   // RGBA8: an AR block then a GB block
            for (let i = 0; i < 16; i++) { const x = i & 3, y = i >> 2; put(bx + x, by + y, src[p + i * 2 + 1], src[p + 32 + i * 2], src[p + 32 + i * 2 + 1], src[p + i * 2]); }
            p += 64;
        } else if (fmt === 14) {   // CMPR: 2x2 DXT1 sub-blocks
            for (let s = 0; s < 4; s++) {
                const c0 = (src[p] << 8) | src[p + 1], c1 = (src[p + 2] << 8) | src[p + 3];
                const a = c565(c0), b = c565(c1);
                const pal: number[][] = [[...a, 255], [...b, 255]];
                if (c0 > c1) { pal.push([(2 * a[0] + b[0]) / 3 | 0, (2 * a[1] + b[1]) / 3 | 0, (2 * a[2] + b[2]) / 3 | 0, 255], [(a[0] + 2 * b[0]) / 3 | 0, (a[1] + 2 * b[1]) / 3 | 0, (a[2] + 2 * b[2]) / 3 | 0, 255]); }
                else pal.push([(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1, 255], [0, 0, 0, 0]);
                const sx = bx + (s & 1) * 4, sy = by + (s >> 1) * 4;
                for (let y = 0; y < 4; y++) { const row = src[p + 4 + y]; for (let x = 0; x < 4; x++) { const c = pal[(row >> (6 - x * 2)) & 3]; put(sx + x, sy + y, c[0], c[1], c[2], c[3]); } }
                p += 8;
            }
        } else throw new Error(`hud: texture format ${fmt}`);
    }
    return out;
}

export function parseBTI(b: Uint8Array): Tex {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const fmt = b[0], w = dv.getUint16(2), h = dv.getUint16(4), off = dv.getUint32(0x1C);
    return { w, h, rgba: decodeGX(fmt, w, h, b, off || 0x20), alpha: b[1] !== 0 };
}

export interface Glyph { sheet: number; x: number; y: number; }
export class Font {
    type = 0; ascent = 0; descent = 0; width = 0; leading = 0; defaultCode = 0;
    cellW = 0; cellH = 0;
    sheets: Tex[] = [];
    private gly: { start: number; end: number; cw: number; ch: number; perRow: number; perPage: number; first: number }[] = [];
    private wid: { start: number; end: number; o: number }[] = [];
    private map: { method: number; start: number; end: number; n: number; o: number }[] = [];
    private dv: DataView;
    private maxCode = 0;
    constructor(private b: Uint8Array) {
        const dv = this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const str4 = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
        if (str4(0) !== 'FONT') throw new Error('hud: not a font');
        let o = 0x20;
        while (o + 8 <= b.length) {
            const k = str4(o), size = dv.getUint32(o + 4);
            if (!size) break;
            if (k === 'INF1') { this.type = dv.getUint16(o + 8); this.ascent = dv.getUint16(o + 10); this.descent = dv.getUint16(o + 12); this.width = dv.getUint16(o + 14); this.leading = dv.getUint16(o + 16); this.defaultCode = dv.getUint16(o + 18); }
            else if (k === 'WID1') this.wid.push({ start: dv.getUint16(o + 8), end: dv.getUint16(o + 10), o: o + 12 });
            else if (k === 'MAP1') { const m = { method: dv.getUint16(o + 8), start: dv.getUint16(o + 10), end: dv.getUint16(o + 12), n: dv.getUint16(o + 14), o: o + 16 }; this.map.push(m); this.maxCode = Math.max(this.maxCode, m.end); }
            else if (k === 'GLY1') {
                const start = dv.getUint16(o + 8), end = dv.getUint16(o + 10), cw = dv.getUint16(o + 12), ch = dv.getUint16(o + 14), texSize = dv.getUint32(o + 16), fmt = dv.getUint16(o + 20);
                const perRow = dv.getUint16(o + 22), cols = dv.getUint16(o + 24), tw = dv.getUint16(o + 26), th = dv.getUint16(o + 28);
                const pages = Math.ceil((end - start + 1) / (perRow * cols));
                this.gly.push({ start, end, cw, ch, perRow, perPage: perRow * cols, first: this.sheets.length });
                this.cellW = cw; this.cellH = ch;
                for (let i = 0; i < pages; i++) {
                    const tex: Tex = { w: tw, h: th, rgba: decodeGX(fmt, tw, th, b, o + 32 + i * texSize), alpha: true };
                    // (the J2D text TEV: the glyph's intensity as alpha, white)
                    if (fmt === 0 || fmt === 1) for (let p = 0; p < tex.rgba.length; p += 4) { tex.rgba[p] = tex.rgba[p + 1] = tex.rgba[p + 2] = 255; }
                    this.sheets.push(tex);
                }
            }
            o += size;
        }
    }
    /** JUTResFont::getFontCode */
    code(chr: number) {
        const HALF = [0x8140, 0x8149, 0x8168, 0x8194, 0x8190, 0x8193, 0x8195, 0x8166, 0x8169, 0x816A, 0x8196, 0x817B, 0x8143, 0x817C, 0x8144, 0x815E, 0x824F, 0x8250, 0x8251, 0x8252, 0x8253, 0x8254, 0x8255, 0x8256, 0x8257, 0x8258, 0x8146, 0x8147, 0x8183, 0x8181, 0x8184, 0x8148, 0x8197, 0x8260, 0x8261, 0x8262, 0x8263, 0x8264, 0x8265, 0x8266, 0x8267, 0x8268, 0x8269, 0x826A, 0x826B, 0x826C, 0x826D, 0x826E, 0x826F, 0x8270, 0x8271, 0x8272, 0x8273, 0x8274, 0x8275, 0x8276, 0x8277, 0x8278, 0x8279, 0x816D, 0x818F, 0x816E, 0x814F, 0x8151, 0x8165, 0x8281, 0x8282, 0x8283, 0x8284, 0x8285, 0x8286, 0x8287, 0x8288, 0x8289, 0x828A, 0x828B, 0x828C, 0x828D, 0x828E, 0x828F, 0x8290, 0x8291, 0x8292, 0x8293, 0x8294, 0x8295, 0x8296, 0x8297, 0x8298, 0x8299, 0x829A, 0x816F, 0x8162, 0x8170, 0x8160];
        if (this.type === 2 && this.maxCode >= 0x8000 && chr >= 0x20 && chr < 0x7F) chr = HALF[chr - 32];
        const dv = this.dv;
        for (const m of this.map) {
            if (chr < m.start || chr > m.end) continue;
            if (m.method === 0) return chr - m.start;
            if (m.method === 2) return dv.getUint16(m.o + (chr - m.start) * 2);
            if (m.method === 3) {
                let lo = 0, hi = m.n - 1;
                while (hi >= lo) { const mid = (lo + hi) >> 1, c = dv.getUint16(m.o + mid * 4); if (chr < c) hi = mid - 1; else if (chr > c) lo = mid + 1; else return dv.getUint16(m.o + mid * 4 + 2); }
                return this.defaultCode;
            }
            if (m.method === 1) { const hi = chr >> 8; let lo = (chr & 0xff) - 0x40; if (lo >= 0x40) lo--; return lo + (hi - 0x88) * 0xBC + 0x2BE; }
            return this.defaultCode;
        }
        return this.defaultCode;
    }
    /** a character's [kerning, advance] (WID1) */
    widthOf(code: number): [number, number] {
        for (const w of this.wid) if (code >= w.start && code <= w.end) { const i = w.o + (code - w.start) * 2; return [this.b[i], this.b[i + 1]]; }
        return [0, this.width];
    }
    glyph(code: number): Glyph | null {
        for (const g of this.gly) {
            if (code < g.start || code > g.end) continue;
            const c = code - g.start, page = (c / g.perPage) | 0, cell = c % g.perPage, row = (cell / g.perRow) | 0, col = cell - row * g.perRow;
            return { sheet: g.first + page, x: col * g.cw, y: row * g.ch };
        }
        return null;
    }
}

/** SMSGetMessageData: message i of a BMG (Shift-JIS text, the 0x1A control codes left out) */
export function bmgMessage(b: Uint8Array, i: number): string | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const str4 = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    let inf = -1, dat = -1, o = 0x20;
    while (o + 8 <= b.length) { const k = str4(o), size = dv.getUint32(o + 4); if (k === 'INF1') inf = o; if (k === 'DAT1') dat = o; if (!size) break; o += size; }
    if (inf < 0 || dat < 0) return null;
    const n = dv.getUint16(inf + 8), es = dv.getUint16(inf + 10);
    if (i < 0 || i >= n) return null;
    let p = dat + 8 + dv.getUint32(inf + 16 + i * es);
    const bytes: number[] = [];
    while (p < b.length && b[p] !== 0) {
        if (b[p] === 0x1A) { p += b[p + 1]; continue; }
        bytes.push(b[p++]);
    }
    return sjisDecode(new Uint8Array(bytes));
}
let _dec: TextDecoder | null = null;
export function sjisDecode(b: Uint8Array) { try { _dec ||= new TextDecoder('shift_jis'); return _dec.decode(b); } catch { return String.fromCharCode(...b); } }
let _enc: Map<string, number> | null = null;
/** Shift-JIS codes of a string (from a table built by decoding every double-byte code once) */
export function sjisCodes(s: string): number[] {
    if (!_enc) {
        _enc = new Map();
        try {
            const d = new TextDecoder('shift_jis');
            for (let c = 0x20; c < 0x7F; c++) _enc.set(String.fromCharCode(c), c);
            for (let hi = 0x81; hi <= 0xEF; hi++) {
                if (hi >= 0xA0 && hi <= 0xDF) { _enc.set(d.decode(new Uint8Array([hi])), hi); continue; }
                for (let lo = 0x40; lo <= 0xFC; lo++) { if (lo === 0x7F) continue; const ch = d.decode(new Uint8Array([hi, lo])); if (ch.length === 1 && ch !== '�' && !_enc.has(ch)) _enc.set(ch, (hi << 8) | lo); }
            }
        } catch { /* no Shift-JIS decoder */ }
    }
    const out: number[] = [];
    for (const ch of s) out.push(_enc.get(ch) ?? ch.charCodeAt(0));
    return out;
}

/** a JDrama .prm (TParams): its values by name, read as f32 / s32 / s16 / u8 by the caller's types */
export function parsePrm(b: Uint8Array): Map<string, DataView> {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Map<string, DataView>();
    const n = dv.getUint32(0);
    let o = 4;
    for (let i = 0; i < n && o + 4 <= b.length; i++) {
        const len = dv.getUint16(o + 2); o += 4;
        let name = ''; for (let k = 0; k < len; k++) name += String.fromCharCode(b[o + k]);
        o += len;
        const size = dv.getUint32(o); o += 4;
        out.set(name, new DataView(b.buffer, b.byteOffset + o, size));
        o += size;
    }
    return out;
}
export const prmF = (m: Map<string, DataView> | null, k: string, d: number) => { const v = m && m.get(k); return v && v.byteLength >= 4 ? v.getFloat32(0) : d; };
export const prmI = (m: Map<string, DataView> | null, k: string, d: number) => { const v = m && m.get(k); return v && v.byteLength >= 4 ? v.getInt32(0) : v && v.byteLength >= 2 ? v.getInt16(0) : d; };
