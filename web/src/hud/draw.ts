// Drawing a J2D screen on a canvas, the way J2DPane::draw / J2DPicture / J2DTextBox do it on the
// GameCube: each pane's matrix is its parent's times its own (its place, then its rotation about
// its base position), its alpha the parent's times its own when it inherits it, and a picture is
// its texture stretched over its bounds (drawFullSet with the layout's bindings), coloured by the
// TEV: black + (white - black) x texel, times the corner colours and the pane's alpha.

import { Pane, Rect, Screen } from './blo.js';
import { Font, Tex, sjisCodes } from './gx.js';

export type M = [number, number, number, number, number, number];   // canvas setTransform order
export const I: M = [1, 0, 0, 1, 0, 0];
export function mul(a: M, b: M): M {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const T = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const R = (rad: number): M => { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; };

type Canvas = HTMLCanvasElement | OffscreenCanvas;
function makeCanvas(w: number, h: number): Canvas {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
export function texCanvas(t: Tex, black = 0, white = 0xFFFFFFFF, corner?: number[]): Canvas {
    const c = makeCanvas(t.w, t.h), cx = c.getContext('2d') as CanvasRenderingContext2D;
    const img = cx.createImageData(t.w, t.h), d = img.data, s = t.rgba;
    const br = black >>> 24, bg = (black >>> 16) & 255, bb = (black >>> 8) & 255, ba = black & 255;
    const wr = white >>> 24, wg = (white >>> 16) & 255, wb = (white >>> 8) & 255, wa = white & 255;
    const plain = black === 0 && white === 0xFFFFFFFF;
    const cc = corner && corner.some((v) => v !== 0xFFFFFFFF) ? corner.map((v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]) : null;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
        const i = (y * t.w + x) * 4;
        let r = s[i], g = s[i + 1], b = s[i + 2], a = t.alpha ? s[i + 3] : 255;
        if (!plain) { r = br + ((wr - br) * r) / 255; g = bg + ((wg - bg) * g) / 255; b = bb + ((wb - bb) * b) / 255; a = ba + ((wa - ba) * a) / 255; }
        if (cc) {   // the corners (top left, top right, bottom left, bottom right) blended across the quad
            const u = t.w > 1 ? x / (t.w - 1) : 0, v = t.h > 1 ? y / (t.h - 1) : 0;
            const k = (j: number) => (cc[0][j] * (1 - u) + cc[1][j] * u) * (1 - v) + (cc[2][j] * (1 - u) + cc[3][j] * u) * v;
            r = (r * k(0)) / 255; g = (g * k(1)) / 255; b = (b * k(2)) / 255; a = (a * k(3)) / 255;
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
    cx.putImageData(img, 0, 0);
    return c;
}

export class Painter {
    private cache = new Map<string, Canvas>();
    constructor(public textures: (name: string) => Tex | null, public font: Font | null = null) { }
    image(name: string, black: number, white: number, corner?: number[]): Canvas | null {
        const key = `${name}|${black}|${white}|${corner ? corner.join(',') : ''}`;
        let c = this.cache.get(key);
        if (c === undefined) {
            const t = this.textures(name);
            c = t ? texCanvas(t, black, white, corner) : (null as any);
            this.cache.set(key, c as Canvas);
        }
        return c || null;
    }
    /** J2DPane's matrix for a pane at (x, y): its rotation about its base position */
    static local(p: Pane, x: number, y: number): M {
        if (!p.rotation) return T(x, y);
        return mul(T(p.rotOffX + x, p.rotOffY + y), mul(R((-p.rotation * Math.PI) / 180), T(-p.rotOffX, -p.rotOffY)));
    }
    /** J2DScreen::draw: the tree, base the screen-to-canvas transform */
    drawScreen(cx: CanvasRenderingContext2D, s: Screen, base: M, skip?: (p: Pane) => boolean) {
        this.drawPane(cx, s, null, base, skip);
    }
    drawPane(cx: CanvasRenderingContext2D, p: Pane, parent: Pane | null, base: M, skip?: (p: Pane) => boolean) {
        const b = p.bounds;
        if (!p.visible || b.x1 >= b.x2 || b.y1 >= b.y2) return;
        const g = (p as any)._m as M | undefined;
        let m: M;
        if (parent) {
            p.global = { x1: b.x1 + parent.global.x1, y1: b.y1 + parent.global.y1, x2: b.x2 + parent.global.x1, y2: b.y2 + parent.global.y1 };
            m = mul((parent as any)._m as M, Painter.local(p, b.x1, b.y1));
            p.colorAlpha = p.inheritAlpha ? ((p.alpha * parent.colorAlpha) / 255) | 0 : p.alpha;
        } else {
            p.global = { ...b };
            m = Painter.local(p, b.x1, b.y1);
            p.colorAlpha = p.alpha;
        }
        void g;
        (p as any)._m = m;
        if (!skip || !skip(p)) {
            if (p.kind === 'PIC1') this.picture(cx, p, mul(base, m), p.colorAlpha);
            else if (p.kind === 'TBX1') this.textBox(cx, p, mul(base, m), p.colorAlpha);
        }
        for (const c of p.children.slice()) this.drawPane(cx, c, p, base, skip);
    }
    /** J2DPicture::drawFullSet */
    picture(cx: CanvasRenderingContext2D, p: Pane, m: M, alpha: number, at?: Rect) {
        if (!p.tex || alpha <= 0) return;
        const t = this.textures(p.tex);
        const img = this.image(p.tex, p.black, p.white, p.corner);
        if (!t || !img) return;
        let w = at ? at.x2 - at.x1 : p.width, h = at ? at.y2 - at.y1 : p.height, x = 0, y = 0;
        const bind = p.binding;
        if (p.wrapH === 0 && t.w < w) {
            if (bind & 8) { if (!(bind & 4)) w = t.w; }
            else { x = bind & 4 ? w - t.w : ((w - t.w) / 2) | 0; w = t.w; }
        }
        if (p.wrapV === 0 && t.h < h) {
            if (bind & 2) { if (!(bind & 1)) h = t.h; }
            else { y = bind & 1 ? h - t.h : ((h - t.h) / 2) | 0; h = t.h; }
        }
        const l = !!(bind & 8), r = !!(bind & 4), tp = !!(bind & 2), bt = !!(bind & 1);
        let u1: number, u2: number, v1: number, v2: number;
        if (l) { u1 = 0; u2 = r ? 1 : w / t.w; } else if (r) { u1 = 1 - w / t.w; u2 = 1; } else { u1 = 0.5 - w / t.w / 2; u2 = 0.5 + w / t.w / 2; }
        if (tp) { v1 = 0; v2 = bt ? 1 : h / t.h; } else if (bt) { v1 = 1 - h / t.h; v2 = 1; } else { v1 = 0.5 - h / t.h / 2; v2 = 0.5 + h / t.h / 2; }
        if (p.mirror & 2) [u1, u2] = [u2, u1];
        if (p.mirror & 1) [v1, v2] = [v2, v1];
        const ox = at ? at.x1 : 0, oy = at ? at.y1 : 0;
        cx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        cx.globalAlpha = alpha / 255;
        // (texels outside the texture clamp to its edge: drawn as the visible part)
        const su = Math.max(0, Math.min(u1, u2)), eu = Math.min(1, Math.max(u1, u2)), sv = Math.max(0, Math.min(v1, v2)), ev = Math.min(1, Math.max(v1, v2));
        if (eu <= su || ev <= sv) return;
        const flipX = u2 < u1, flipY = v2 < v1;
        if (flipX || flipY) {
            cx.translate(ox + x + (flipX ? w : 0), oy + y + (flipY ? h : 0)); cx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
            cx.drawImage(img, su * t.w, sv * t.h, (eu - su) * t.w, (ev - sv) * t.h, 0, 0, w, h);
        } else cx.drawImage(img, su * t.w, sv * t.h, (eu - su) * t.w, (ev - sv) * t.h, ox + x, oy + y, w, h);
    }
    /** J2DTextBox::drawSelf through J2DPrint::printReturn (no control codes) */
    textBox(cx: CanvasRenderingContext2D, p: Pane, m: M, alpha: number) {
        const f = this.font;
        if (!f || !p.text || alpha <= 0) return;
        const sx = p.fontW / f.width, sy = p.fontH / (f.ascent + f.descent || 1);
        const lines = p.text.split('\n').map((s) => sjisCodes(s));
        const widths = lines.map((L) => {
            let x = 0, w = 0, first = true;
            for (const c of L) { const [k, a] = f.widthOf(f.code(c)); x += (first ? a + k : a) * sx; w = Math.max(w, x); x += p.charSpace; first = false; }
            return w;
        });
        const textH = (lines.length - 1) * p.lineSpace + p.fontH;
        let top = 0;
        if (p.vBind === 1) top = p.height - Math.trunc(textH + 0.5);
        else if (p.vBind === 0) top = ((p.height - Math.trunc(textH + 0.5)) / 2) | 0;
        cx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        cx.globalAlpha = (alpha / 255) * ((p.charColor & 255) / 255);
        lines.forEach((L, li) => {
            const lw = Math.trunc(widths[li] + 0.5);
            let x = p.hBind === 2 ? 0 : p.hBind === 1 ? p.width - lw : ((p.width - lw) / 2) | 0;
            const base = top + li * p.lineSpace + f.ascent * sy;
            let first = true;
            for (const c of L) {
                const code = f.code(c), [k, a] = f.widthOf(code), gl = f.glyph(code);
                const gx = first ? x : x - k * sx;
                if (gl) {
                    const img = this.image(`#font${gl.sheet}`, 0, 0xFFFFFFFF);
                    if (img) cx.drawImage(img, gl.x, gl.y, f.cellW, f.cellH, gx, base - f.ascent * sy, p.fontW, (f.ascent + f.descent) * sy);
                }
                x += (first ? a + k : a) * sx + p.charSpace; first = false;
            }
        });
    }
}
