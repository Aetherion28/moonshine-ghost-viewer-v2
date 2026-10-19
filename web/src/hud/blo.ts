// J2D screen layouts (.blo, "SCRN" "blo1"), as J2DScreen::makeHiearachyPanes reads them: a tree of
// panes (PAN1), pictures (PIC1), windows (WIN1) and text boxes (TBX1), BGN1 / END1 bracketing each
// pane's children. Panes keep the fields J2DPane / J2DPicture / J2DTextBox read from the stream.

export type PaneKind = 'PAN1' | 'PIC1' | 'WIN1' | 'TBX1';
export interface Rect { x1: number; y1: number; x2: number; y2: number; }
export class Pane {
    kind: PaneKind = 'PAN1';
    /** mUserInfoTag: the four-character tag search() finds it by */
    tag = 0;
    visible = true;
    bounds: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };
    rotation = 0; basePosition = 0; rotOffX = 0; rotOffY = 0;
    alpha = 255; inheritAlpha = true;
    /** J2DPane::draw's results: bounds on the screen, and the alpha drawn with */
    global: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };
    colorAlpha = 255;
    parent: Pane | null = null;
    children: Pane[] = [];
    // PIC1 (J2DPicture)
    tex: string | null = null; binding = 0; mirror = 0; rotate90 = false; wrapH = 0; wrapV = 0;
    black = 0x00000000; white = 0xFFFFFFFF; corner = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
    // TBX1 (J2DTextBox)
    font: string | null = null; charColor = 0xFFFFFFFF; gradColor = 0xFFFFFFFF; hBind = 0; vBind = 0;
    charSpace = 0; lineSpace = 0; fontW = 0; fontH = 0; text = '';
    /** J2DPicture::changeTexture's replacements (a texture name) */
    get width() { return this.bounds.x2 - this.bounds.x1; }
    get height() { return this.bounds.y2 - this.bounds.y1; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    move(x: number, y: number) { const w = this.width, h = this.height; this.bounds = { x1: x, y1: y, x2: x + w, y2: y + h }; }
    add(x: number, y: number) { this.bounds = { x1: this.bounds.x1 + x, y1: this.bounds.y1 + y, x2: this.bounds.x2 + x, y2: this.bounds.y2 + y }; }
    resize(w: number, h: number) { this.bounds = { x1: this.bounds.x1, y1: this.bounds.y1, x2: this.bounds.x1 + w, y2: this.bounds.y1 + h }; }
    setBounds(r: Rect) { this.bounds = { ...r }; }
    setBasePosition(p: number) {
        this.basePosition = p;
        this.rotOffX = p % 3 === 0 ? 0 : p % 3 === 1 ? (this.width / 2) | 0 : this.width;
        const v = (p / 3) | 0;
        this.rotOffY = v === 0 ? 0 : v === 1 ? (this.height / 2) | 0 : this.height;
    }
    search(tag: number): Pane | null {
        if (tag === this.tag) return this;
        for (const c of this.children) { const r = c.search(tag); if (r) return r; }
        return null;
    }
    detach() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
}
export class Screen extends Pane {
    color = 0;
    /** J2DScreen::search with the '\0abc' style tags written as plain strings */
    find(tag: string | number): Pane {
        const p = this.search(typeof tag === 'number' ? tag : tagOf(tag));
        if (!p) throw new Error(`blo: no pane ${typeof tag === 'number' ? tag.toString(16) : tag}`);
        return p;
    }
}
/** 'c_ba' → 0x635F6261; a three-letter tag is '\0' + the letters, as the game writes them. */
export function tagOf(s: string) { let v = 0; for (const ch of s.padStart(4, '\0')) v = ((v << 8) | ch.charCodeAt(0)) >>> 0; return v; }

