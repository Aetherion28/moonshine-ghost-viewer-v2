// The fader's wipes (GC2D/ScrnFader.cpp TSMSFader, GC2D/hx_wiper.c) that the director's miss and
// game over start (TMarDirector::nextStateInitialize(STATE_UNK7)): wipe 10 (Hx_Test2: four black
// crescents sweeping in from the right, a row of pixels at a time on Hx_MotionSet's curves) after a
// miss, wipe 13 (Hx_GameOver: common.szs's wipe_gameover.bti, "GAME OVER" cut out of black,
// zoomed down and turned onto the screen, a bounce, then the red box behind its letters) on the
// last life, and the plain fades (14 in, 15 out). The handlers run once a drawn frame (30 a
// second); a wipe here is a function of the frames since it started, drawn over the whole view in
// the wiper's 640 x 480.

import { Tex } from './gx.js';

const f32 = Math.fround;
interface Motion { t1: number; t2: number; t3: number; a1: number; a3: number; v: number; t: number; x: number; }
function motionSet(d: number, t1: number, t2: number, t3: number): Motion {
    const a = f32(t1), b = f32(a + t2), c = f32(b + t3);
    const vel = f32(f32(2 * d) / f32(t3 + f32(t2 + f32(t1 + t2))));
    return { t1: a, t2: b, t3: c, a1: t1 !== 0 ? f32(vel / t1) : 0, a3: t3 !== 0 ? f32(-vel / t3) : 0, v: 0, t: 0, x: 0 };
}
function motionUpdate(m: Motion) {
    if (m.t1 > m.t) m.v = f32(m.v + m.a1);
    else if (m.t2 <= m.t) m.v = f32(m.v + m.a3);
    m.t = f32(m.t + 1); m.x = f32(m.x + m.v);
    return m.x;
}

export const HX_W = 640, HX_H = 480;

