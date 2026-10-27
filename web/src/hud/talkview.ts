// The talk window drawn as TTalk2D2::perform's CUE_DRAW draws it (GC2D/Talk2D2.cpp), from the
// simulated window's state (game/talk.ts Talk2D: its panes' visibility and alpha, the state, the
// characters of the page and their colours): message_2.blo (the window me_0 at unk330 / unk332,
// turned unk334, its three lines me_1..3, each a box bac1..3 and the next arrow cu_1..3; the yes /
// no box me_4) and message_board_1.blo for a signpost (mb_0 on its TBoundPane, its text).
//
// - The characters: 90 J2DTextBoxes (20 x 20, the system font at its own size, HBIND_LEFT /
//   VBIND_CENTER), each a child of its line's pane, placed by makeBoxLine along the line's curve
//   (the quadratic through f_1 / f_2 / f_3 of the layout, f_2 raised by unk220): its width from the
//   font's width entry of its first byte (0.7 x width + 4 a step, over the curve's length), turned by
//   the curve's slope; coloured unk27C (setBlackWhite(colour & ~0xFF, colour) and the colour itself).
// - openWindow (state 4): each line's box swept in, message_back_0's shape masked by message_back_1
//   moved along by the line's unk234, in TEVREG1's blue at alpha 0xA0.
// - The yes / no box: slct's two answers, the chosen one's colour pulsed by its cursor's alpha
//   (moveTalkWindow's escape codes), sc_1 / sc_2 the cursors.

import { Pane, Screen } from './blo.js';
import { Painter, M, mul } from './draw.js';
import { Font, Tex, sjisDecode } from './gx.js';

const tagStr = (p: Pane) => { let s = ''; for (let i = 3; i >= 0; i--) { const c = (p.tag >>> (i * 8)) & 255; if (c) s += String.fromCharCode(c); } return s; };
const f32 = Math.fround;
const rnd = (v: number) => Math.trunc(v + (v > 0 ? 0.5 : -0.5));

