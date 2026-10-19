// TConsoleStr (GC2D/ConsoleStr.cpp): the big words and the stage's opening on big_tx_1.blo and
// scenario_demo_1.blo — the stage and episode names between two bars (startAppearScenario), the
// bars closing over the screen (startCloseWipe), the two halves sliding apart (startOpenWipe) and
// "GO!" (startAppearGo), one simulation tick (QF) at a time. The GO! letters' sparks (particles) are left out.

import { Screen } from './blo.js';
import { BoundPane, ExPane, P } from './panes.js';

export const S = { UNK0: 0, UNK1: 1, UNK2: 2, UNK3: 3, UNK4: 4, UNK5: 5, UNK6: 6, UNK7: 7, UNK8: 8 };

export class ConsoleStr {
    go: BoundPane[]; masks: ExPane[]; wipes: ExPane[];
    titles: [import('./blo.js').Pane, import('./blo.js').Pane];
    unk18 = 0; unk1C = 0; unk2B8 = 0; unk2BC = S.UNK7; unk2A8 = false;
    /** unk34: where the GO! letters were, for their trails */
    trail: { x: number; y: number }[][] = [[], [], []];
    constructor(public big: Screen, public demo: Screen) {
        this.go = [0, 1, 2].map((i) => { const b = new BoundPane(big, `go0${i}`); b.pane.hide(); return b; });
        this.titles = [demo.find('map'), demo.find('stry')];
        this.masks = [new ExPane(demo, 'msk1'), new ExPane(demo, 'msk2')];
        this.wipes = [new ExPane(demo, 'wp_l'), new ExPane(demo, 'wp_r')];
        for (const t of this.trail) for (let j = 0; j < 22; j++) t.push({ x: 0, y: 0 });
        // (not started: the masks are hidden until a wipe or the names show them)
        for (const m of this.masks) m.pane.hide();
    }
    startAppearGo() {
        if (this.unk2B8 === 1) return;
        this.unk2B8 = 1; this.unk18 = 0;
        for (const g of this.go) { g.pane.hide(); g.pane.alpha = 255; }
    }
    startAppearScenario() {
        if (this.unk2B8 !== 0) return;
        this.unk2B8 = 4; this.unk2BC = S.UNK0; this.unk18 = 0; this.unk1C = -200;
        for (let i = 0; i < 2; i++) { this.titles[i].alpha = 0; this.masks[i].pane.show(); }
        this.masks[0].setPaneOffset(30, 0, 0, 0, -(this.masks[0].init.y2 + 1));
        this.masks[1].setPaneOffset(30, 0, 0, 0, 465 - this.masks[1].init.y1);
    }
    startCloseWipe(opening: boolean) {
        const h = 224;
        if (opening) {
            for (const m of this.masks) m.pane.show();
            for (const t of this.titles) t.hide();
            let r = this.masks[0].pane.bounds;
            this.masks[0].setPaneSize(45, r.x2 - r.x1, h, r.x2 - r.x1, 0);
            this.masks[0].setPaneAlpha(45, 255, 0);
            r = this.masks[1].pane.bounds;
            const below = 465 - this.masks[1].init.y1;
            this.masks[1].setPaneOffset(45, 0, h - r.y1, 0, below);
            this.masks[1].setPaneSize(45, r.x2 - r.x1, below + h, r.x2 - r.x1, 0);
            this.masks[1].setPaneAlpha(45, 255, 0);
            this.unk2BC = S.UNK8; this.unk2B8 = 4; this.unk2A8 = true;
        } else if (this.unk2BC !== S.UNK1) this.unk2A8 = true;
        else {
            this.unk2BC = S.UNK2;
            let r = this.masks[0].pane.bounds;
            this.masks[0].setPaneSize(45, r.x2 - r.x1, h, r.x2 - r.x1, r.y2 - r.y1);
            this.masks[0].setPaneAlpha(45, 255, this.masks[0].pane.alpha);
            r = this.masks[1].pane.bounds;
            this.masks[1].setPaneOffset(45, 0, h - r.y1, 0, 0);
            this.masks[1].setPaneSize(45, r.x2 - r.x1, 464 - h, r.x2 - r.x1, r.y2 - r.y1);
            this.masks[1].setPaneAlpha(45, 255, this.masks[1].pane.alpha);
        }
    }
    startOpenWipe() {
        this.unk2A8 = false; this.unk2BC = S.UNK5;
        this.masks[0].pane.hide(); this.masks[1].pane.hide();
        for (const [i, w] of this.wipes.entries()) {
            w.pane.show();
            const r = w.pane.bounds;
            w.setPaneOffset(30, i === 0 ? -(r.x2 - r.x1) : r.x2 - r.x1, 0, 0, 0);
            w.setPaneAlpha(30, 100, 255);
        }
    }
    private processScenario() {
        if (this.unk2BC > S.UNK0 && this.unk2BC !== S.UNK7) return false;
        let done = this.masks[0].update();
        done = this.masks[1].update() && done;
        this.unk1C += 2;
        if (this.unk1C > 355) this.unk1C = 355; else done = false;
        const a = this.unk1C > 100 ? this.unk1C - 100 : 0;
        this.titles[0].alpha = this.titles[1].alpha = Math.min(255, a);
        if (done) this.unk2BC = S.UNK1;
        return false;
    }
    private processGo(p: number) {
        let result = false;
        const go = this.go;
        if (p < 90) {
            for (let i = 0; i < 3; i++) if (p === i * 10) { go[i].setPanePosition(40, P(0, 60), P(0, -40), P(0, -40)); go[i].pane.show(); }
            for (const g of go) if (g.update() && !g.atZero()) g.setPanePosition(30, P(0, -40), P(0, -40), P(0, 0));
        } else if (p >= 95) {
            if (p === 95) {
                go[0].setPanePosition(80, P(0, 0), P(-170, -180), P(-340, -360));
                go[1].setPanePosition(80, P(0, 0), P(0, -220), P(0, -440));
                go[2].setPanePosition(80, P(0, 0), P(160, -180), P(320, -360));
                for (let i = 0; i < 3; i++) for (let j = 0; j < 16; j++) this.trail[i][j] = { x: go[i].pane.bounds.x1, y: go[i].pane.bounds.y1 };
            } else if (p < 175) {
                for (let i = 0; i < 3; i++) {
                    const g = go[i], b = { ...g.pane.bounds };   // (its global bounds: ROOT sits at 0, 0)
                    g.pane.alpha = Math.max(0, g.pane.alpha - 4);
                    g.pane.resize(b.x2 - b.x1 + 2, b.y2 - b.y1 + 2);
                    g.update();
                    if (Math.trunc(p) % 2 === 0) { for (let j = 14; j >= 0; j--) this.trail[i][j + 1] = this.trail[i][j]; this.trail[i][0] = { x: b.x1, y: b.y1 }; }
                }
            } else if (p === 175) {
                for (const g of go) g.pane.resize(g.pane.width - 80, g.pane.height - 80);
            } else {
                for (const g of go) g.pane.hide();
                result = true;
            }
        }
        return result;
    }
    /** perform's CUE_MOVE part */
    frame() {
        let done = false;
        if (this.unk2B8 === 1) done = this.processGo(this.unk18);
        else if (this.unk2B8 === 4) done = this.processScenario();
        if (this.unk2BC === S.UNK2) {
            let d = true;
            for (let i = 0; i < 2; i++) { d = this.masks[i].update() && d; this.titles[i].alpha = 255 - this.masks[i].pane.alpha; }
            if (d) { this.unk2BC = S.UNK3; this.unk18 = 0; }
        } else if (this.unk2BC === S.UNK8) {
            let d = true;
            for (const m of this.masks) d = m.update() && d;
            if (d) { this.unk2BC = S.UNK3; this.unk18 = 0; }
        } else if (this.unk2BC === S.UNK5) {
            let d = true;
            for (const w of this.wipes) d = w.update() && d;
            if (d) { this.unk2BC = S.UNK6; done = true; for (const w of this.wipes) w.pane.hide(); }
        } else if (this.unk2BC === S.UNK3) {
            this.unk18 += 1;
            if (this.unk18 > 60) { this.unk18 = 0; this.unk2BC = S.UNK4; }
        } else if (this.unk2BC === S.UNK1) {
            if (this.unk2A8) this.startCloseWipe(false);
        }
        if (done) this.unk2B8 = 0;
        this.unk18 += 0.5;
    }
}