export class Wipe {
    /** the wipe's handler type and its first frame (frames on the caller's clock: 30 a second) */
    constructor(public type: number, public start: number, public seconds = 0.4) { }
    /** whether the screen is fully covered at frame n (TSMSFader FADE_STATUS_FULLY_FADED_OUT) */
    covered(n: number) {
        const k = n - this.start;
        if (k < 0) return false;
        if (this.type === 10) return k >= 44;
        if (this.type === 13) return k >= 244;
        if (this.type === 15) return k >= Math.round(this.seconds * 30);
        return false;
    }
    /** the wipe at frame n over a canvas set to the wiper's 640 x 480 */
    draw(cx: CanvasRenderingContext2D, n: number, gameOver: Tex | null) {
        const k = n - this.start;
        if (k < 0) {
            // (a fade out waiting: nothing yet; a fade in waiting: still black)
            if (this.type === 14) { cx.globalAlpha = 1; cx.fillStyle = '#000'; cx.fillRect(0, 0, HX_W, HX_H); }
            return;
        }
        if (this.type === 10) this.test2(cx, k);
        else if (this.type === 13) this.gameOver(cx, k, gameOver);
        else if (this.type === 14 || this.type === 15) {
            const F = Math.max(1, Math.round(this.seconds * 30));
            const a = this.type === 14 ? 1 - Math.min(1, k / (F + 1)) : Math.min(1, (k + 1) / (F + 1));
            if (a > 0) { cx.globalAlpha = a; cx.fillStyle = '#000'; cx.fillRect(0, 0, HX_W, HX_H); }
        }
    }
    /** Hxs1_Test2: rows of a ring between two circles about (x0, y0), count of them from the top (dir 0) or the bottom */
    private band(cx: CanvasRenderingContext2D, count: number, dir: number, x0: number, y0: number, R: number, r: number) {
        const R2 = R * R, r2 = r * r;
        let i: number, end: number, step: number;
        if (dir === 0) { step = 1; end = Math.trunc(R); i = Math.trunc(-y0); } else { step = -1; i = Math.trunc(R); end = Math.trunc(-y0); }
        for (; i !== end; i += step) {
            const y = y0 + i;
            if (y < 0 || y > HX_H) continue;
            if (count === 0) break;
            count--;
            const ro = Math.sqrt(R2 - i * i), ri = Math.sqrt(r2 - i * i);
            if (!(ro === ro) || !(ri === ri)) continue;   // (sqrtf of a negative: no line)
            let a: number, b: number;
            if (x0 < HX_W / 2) { b = x0 + ro; a = x0 + ri; if (b < 0) continue; }
            else { a = x0 - ro; b = x0 - ri; if (a > HX_W) continue; }
            cx.fillRect(Math.min(a, b), y - 0.5, Math.abs(b - a), 1.5);
        }
    }
    private test2(cx: CanvasRenderingContext2D, k: number) {
        cx.globalAlpha = 1; cx.fillStyle = '#000';
        const W = HX_W;
        // the handler's states: 0 (set up), 1..4 a band each (11, 11, 10, 12 frames), then covered
        let st = 0, timer = 0, m = motionSet(500, 2, 8, 1), r = 1;
        for (let f = 0; f <= k; f++) {
            const draw = f === k;
            const B = (cnt: number, dir: number, x: number, y: number, R: number, rr: number) => { if (draw) this.band(cx, Math.trunc(cnt), dir, x, y, R, rr); };
            switch (st) {
                case 0: r = 1; m = motionSet(500, 2, 8, 1); st = 1; timer = 11; break;
                case 1: r = motionUpdate(m); B(r, 1, W + 200, 300, 900, 650); if (--timer <= 0) { st = 2; timer = 11; m = motionSet(500, 2, 8, 1); } break;
                case 2: B(600, 0, W + 200, 300, 900, 650); r = motionUpdate(m); B(r, 0, W + 200, 150, 700, 450); if (--timer <= 0) { st = 3; timer = 10; m = motionSet(500, 2, 7, 1); } break;
                case 3: B(600, 0, W + 200, 300, 900, 650); B(600, 0, W + 200, 150, 700, 450); r = motionUpdate(m); B(r, 1, W + 250, 370, 650, 400); if (--timer <= 0) { st = 4; timer = 12; m = motionSet(500, 2, 9, 1); } break;
                case 4: B(600, 0, W + 200, 300, 900, 650); B(600, 0, W + 200, 150, 700, 450); B(600, 1, W + 250, 370, 650, 400); r = motionUpdate(m); B(r, 0, W + 250, 300, 420, 200); if (--timer <= 0) st = 5; break;
                default: if (draw) cx.fillRect(0, 0, HX_W, HX_H); break;
            }
        }
    }
    private goCanvas: any = null;
    private maskC: any = null;
    private gameOver(cx: CanvasRenderingContext2D, k: number, tex: Tex | null) {
        // Hx_GameOver's states, replayed to frame k
        let st = 0, timer = 0, mag = 1, rot = 0, fade = 0, bi = 0, bt = 0, bd = 0, alpha = 0;
        let m = motionSet(-12.566371, 10, 15, 25);
        const bound = [-0.13, 6, 0.13, 6, -0.12, 8, 0.12, 8, -0.11, 12, 0.11, 12, 0, 0];
        let box = -1;   // the red box's alpha this frame (-1 none)
        for (let f = 0; f <= k; f++) {
            box = -1;
            switch (st) {
                case 0: mag = 0.3; rot = 0; fade = 0; st = 1; timer = 50; m = motionSet(-12.566371, 10, 15, 25); break;
                case 1: if (--timer <= 0) { st = 2; timer = 10; } mag = f32(0.074 + mag); rot = motionUpdate(m); fade = f32(5.1 + fade); break;
                case 2: if (--timer <= 0) { st = 3; bd = bound[0]; bt = bound[1]; bi = 2; } mag = f32(mag - 0.1); break;
                case 3:
                    if (bt) bt--;
                    if (!bt) { bd = bound[bi++]; bt = bound[bi++]; if (!bt) { st = 4; timer = 32; alpha = 255; break; } }
                    mag = f32(mag + bd);
                    break;
                case 4: if (--timer <= 0) { timer = 100; st = 5; } alpha = (alpha + 8) & 255; box = alpha; break;
                case 5: box = 255; if (--timer <= 0) st = 6; break;
                default: box = 255; break;
            }
        }
        if (box >= 0) { cx.globalAlpha = box / 255; cx.fillStyle = '#f00'; cx.fillRect(100, 100, HX_W - 200, HX_H - 200); }
        const a = st >= 2 ? 255 : Math.min(255, fade);
        this.gameOverMask(cx, a, 2 * mag, rot, tex);
    }
    /** Hxs_GameOver: the screen's quad in black, alpha the texture's (I4: its intensity, clamped at its edges) x a */
    private gameOverMask(cx: CanvasRenderingContext2D, a: number, mag: number, rot: number, tex: Tex | null) {
        if (a <= 0) return;
        cx.globalAlpha = a / 255;
        if (!tex) { cx.fillStyle = '#000'; cx.fillRect(0, 0, HX_W, HX_H); return; }
        if (!this.goCanvas) {
            // the texture as black with its alpha, padded by its edge texels (GX_CLAMP)
            const P = 2, w = tex.w + P * 2, h = tex.h + P * 2;
            const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
            const g = c.getContext("2d") as any, img = g.createImageData(w, h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const sx = Math.min(tex.w - 1, Math.max(0, x - P)), sy = Math.min(tex.h - 1, Math.max(0, y - P));
                img.data[(y * w + x) * 4 + 3] = tex.rgba[(sy * tex.w + sx) * 4 + 3];
            }
            g.putImageData(img, 0, 0);
            this.goCanvas = { c, P, edge: tex.rgba[3] };
        }
        // the texture coordinates of the screen's corners (aspect: (640 / 480 as an integer) / (w / h))
        const aspect = 1 / (tex.w / tex.h);
        const c0 = Math.cos(rot), s0 = Math.sin(rot);
        const dx = 0.70710677 * c0 - 0.70710677 * s0, dy = 0.70710677 * s0 + 0.70710677 * c0;
        const len = mag * Math.sqrt(0.5);
        const u0 = aspect * (-dx * len) + 0.5, v0 = -dy * len + 0.5;
        const u1 = aspect * (dy * len) + 0.5, v1 = -dx * len + 0.5;
        const u3 = aspect * (-dy * len) + 0.5, v3 = dx * len + 0.5;
        // the affine map from texture (u, v) to the screen: (u0, v0) -> (0, 0), (u1, v1) -> (W, 0), (u3, v3) -> (0, H)
        const A = [[u1 - u0, u3 - u0], [v1 - v0, v3 - v0]];
        const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
        if (!det) return;
        // screen = M * (uv - uv0): M = [[W, 0], [0, H]] * inverse(A)
        const i00 = A[1][1] / det, i01 = -A[0][1] / det, i10 = -A[1][0] / det, i11 = A[0][0] / det;
        const m00 = HX_W * i00, m01 = HX_W * i01, m10 = HX_H * i10, m11 = HX_H * i11;
        // (drawn on its own canvas, then over the screen: the red box under it shows through the letters)
        if (!this.maskC) this.maskC = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(HX_W, HX_H) : Object.assign(document.createElement('canvas'), { width: HX_W, height: HX_H });
        const g = this.maskC.getContext('2d') as CanvasRenderingContext2D;
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        g.clearRect(0, 0, HX_W, HX_H);
        // (the clamped edge beyond the texture: the edge texel's alpha everywhere first)
        const e = this.goCanvas.edge / 255;
        if (e > 0) { g.globalAlpha = e; g.fillStyle = '#000'; g.fillRect(0, 0, HX_W, HX_H); }
        // texel (x, y) of the padded canvas is uv ((x - P) / w, (y - P) / h)
        const { c, P } = this.goCanvas, tw = tex.w, th = tex.h;
        const tx = -m00 * u0 - m01 * v0, ty = -m10 * u0 - m11 * v0;
        g.setTransform(m00 / tw, m10 / tw, m01 / th, m11 / th, tx - (m00 / tw) * P - (m01 / th) * P, ty - (m10 / tw) * P - (m11 / th) * P);
        // (where the texture is: the edge fill taken back out, then the texture's own alpha put in)
        g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1; g.fillStyle = '#000';
        g.fillRect(P, P, tw, th);
        g.globalCompositeOperation = 'source-over';
        g.drawImage(c, 0, 0);
        cx.globalAlpha = a / 255;
        cx.drawImage(this.maskC, 0, 0);
    }
}