export class TalkView {
    private me0: Pane; private me: Pane[]; private bac: Pane[]; private cu: Pane[]; private cc: Pane[]; private cs: Pane[];
    private me4: Pane; private slct: Pane; private sc: Pane[];
    private mb0: Pane; private text: Pane; private bcu: Pane; private bcc: Pane; private bcs: Pane;
    private curve: { p0: number[]; p1: number[]; p2: number[] }[] = [];
    private unk94 = 0;
    private chars: Pane[] = [];
    private placed: string[] = ['', '', ''];
    private mb0Init: { x: number; y: number };
    constructor(public scr: Screen, public board: Screen, private font: Font, private back1: Tex | null, private back0: Tex | null) {
        const s = scr;
        this.me0 = s.find('me_0');
        this.me = [1, 2, 3].map((i) => s.find(`me_${i}`));
        this.bac = [1, 2, 3].map((i) => s.find(`bac${i}`));
        this.cu = [1, 2, 3].map((i) => s.find(`cu_${i}`));
        this.cc = [1, 2, 3].map((i) => s.find(`cc_${i}`));
        this.cs = [1, 2, 3].map((i) => s.find(`cs_${i}`));
        this.me4 = s.find('me_4'); this.slct = s.find('slct'); this.sc = [s.find('sc_1'), s.find('sc_2')];
        this.slct.fontOn = true;
        // the curve's points (loadAfter / makeBoxLine: f_1's top left, f_2's top raised by unk220 (0x1A), f_3's right less 10)
        for (let l = 0; l < 3; l++) {
            const a = s.find(`f_${1 + l * 3}`), b = s.find(`f_${2 + l * 3}`), c = s.find(`f_${3 + l * 3}`);
            this.curve.push({ p0: [a.bounds.x1, a.bounds.y1], p1: [0, b.bounds.y1 - 0x1A], p2: [c.bounds.x2 - 10, c.bounds.y1] });
            for (const p of [a, b, c]) p.hide();
        }
        // unk94: 1 / the curve's length (line 2's, in 100 steps)
        const C = this.curve[1];
        let len = f32(0), [px, py] = this.makeLine(0, C);
        for (let t = f32(0.01); t <= 1; t = f32(t + f32(0.01))) {
            const [x, y] = this.makeLine(t, C);
            len = f32(len + f32(Math.hypot(f32(x - px), f32(y - py))));
            px = x; py = y;
        }
        this.unk94 = f32(1 / len);
        for (let i = 0; i < 90; i++) {
            const p = new Pane();
            p.kind = 'TBX1'; p.bounds = { x1: 0, y1: 0, x2: 20, y2: 20 }; p.setBasePosition(4);
            p.fontOn = true; p.hBind = 2; p.vBind = 0; p.fontW = font.width; p.fontH = font.ascent + font.descent; p.lineSpace = font.leading;
            p.black = 0xFFFFFF00; p.white = 0xFFFFFFFF; p.visible = false;
            const line = this.me[Math.floor(i / 30)];
            p.parent = line; line.children.push(p);
            this.chars.push(p);
        }
        this.mb0 = board.find('mb_0'); this.text = board.find('text'); this.text.fontOn = true;
        this.bcu = board.find('cu_1'); this.bcc = board.find('cc_1'); this.bcs = board.find('cs_1');
        this.mb0Init = { x: this.mb0.bounds.x1, y: this.mb0.bounds.y1 };
    }
    private makeLine(t: number, C: { p0: number[]; p1: number[]; p2: number[] }): [number, number] {
        const inv = f32(1 - t);
        const k = (i: number) => f32(f32(f32(C.p0[i] * f32(inv * inv)) + f32(C.p1[i] * f32(f32(2 * t) * inv))) + f32(C.p2[i] * f32(t * t)));
        return [k(0), k(1)];
    }
    /** makeBoxLine(line, nullptr): the line's characters along its curve */
    private makeBoxLine(T: any, line: number) {
        const C = this.curve[line], f = this.font;
        let w = f32(0);
        let [px, py] = this.makeLine(w, C);
        for (let ci = 0; ci < 30; ci++) {
            const idx = ci + line * 30, box = T.unk9C[idx];
            const b0 = box && box.bytes && box.bytes.length ? box.bytes[0] : 0;
            if (!b0) break;
            // (the width entry of the first byte, sign-extended: a double-byte character's is the font's default)
            const code = b0 >= 0x80 ? (0xFF00 | b0) : b0;
            const [, adv] = f.widthOf(f.code(code));
            w = f32(w + f32(this.unk94 * f32(f32(0.7 * adv) + 4)));
            const [cx, cy] = this.makeLine(w, C);
            let ang = Math.abs(Math.atan2(f32(cy - py), f32(cx - px)));
            if (cx > 0) ang = -ang;
            const c = Math.cos(ang), s = Math.sin(ang);
            const x = f32(px * c - py * s), y = f32(px * s + py * c);
            const p = this.chars[idx];
            p.move(rnd(x) << 16 >> 16, (-0x25 - (rnd(y) << 16 >> 16)) << 16 >> 16);
            p.setBasePosition(4);
            p.rotation = (180 * ang) / Math.PI;
            if (w > 1.1) break;
            [px, py] = this.makeLine(w, C);
        }
    }
    /** TTalk2D2's CUE_DRAW (the director's unk124 2), or nothing */
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M, dir: any) {
        const T = dir && dir.talk;
        if (!T || dir.unk124 !== 2) return false;
        const st = T.unk248;
        if (st < 4 || st > 7) return false;
        if (T.unk28) return this.drawBoard(cx, P, base, T);
        // the panes as the window has them
        const s = this.scr;
        this.me0.move(T.winPos[0], T.winPos[1]); this.me0.rotation = (T.winPos[2] + 360) % 360;
        this.me0.alpha = T.unk90.alpha & 255;
        for (let i = 0; i < 3; i++) {
            this.bac[i].visible = T.unk3C[i].visible;
            this.cu[i].visible = T.unk6C[i].visible; this.cu[i].alpha = T.unk6C[i].alpha & 255;
            this.cc[i].visible = T.unk78[i].visible; this.cc[i].alpha = T.unk78[i].alpha & 255;
            this.cs[i].visible = T.unk84[i].visible; this.cs[i].alpha = T.unk84[i].alpha & 255;
        }
        this.me4.visible = T.unk204.visible; this.me4.alpha = T.unk204.alpha & 255;
        for (let i = 0; i < 2; i++) { this.sc[i].visible = T.unk20C[i].visible; this.sc[i].alpha = T.unk20C[i].alpha & 255; }
        // the page's characters (placed again when the page changes)
        for (let l = 0; l < 3; l++) {
            let key = '';
            for (let i = 0; i < 30; i++) { const b = T.unk9C[l * 30 + i]; key += (b.bytes || []).join('.') + ','; }
            if (key !== this.placed[l]) { this.placed[l] = key; this.makeBoxLine(T, l); }
        }
        for (let i = 0; i < 90; i++) {
            const b = T.unk9C[i], p = this.chars[i];
            p.visible = !!b.visible && !!(b.bytes && b.bytes.length);
            p.alpha = b.alpha & 255;
            if (p.visible) {
                p.text = sjisDecode(new Uint8Array(b.bytes));
                p.charColor = p.gradColor = b.color >>> 0; p.white = b.color >>> 0; p.black = (b.color & 0xFFFFFF00) >>> 0;
            }
        }
        // the yes / no answers (moveTalkWindow's: the chosen one's alpha its cursor's; setupTextBox's grey before)
        if (T.unk214 !== -1) {
            const a = T.unk218.map((x: string) => Array.from(x, (ch) => ch.charCodeAt(0) & 255));
            const esc = (cc: string) => Array.from(`\x1BCC[${cc}]\x1BGC[${cc}]`, (ch) => ch.charCodeAt(0));
            const hx = (v: number) => (v & 255).toString(16).padStart(2, '0');
            let bytes: number[];
            if (T.unk204.visible) {
                const col = T.unk20C[T.unk214].alpha;
                bytes = T.unk214 === 1 ? [...esc('ffffff60'), ...a[0], ...esc(`ffffff${hx(col)}`), 10, ...a[1]] : [...esc(`ffffff${hx(col)}`), ...a[0], 10, ...esc('ffffff60'), ...a[1]];
            } else bytes = T.unk214 === 0 ? [...a[0], 10, ...esc('7f7f7f'), ...a[1]] : [...esc('7f7f7f'), ...a[0], ...esc('ffffff'), 10, ...a[1]];
            this.slct.text = sjisDecode(new Uint8Array(bytes));
        }
        // the layout pass (the panes' matrices), the sweep (state 4), the screen
        P.drawScreen(cx, s, base, () => true);
        if (st === 4) for (let i = 0; i <= T.unk274 && i < 3; i++) this.openWindow(cx, base, i, T.unk234[i]);
        P.drawScreen(cx, s, base);
        return true;
    }
    private sweep = new Map<string, any>();
    /** openWindow(line, unk234[line]): the box's shape (bac's texture) masked by message_back_1 moved by shift (wrap S clamp, T repeat) */
    private openWindow(cx: CanvasRenderingContext2D, base: M, line: number, shift: number) {
        const b = this.bac[line], t0 = this.back0, t1 = this.back1;
        if (!t0 || !t1) return;
        const W = Math.max(1, b.width), H = Math.max(1, b.height);
        const key = `${line}|${Math.round(shift * 1000)}`;
        let c = this.sweep.get(key);
        if (!c) {
            if (this.sweep.size > 200) this.sweep.clear();
            c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
            const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
            for (let y = 0; y < H; y++) {
                const v = (y + 0.5) / H;
                const y0 = Math.min(t0.h - 1, Math.floor(v * t0.h)), y1 = ((Math.floor(v * t1.h) % t1.h) + t1.h) % t1.h;
                for (let x = 0; x < W; x++) {
                    const u = (x + 0.5) / W;
                    const x0 = Math.min(t0.w - 1, Math.floor(u * t0.w)), x1 = Math.min(t1.w - 1, Math.max(0, Math.floor((u + shift) * t1.w)));
                    const a = (0xA0 * t1.rgba[(y1 * t1.w + x1) * 4 + 3] * t0.rgba[(y0 * t0.w + x0) * 4 + 3]) / (255 * 255);
                    const i = (y * W + x) * 4;
                    d[i] = 0; d[i + 1] = 0; d[i + 2] = 255; d[i + 3] = a;
                }
            }
            g.putImageData(img, 0, 0);
            this.sweep.set(key, c);
        }
        // (bac is hidden while it sweeps in: its matrix from its line's)
        const lm = (this.me[line] as any)._m as M | undefined;
        if (!lm) return;
        const m = mul(base, mul(lm, Painter.local(b, b.bounds.x1, b.bounds.y1)));
        cx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        cx.globalAlpha = 1;
        cx.drawImage(c, 0, 0, W, H);
    }
    private drawBoard(cx: CanvasRenderingContext2D, P: Painter, base: M, T: any) {
        const pos = T.unk14.pos || [0, 0];
        this.mb0.move(this.mb0Init.x + pos[0], this.mb0Init.y + pos[1]);
        this.text.text = sjisDecode(new Uint8Array(T.boardText || []));
        this.text.alpha = T.unk18.alpha & 255;
        this.bcu.alpha = T.unk1C.alpha & 255;
        this.bcc.alpha = T.unk20.alpha & 255; this.bcs.alpha = T.unk24.alpha & 255;
        P.drawScreen(cx, this.board, base);
        return true;
    }
}
void tagStr;
