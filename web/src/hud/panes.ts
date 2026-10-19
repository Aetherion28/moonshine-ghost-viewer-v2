// The GC2D pane movers the console drives its layout with: TCoord2D, TExPane (offset, size and
// alpha moved at a constant speed), TBoundPane (offset and size along a quadratic Bezier) and
// TBlendPane (a TBoundPane that also cross-fades a picture's two textures; with one texture, as
// the HUD's digits have, only its timing shows). GC2D/Coord2D.cpp, ExPane.cpp, BoundPane.cpp,
// BlendPane.cpp.

import { Pane, Rect, Screen } from './blo.js';

const f = Math.fround;
const round = (v: number) => Math.trunc(v + (v > 0 ? 0.5 : -0.5));
export interface Pt { x: number; y: number; }
export const P = (x: number, y: number): Pt => ({ x, y });

/** CLBChaseGeneralConstantSpecifySpeed */
function chase(v: number, want: number, speed: number) {
    if (speed < 0) speed = -speed;
    let d = f(want - v);
    if (d > 0) { d = f(d - speed); return d > 0 ? f(want - d) : want; }
    d = f(d + speed); return d < 0 ? f(want - d) : want;
}

export class Coord2D {
    x = 0; y = 0; tx = 0; ty = 0; vx = 0; vy = 0;
    setValue(time: number, tx: number, ty: number, sx: number, sy: number) {
        this.tx = f(tx); this.ty = f(ty); this.x = f(sx); this.y = f(sy);
        if (time <= 0) { this.vx = 0; this.vy = 0; } else { this.vx = f((tx - sx) / time); this.vy = f((ty - sy) / time); }
    }
    update() {
        this.x = chase(this.x, this.tx, this.vx); this.y = chase(this.y, this.ty, this.vy);
        if (this.x === this.tx && this.y === this.ty) { this.vx = 0; this.vy = 0; return true; }
        return false;
    }
    get cx() { return round(this.x); }
    get cy() { return round(this.y); }
}

export class ExPane {
    pane: Pane; init: Rect;
    off = new Coord2D(); size = new Coord2D();
    alpha = 255; alphaStep = 0; alphaTarget = 255;
    offPending = false; sizePending = false; alphaPending = false;
    constructor(s: Screen | Pane, tag: string) { this.pane = s instanceof Screen ? s.find(tag) : s; this.init = { ...this.pane.bounds }; }
    setPaneOffset(time: number, tx: number, ty: number, ix: number, iy: number) {
        this.off.setValue(time, tx, ty, ix, iy);
        this.pane.move(this.init.x1 + ix, this.init.y1 + iy);
        this.offPending = true;
    }
    updatePaneOffset(time: number, tx: number, ty: number) { this.setPaneOffset(time, tx, ty, this.off.cx, this.off.cy); }
    setPaneSize(time: number, tw: number, th: number, iw: number, ih: number) {
        this.size.setValue(time, tw, th, iw, ih);
        this.pane.resize(iw, ih);
        this.sizePending = true;
    }
    setPaneAlpha(time: number, target: number, initial: number) {
        this.pane.alpha = Math.max(0, Math.min(255, initial | 0));
        this.alpha = initial; this.alphaStep = f((target - initial) / time); this.alphaTarget = target; this.alphaPending = true;
    }
    update() {
        if (this.offPending) {
            if (this.off.update()) this.offPending = false;
            this.pane.move(this.init.x1 + this.off.cx, this.init.y1 + this.off.cy);
        }
        if (this.sizePending) {
            if (this.size.update()) this.sizePending = false;
            this.pane.resize(this.size.cx, this.size.cy);
        }
        if (this.alphaPending) {
            if ((this.alphaStep < 0 && this.alpha <= this.alphaTarget) || (this.alphaStep >= 0 && this.alpha >= this.alphaTarget)) this.alphaPending = false;
            this.alpha = f(this.alpha + this.alphaStep);
            this.pane.alpha = Math.max(0, Math.min(255, Math.trunc(this.alpha < 0 ? 0 : this.alpha)));
        }
        return !this.offPending && !this.sizePending && !this.alphaPending;
    }
    atZero() { return this.off.cx === 0 && this.off.cy === 0; }
    /** -(mInitialBounds.y2 + 1): just above the screen */
    get hiddenY() { return -(this.init.y2 + 1); }
    /** 465 - y1: just below it */
    get belowY() { return 465 - this.init.y1; }
}

export class BoundPane {
    pane: Pane; init: Rect;
    pos = P(0, 0); sz = P(0, 0);
    posOn = false; sizeOn = false;
    t = 0; dt = 0; st = 0; sdt = 0;
    a = P(0, 0); b = P(0, 0); c = P(0, 0); sa = P(0, 0); sb = P(0, 0); sc = P(0, 0);
    constructor(s: Screen | Pane, tag: string) { this.pane = s instanceof Screen ? s.find(tag) : s; this.init = { ...this.pane.bounds }; }
    setPanePosition(time: number, a: Pt, b: Pt, c: Pt) { this.t = 0; this.dt = f(1 / time); this.a = { ...a }; this.b = { ...b }; this.c = { ...c }; this.posOn = true; }
    setPaneSize(time: number, a: Pt, b: Pt, c: Pt) { this.st = 0; this.sdt = f(1 / time); this.sa = { ...a }; this.sb = { ...b }; this.sc = { ...c }; this.sizeOn = true; }
    static bezier(t: number, out: Pt, s: Pt, c: Pt, e: Pt) {
        const tt = f(t * t), u = f(1 - t), uu = f(u * u), ut = f(2 * u * t);
        const x = f(e.x * tt + f(s.x * uu + c.x * ut)), y = f(e.y * tt + f(s.y * uu + c.y * ut));
        out.x = (round(x) << 16) >> 16; out.y = (round(y) << 16) >> 16;
    }
    update() {
        if (this.posOn) {
            if (this.t > 1) { this.t = 1; this.posOn = false; }
            BoundPane.bezier(this.t, this.pos, this.a, this.b, this.c);
            this.pane.move(this.init.x1 + this.pos.x, this.init.y1 + this.pos.y);
            this.t = f(this.t + this.dt);
        }
        if (this.sizeOn) {
            if (this.st > 1) { this.st = 1; this.sizeOn = false; }
            BoundPane.bezier(this.st, this.sz, this.sa, this.sb, this.sc);
            this.pane.resize(this.sz.x + (this.init.x2 - this.init.x1), this.sz.y + (this.init.y2 - this.init.y1));
            this.st = f(this.st + this.sdt);
        }
        return !this.posOn && !this.sizeOn;
    }
    atZero() { return this.pos.x === 0 && this.pos.y === 0; }
    /** syncPaneBounds: take the pane's bounds as its new rest place */
    sync() { this.init = { ...this.pane.bounds }; }
}

export class BlendPane extends BoundPane {
    blendOn = false; blendStep = 0; blend = 0;
    /** setPaneBlend: the new texture now; the cross-fade's frames still count */
    setPaneBlend(frames: number, tex: string) {
        this.pane.tex = tex;
        this.blendOn = true; this.blendStep = f(1 / frames); this.blend = 0;
    }
    update() {
        const r = super.update();
        if (this.blendOn) {
            if (this.blend >= 1) { this.blend = 1; this.blendOn = false; }
            this.blend = f(this.blend + this.blendStep);
        }
        return r && !this.blendOn;
    }
}