export function parseBlo(buf: Uint8Array): Screen {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const str4 = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (str4(0) !== 'SCRN' || str4(4) !== 'blo1') throw new Error('blo: not a blo1 screen');
    const scr = new Screen();
    let o = 0x20;
    if (str4(o) !== 'INF1') throw new Error('blo: no INF1');
    scr.bounds = { x1: 0, y1: 0, x2: dv.getInt16(o + 8), y2: dv.getInt16(o + 10) };
    scr.color = dv.getUint32(o + 12);
    o += dv.getUint32(o + 4);
    const resName = (p: number): [string | null, number] => {   // JUTResReference: type, length, name
        const type = buf[p], len = buf[p + 1];
        let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(buf[p + 2 + i]);
        return [type === 0 || !len ? null : s, p + 2 + len];
    };
    const level = (parent: Pane) => {
        let last: Pane = parent;
        while (o < buf.length) {
            const kind = str4(o), size = dv.getUint32(o + 4), next = o + size;
            if (kind === 'EXT1') { o = next; return; }
            if (kind === 'END1') { o = next; return; }
            if (kind === 'BGN1') { o = next; level(last); continue; }
            if (kind === 'PAN1' || kind === 'PIC1' || kind === 'WIN1' || kind === 'TBX1') {
                const p = new Pane();
                p.kind = kind;
                let q = o + 8;
                let fields = buf[q]; p.visible = !!buf[q + 1]; q += 4;
                p.tag = dv.getUint32(q); q += 4;
                const x = dv.getInt16(q), y = dv.getInt16(q + 2), w = dv.getInt16(q + 4), h = dv.getInt16(q + 6); q += 8;
                p.bounds = { x1: x, y1: y, x2: x + w, y2: y + h };
                fields -= 6;
                if (fields) { p.rotation = dv.getUint16(q); q += 2; fields--; }
                let base = 0;
                if (fields) { base = buf[q++]; fields--; }
                p.setBasePosition(base);
                if (fields) { p.alpha = buf[q++]; fields--; }
                if (fields) { p.inheritAlpha = !!buf[q++]; fields--; }
                q = (q + 3) & ~3;
                q = o + ((q - o + 3) & ~3);
                if (kind === 'PIC1') {
                    let f = buf[q++];
                    [p.tex, q] = resName(q);
                    [, q] = resName(q);   // (TLUT)
                    p.binding = buf[q++]; f -= 3;
                    if (f) { const m = buf[q++]; p.mirror = m & 3; p.rotate90 = !!(m & 4); f--; }
                    if (f) { const wm = buf[q++]; p.wrapH = (wm >> 2) & 3; p.wrapV = wm & 3; f--; }
                    if (f) { p.black = dv.getUint32(q); q += 4; f--; }
                    if (f) { p.white = dv.getUint32(q); q += 4; f--; }
                    for (let i = 0; f && i < 4; i++) { p.corner[i] = dv.getUint32(q); q += 4; f--; }
                } else if (kind === 'TBX1') {
                    let f = buf[q++];
                    [p.font, q] = resName(q);
                    p.charColor = dv.getUint32(q); p.gradColor = dv.getUint32(q + 4); q += 8;
                    const b = buf[q++]; p.hBind = (b >> 2) & 3; p.vBind = b & 3;
                    p.charSpace = dv.getInt16(q); p.lineSpace = dv.getInt16(q + 2); p.fontW = dv.getUint16(q + 4); p.fontH = dv.getUint16(q + 6); q += 8;
                    const len = dv.getUint16(q); q += 2;
                    p.text = sjis(buf.subarray(q, q + len)); q += len;
                    f -= 10;
                    if (f) { q++; f--; }
                    if (f) { p.black = dv.getUint32(q); q += 4; f--; }
                    if (f) { p.white = dv.getUint32(q); q += 4; f--; }
                }
                p.parent = parent; parent.children.push(p);
                last = p;
            }
            o = next;
        }
    };
    level(scr);
    return scr;
}
let _sjis: TextDecoder | null = null;
export function sjis(b: Uint8Array) {
    try { _sjis ||= new TextDecoder('shift_jis'); return _sjis.decode(b); } catch { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; }
}
