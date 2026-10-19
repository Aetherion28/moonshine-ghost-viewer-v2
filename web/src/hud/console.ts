// TGCConsole2 (GC2D/GCConsole2.cpp): the game's HUD on standard_1.blo, one simulation tick at a time —
// performMovement and performCalcAnim for the life meter (health and air), the coin counter, the
// Shine and blue coin counters, the red coin counter and the FLUDD tank. What the game reads from
// TFlagManager and Mario comes in as a ConsoleInput each frame.
//
// Left out: the lives counter (m_*: a ghost doesn't record the lives), the timer (t_*: nothing
// starts one here), the help balloon, the Delfino news ticker, the jet balloon, Yoshi's juice
// gauge, the HUD's particles (gpEmitterManager4D2) and its sounds.

import { Pane, Screen } from './blo.js';
import { BoundPane, BlendPane, ExPane, P, Pt } from './panes.js';

export interface ConsoleInput {
    /** MSF_GOLD_COIN_COUNT, MSF_RED_COIN_COUNT, MSF_BLUE_COIN_COUNT, MSF_SHINE_COUNT */
    coins: number; red: number; blue: number; shines: number;
    /** Mario's getHealth / getAir (0..8) and isUnderWater */
    health: number; air: number; underWater: boolean;
    /** MARIO_FLAG_HAS_FLUDD, TWaterGun::mCurrentNozzle, the tank's fill (current / max) */
    fludd: boolean; nozzle: number; water: number; full: boolean;
    /** Mario's status is STATUS_WAIT (0xC400201): standing still */
    waiting: boolean;
    /** gpCamera->isDemoCamera() */
    demo: boolean;
    /** DIRECTOR_FLAG_SHINE_TAKEN */
    shineTaken: boolean;
    /** SMS_isDivingMap */
    diving: boolean;
}

const DOWN_TOP = P(0, -100), DOWN_MID = P(0, 30), DOWN_BOT = P(0, 0);
const UP_TOP = P(0, 50), UP_MID = P(0, -30), UP_BOT = P(0, 0);
const COIN_MID = P(0, 45), COIN_BOT = P(0, 0);
const Z = P(0, 0);
const L = { HIDDEN: 0, H_APPEAR: 1, H_VISIBLE: 2, H_DISAPPEAR: 3, A_APPEAR: 4, A_VISIBLE: 5, A_DISAPPEAR: 6, H_INSERT: 7, A_INSERT: 8, A_DIVING: 9, DEMO: 10 };
const num = (n: number) => `coin_number_${n}.bti`;

/** updateDownPaneState and its kin: after the drop, settle on (or bounce back to) the rest place */
function settle(p: BoundPane, mid: Pt, bot: Pt, done: { v: boolean }) {
    if (p.update()) { if (!p.atZero()) { p.setPanePosition(30, mid, mid, bot); done.v = false; } }
    else done.v = false;
}

export class Console {
    scr: Screen;
    // coins
    cBack: BoundPane; cIcon: BoundPane; cX: BoundPane; cDig: BlendPane[]; cRoot: ExPane;
    // Shines
    sBack: BoundPane; sIcon: BoundPane; sX: BoundPane; sDig: BlendPane[]; sRoot: ExPane;
    // blue coins
    dBack: BoundPane; dIcon: BoundPane; dX: BoundPane; dDig: BoundPane[]; dRoot: ExPane;
    // life meter
    lBack: BoundPane; lText: BoundPane; petals: Pane[] = []; petalBounds: { x1: number; y1: number; x2: number; y2: number }[] = []; lRoot: BoundPane; lmRoot: BoundPane;
    // the tank
    wBack: BoundPane; wText: BoundPane; nozzle: BoundPane; nozzles: BoundPane[] = []; xb: Pane; xbs: Pane[] = []; wT0: BoundPane; wRoot: ExPane;
    wT: Pane[] = []; wM: Pane[] = []; wLayer: { x1: number; y1: number; x2: number; y2: number }[] = [];
    // red coins
    rRoot: ExPane; rBack: BoundPane; rIcon: BoundPane; rX: BoundPane; rSl: BoundPane; rDig: BoundPane[];
    // what the game keeps (the member names are its offsets)
    unk18 = L.HIDDEN; unk1C = 8; unk1CC = 8; unk20 = 0; unk24 = 0; unk28 = 0; unk30 = 0;
    unk34 = false; unk35 = false; unk38 = false; unk39 = true; unk3C = false; unk40 = false; unk41 = false;
    unk45 = false; unk46 = false; unk4B = false; unk4C = false; unk4D = false; unk4F = false; unk50 = false; unk51 = false;
    unk58 = false; unk5C = 0; unk64 = 0; unk68 = 0; unk6C = 0; unk74 = 0; unk7C = 0; unk84 = 0; unk86 = 0; unk88 = 0; unk8A = 0;
    unkB4 = 0; unkB6 = 0; unk168 = 0; unk16C = 0; unk170 = 0; unk1C8 = -150; unk1CA = 180; unk268 = 0; unk26A = 0;
    unk2B8 = 1; unk310 = 0; unk444 = 0; unk448 = false;
    lastIn: ConsoleInput | null = null;

    constructor(scr: Screen, inp: ConsoleInput) {
        this.scr = scr;
        const B = (t: string) => new BoundPane(scr, t), X = (t: string) => new ExPane(scr, t), BL = (t: string) => new BlendPane(scr, t);
        // TGCConsole2::load
        this.cBack = B('c_ba'); this.cIcon = B('c_ic'); this.cX = B('c_x'); this.cRoot = X('c_0');
        this.cDig = [BL('c_n1'), BL('c_n2'), BL('c_n3')];
        this.sBack = B('s_ba'); this.sIcon = B('s_ic'); this.sX = B('s_x'); this.sRoot = X('s_0');
        this.sDig = [BL('s_n1'), BL('s_n2'), BL('s_n3')];
        this.dBack = B('d_ba'); this.dIcon = B('d_ic'); this.dX = B('d_x');
        this.dDig = [B('d_n1'), B('d_n2'), B('d_n3')];
        this.dRoot = X('d_0');
        this.lBack = B('l_ba'); this.lText = B('l_tx'); this.lRoot = B('l_0');
        for (let i = 0; i < 9; i++) {
            this.petals[i * 2] = scr.find(`lm${i}1`); this.petals[i * 2 + 1] = scr.find(`lm${i}2`);
            this.petalBounds[i] = { ...this.petals[i * 2].bounds };
        }
        this.lmRoot = B('lm_0');
        this.wBack = B('w_ba'); this.wText = B('w_tx');
        for (let i = 0; i < 4; i++) { this.nozzles[i] = B(`nz0${i + 1}`); this.xbs[i] = scr.find(`xb0${i + 1}`); }
        this.nozzle = this.nozzles[0]; this.xb = this.xbs[0];
        this.nozzle.pane.setBasePosition(5);
        this.xb.show();
        this.wT0 = B('w_t0'); this.wRoot = X('w_0');
        for (let i = 0; i < 3; i++) { this.wT[i] = scr.find(`w_t${i + 1}`); this.wT[i].hide(); if (i) { this.wM[i] = scr.find(`w_m${i + 1}`); this.wM[i].hide(); } }
        this.rRoot = X('r_0'); this.rBack = B('r_ba'); this.rIcon = B('r_ic'); this.rX = B('r_x'); this.rSl = B('r_sl');
        this.rDig = [B('r_n1'), B('r_n2')];
        scr.find('m_0').hide();   // (the lives counter: not shown)
        scr.find('te_0').hide();   // (loadAfter: the news ticker starts hidden; it isn't run here)
        // TGCConsole2::loadAfter
        const wb = this.wRoot.pane.bounds;
        this.wT[0].add(wb.x1, wb.y1);
        this.wText.pane.add(wb.x1, wb.y1); this.wText.sync();
        this.wBack.pane.add(wb.x1, wb.y1); this.wBack.sync();
        for (let i = 0; i < 3; i++) { const r = this.wT[i].bounds; this.wLayer[i] = i === 0 ? { ...r } : { x1: r.x1 + wb.x1, y1: r.y1 + wb.y1, x2: r.x2 + wb.x1, y2: r.y2 + wb.y1 }; }
        this.wT[0].show(); this.wT[0].detach(); this.wText.pane.detach();
        for (const n of this.nozzles) { n.pane.add(wb.x1, wb.y1); n.sync(); n.pane.detach(); }
        this.wBack.pane.detach();
        this.xb.hide();
        const health = Math.max(0, inp.health);
        this.lRoot.pane.hide();
        for (let i = 0; i < 9; i++) this.petals[i * 2].visible = i < health + 1;
        this.unk1CC = health; this.unk1C = health;
        this.unk26A = this.sRoot.pane.bounds.y1 - this.cRoot.pane.bounds.y1;
        this.hideAbove(this.sRoot); this.sRoot.pane.hide();
        this.hideAbove(this.dRoot); this.dRoot.pane.hide();
        this.cRoot.updatePaneOffset(1, 0, this.unk26A); this.cRoot.update(); this.cRoot.pane.hide();
        this.unk168 = inp.blue;
        this.unk170 = Math.max(0, inp.blue); this.setBlue(this.unk170);
        this.unk20 = Math.max(0, Math.min(999, inp.coins)); this.unk6C = this.unk20; this.setCounter(this.cDig, this.unk20);
        this.unk24 = Math.max(0, Math.min(999, inp.shines)); this.unk64 = this.unk24; this.setCounter(this.sDig, this.unk24);
        this.unk39 = true;
        this.wRoot.pane.hide(); this.wText.pane.hide(); this.nozzle.pane.hide(); this.wT0.pane.hide();
        this.unk28 = inp.water;
        this.unk444 = 0;
    }
    private hideAbove(p: ExPane) { p.updatePaneOffset(1, 0, p.hiddenY); p.update(); }
    private digit(p: { pane: Pane }, n: number) { p.pane.tex = num(Math.max(0, Math.min(9, n | 0))); }
    private setCounter(d: { pane: Pane }[], v: number) {
        if (v < 100) { this.digit(d[0], (v * 0.1) | 0); this.digit(d[1], v % 10); }
        else { const h = (v * 0.01) | 0, r = v - h * 100; this.digit(d[0], h); this.digit(d[1], (r * 0.1) | 0); this.digit(d[2], r % 10); }
    }
    private setBlue(v: number) {
        this.setCounter(this.dDig, v);
        this.dDig[2].pane.visible = v >= 100;
    }

    // ------------------------------------------------------------ the start* calls
    startAppearTank() {
        if (this.unk45) return;
        this.unk45 = true; this.unk7C = 0;
        this.wRoot.pane.show();
        this.wRoot.setPaneOffset(20, 0, 0, 0, this.wRoot.belowY);
        this.wBack.setPanePosition(50, P(0, 100), P(0, -30), P(0, -30));
        this.nozzle.pane.hide(); this.wT0.pane.hide();
    }
    startDisappearTank() {
        this.unk4B = true;
        const off = this.wRoot.belowY + 60;
        this.wRoot.updatePaneOffset(40, 0, off);
        const a = P(0, 0), b = P(0, off >> 1), c = P(0, off);
        this.nozzle.setPanePosition(40, a, b, c); this.wText.setPanePosition(40, a, b, c); this.wBack.setPanePosition(40, a, b, c);
    }
    startAppearCoin() {
        if (this.cRoot.pane.visible) return;
        this.unk4F = true; this.unk88 = 0;
        this.cRoot.pane.show();
        this.cRoot.setPaneOffset(20, 0, this.unk26A, 0, this.cRoot.hiddenY);
        this.cBack.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        this.cIcon.pane.hide(); this.cX.pane.hide(); for (const d of this.cDig) d.pane.hide();
    }
    startDisappearCoin() {
        this.unk4D = true;
        if (this.sRoot.atZero()) this.sRoot.updatePaneOffset(40, 0, -(this.sRoot.init.y2 + 1 + this.sBack.pane.height));
        this.cRoot.updatePaneOffset(40, 0, this.cRoot.hiddenY - this.cBack.pane.height);
    }
    private lifeColors(air: boolean, all: boolean) {
        for (let i = all ? 0 : 1; i < 9; i++) { const p = this.petals[i * 2]; p.white = air ? 0x00FFFFFF : 0xFFFFFFFF; p.black = air ? 0x003CFF00 : 0; }
        this.lText.pane.white = air ? 0x00FFFFFF : 0xFFFFFFFF; this.lText.pane.black = air ? 0x003CFF00 : 0;
        this.lBack.pane.white = air ? 0x0000FF78 : 0xFF4C00C8; this.lBack.pane.black = air ? 0x0000FF00 : 0xFF4C0000;
        // updateLifeMeterColors
        const hi = this.unk1CC >= 4;
        const w = air ? (hi ? 0x00FFFFFF : 0x0010FFFF) : (hi ? 0xFFFFFFFF : 0x7F7F7FFF), bk = air ? 0x003CFF00 : 0;
        this.lText.pane.white = w; this.lText.pane.black = bk; this.petals[0].white = w; this.petals[0].black = bk;
    }
    startInsertLife(kind: number, inp: ConsoleInput) {
        const amount = kind === 0 ? inp.health : inp.air;
        for (let i = 1; i < 9; i++) this.petals[i * 2].visible = amount + 1 > i;
        this.lifeColors(kind === 1, false);
        this.unk51 = true; this.unk84 = 0;
        const off = -(this.lRoot.init.y2 + 1);
        this.lRoot.pane.show();
        this.lRoot.setPanePosition(20, P(0, off), P(0, off >> 1), Z);
        this.lBack.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        this.lText.pane.hide(); this.lmRoot.pane.hide();
    }
    resetLife(n: number) {
        for (let i = 1; i < 9; i++) {
            this.petals[2 * i].visible = i < n + 1;
            this.petals[2 * i].setBounds(this.petalBounds[i]); this.petals[2 * i + 1].setBounds(this.petalBounds[i]);
        }
    }
    startAppearLife(kind: number, inp: ConsoleInput) {
        if (this.unk38 || this.unk50 || inp.health === 0) return false;
        const amount = kind === 0 ? inp.health : inp.air;
        for (let i = 0; i < 9; i++) this.petals[i * 2].visible = amount + 1 > i;
        this.lifeColors(kind === 1, true);
        this.unk38 = true; this.unk84 = 0;
        this.lRoot.pane.add(this.unk1C8, this.unk1CA);
        return true;
    }
    startDisappearLife(n: number) {
        if (this.unk38 || this.unk4C) return false;
        this.unk4C = true;
        const y = -(this.lRoot.init.y2 + 1) - this.lBack.pane.height;
        this.lRoot.setPanePosition(40, Z, P(0, y >> 1), P(0, y));
        this.unk84 = n;
        return true;
    }
    startDownLeftBot() {
        if (this.unk41) return;
        this.unk41 = true; this.unk40 = false;
        if (this.rRoot.pane.visible) { this.rRoot.updatePaneOffset(20, 0, this.rRoot.belowY + 60); this.unk448 = true; }
    }
    startAppearRedCoin() {
        this.unk3C = true;
        this.rRoot.pane.show();
        this.rRoot.setPaneOffset(40, 0, 0, 0, this.rRoot.belowY);
        this.rBack.pane.show(); this.rBack.setPanePosition(50, UP_TOP, UP_MID, UP_MID);
        this.rIcon.pane.hide(); this.rSl.pane.hide(); this.rX.pane.hide();
        this.unk74 = 0;
        for (const d of this.rDig) d.pane.hide();
    }
    startDisappearStar() {
        this.sRoot.updatePaneOffset(40, 0, this.sRoot.hiddenY + this.unk26A);
        this.dRoot.updatePaneOffset(40, 0, this.dRoot.hiddenY);
        this.cRoot.updatePaneOffset(40, 0, this.unk26A);
        this.unk35 = true;
    }
    startAppearStar() {
        if (this.unk34 || this.sRoot.atZero()) return;
        if (this.unk35) { this.sRoot.pane.hide(); this.dRoot.pane.hide(); this.unk35 = false; }
        this.sRoot.setPaneOffset(40, 0, 0, 0, this.sRoot.hiddenY);
        this.sRoot.pane.show();
        this.sBack.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        this.sIcon.pane.hide(); this.sX.pane.hide(); for (const d of this.sDig) d.pane.hide();
        this.dRoot.setPaneOffset(40, 0, 0, 0, this.dRoot.hiddenY);
        this.dRoot.pane.show();
        this.dBack.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        this.dIcon.pane.hide(); this.dX.pane.hide(); for (const d of this.dDig) d.pane.hide();
        if (!this.cRoot.pane.visible) this.cRoot.pane.show();
        this.cRoot.updatePaneOffset(40, 0, 0);
        this.cBack.setPanePosition(50, Z, COIN_MID, COIN_MID);
        this.unk5C = 0; this.unk34 = true;
    }
    startCameraDemo(inp: ConsoleInput) {
        if (inp.health === 0 || inp.air === 0) {
            this.lRoot.pane.hide(); this.nozzle.pane.hide(); this.wRoot.pane.hide(); this.wText.pane.hide(); this.wBack.pane.hide(); this.rRoot.pane.hide();
            this.unk46 = false;
            return;
        }
        if (this.unk50 || this.unk39) return;
        this.unk50 = true;
        this.startDisappearLife(120);
        this.unk18 = L.DEMO;
        for (const p of [this.nozzle, this.wBack, this.wText]) { p.setPanePosition(1, Z, Z, Z); p.update(); }
        this.startDisappearTank();
        this.startDownLeftBot();
        if (inp.shineTaken) this.startAppearStar();
        else { this.startDisappearStar(); this.startDisappearCoin(); }
        this.unkB6 = 0;
    }
    endCameraDemo(inp: ConsoleInput) {
        if (this.unk39 || !this.unk50) return;
        if (this.unkB6 < 3) { this.unkB6++; return; }
        this.unk50 = false;
        if (!this.wRoot.atZero() && !this.unk45) {
            this.unk45 = true; this.unk7C = 0;
            this.wRoot.pane.show();
            this.wRoot.setPaneOffset(20, 0, 0, 0, this.wRoot.belowY);
            this.wBack.setPanePosition(50, P(0, 100), P(0, -30), P(0, -30));
            this.nozzle.pane.hide(); this.wT0.pane.hide();
        }
        this.unk40 = true; this.unk41 = false;
        if (this.unk448) { this.startAppearRedCoin(); this.unk448 = false; }
        if (!inp.shineTaken && !this.cRoot.pane.visible) this.startAppearCoin();
    }

    // ------------------------------------------------------------ the process* steps
    private processAppearLife(n: number, inp: ConsoleInput) {
        if (inp.health === 0 || inp.air === 0) return true;
        if (n === 0) { this.lRoot.setPanePosition(40, P(this.unk1C8, this.unk1CA), P(-10, 10), Z); this.lRoot.pane.show(); this.lRoot.update(); return false; }
        if (n < 100) return false;
        return this.lRoot.update();
    }
    private processInsertLife(n: number) {
        const done = { v: this.lRoot.update() };
        if (n === 14) { this.lText.pane.show(); this.lText.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); }
        if (n === 24) { this.lmRoot.pane.show(); this.lmRoot.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); }
        settle(this.lBack, DOWN_MID, DOWN_BOT, done); settle(this.lText, DOWN_MID, DOWN_BOT, done); settle(this.lmRoot, DOWN_MID, DOWN_BOT, done);
        return done.v;
    }
    private processAppearStar(n: number, inp: ConsoleInput) {
        const done = { v: true };
        done.v = this.sRoot.update() && done.v;
        done.v = this.dRoot.update() && done.v;
        if (n === 14) { for (const p of [this.sIcon, this.dIcon]) { p.pane.show(); p.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); } }
        if (n === 24) { for (const p of [this.sX, this.dX]) { p.pane.show(); p.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); } }
        const shines = inp.shines;
        for (let i = 0; i < 3; i++) if (n === i * 6 + 28) {
            if (i === 2) { if ((!this.unk50 && shines >= 100) || (shines > 100 && this.unk50)) this.sDig[i].pane.show(); }
            else this.sDig[i].pane.show();
            this.sDig[i].setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        }
        const blue = Math.max(0, this.unk168);
        for (let i = 0; i < 3; i++) if (n === i * 6 + 28) {
            if (i === 2) { if (blue >= 100) this.dDig[i].pane.show(); }
            else this.dDig[i].pane.show();
            this.dDig[i].setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID);
        }
        for (const p of [this.sBack, this.dBack, this.sIcon, this.dIcon, this.sX, this.dX]) settle(p, DOWN_MID, DOWN_BOT, done);
        for (const d of this.sDig) settle(d, DOWN_MID, DOWN_BOT, done);
        for (const d of this.dDig) settle(d, DOWN_MID, DOWN_BOT, done);
        return done.v;
    }
    private processDownCoin(n: number) {
        const done = { v: true };
        if (n === 14) this.cIcon.setPanePosition(50, Z, COIN_MID, COIN_MID);
        if (n === 24) this.cX.setPanePosition(50, Z, COIN_MID, COIN_MID);
        for (let i = 0; i < 3; i++) if (n === i * 6 + 28) this.cDig[i].setPanePosition(50, P(0, i * 6), COIN_MID, COIN_MID);
        settle(this.cBack, COIN_MID, COIN_BOT, done);
        if (n < 14) done.v = false; else settle(this.cIcon, COIN_MID, COIN_BOT, done);
        if (n < 24) done.v = false; else settle(this.cX, COIN_MID, COIN_BOT, done);
        for (let i = 0; i < 3; i++) {
            if (n < i * 6 + 28) { done.v = false; continue; }
            const d = this.cDig[i];   // updateCoinBlendPaneState
            d.update();
            if (!d.posOn) { if (!d.atZero()) { d.setPanePosition(30, COIN_MID, COIN_MID, COIN_BOT); done.v = false; } }
            else done.v = false;
        }
        done.v = this.cRoot.update() && done.v;
        return done.v;
    }
    private processAppearTank(n: number) {
        const done = { v: this.wRoot.update() };
        if (n === 6) { this.wText.pane.show(); this.wText.setPanePosition(40, UP_TOP, UP_MID, UP_MID); }
        if (n === 14) { this.wT0.pane.show(); this.wT0.setPanePosition(40, UP_TOP, UP_MID, UP_MID); }
        if (n === 26) { this.nozzle.pane.show(); this.nozzle.setPanePosition(40, P(0, 100), UP_MID, UP_MID); }
        settle(this.wBack, UP_MID, UP_BOT, done);
        if (n >= 6) settle(this.wText, UP_MID, UP_BOT, done); else done.v = false;
        if (n >= 14) settle(this.wT0, UP_MID, UP_BOT, done); else done.v = false;
        if (n >= 26 && this.nozzle.update()) {
            if (!this.nozzle.atZero()) { this.nozzle.setPanePosition(30, UP_MID, UP_MID, UP_BOT); done.v = false; }
            else this.xb.show();
        } else done.v = false;
        return done.v;
    }
    private processAppearCoin(n: number) {
        const done = { v: this.cRoot.update() };
        if (n === 14) { this.cIcon.pane.show(); this.cIcon.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); }
        if (n === 24) { this.cX.pane.show(); this.cX.setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); }
        for (let i = 0; i < 3; i++) if ((this.unk6C >= 100 || i !== 2) && n === i * 6 + 28) { this.cDig[i].pane.show(); this.cDig[i].setPanePosition(50, DOWN_TOP, DOWN_MID, DOWN_MID); }
        settle(this.cBack, DOWN_MID, DOWN_BOT, done); settle(this.cIcon, DOWN_MID, DOWN_BOT, done); settle(this.cX, DOWN_MID, DOWN_BOT, done);
        for (let i = 0; i < 3; i++) if (this.unk6C >= 100 || i !== 2) settle(this.cDig[i], DOWN_MID, DOWN_BOT, done);
        return done.v;
    }
    private processAppearRed(n: number) {
        const done = { v: this.rRoot.update() };
        if (n === 14) { this.rIcon.pane.show(); this.rIcon.setPanePosition(50, UP_TOP, UP_MID, UP_MID); }
        if (n === 24) { this.rX.pane.show(); this.rX.setPanePosition(50, UP_TOP, UP_MID, UP_MID); }
        for (let i = 0; i < 2; i++) if (n === i * 6 + 28) { this.rDig[i].pane.show(); this.rDig[i].setPanePosition(50, UP_TOP, UP_MID, UP_MID); }
        if (n === 32) { this.rSl.pane.show(); this.rSl.setPanePosition(50, UP_TOP, UP_MID, UP_MID); }
        for (const p of [this.rBack, this.rIcon, this.rX, ...this.rDig, this.rSl]) settle(p, UP_MID, UP_BOT, done);
        return done.v;
    }

    /** one simulation tick: performMovement, then (on a frame's last tick) performCalcAnim */
    frame(inp: ConsoleInput, calcAnim: boolean) {
        this.lastIn = inp;
        // ---------------------------------------------------- performMovement
        if (!this.unk50) { if (inp.demo) this.startCameraDemo(inp); }
        else if (!inp.demo) this.endCameraDemo(inp);
        for (const flag of ['unk40', 'unk41'] as const) if (this[flag]) {
            let done = true;
            if (this.rRoot.pane.visible) done = this.rRoot.update() && done;
            if (done) this[flag] = false;
        }
        const root = this.scr.find('ROOT');
        if (this.unk39) {
            if (this.unkB4 === 1 && this.unk6C < 100) this.cDig[2].pane.hide();
            if (this.unkB4 === 0) { this.startAppearCoin(); root.alpha = 0; } else root.alpha = 255;
            if (++this.unkB4 > 0xA0) this.unk39 = false;
        }
        let airMode = true, amount: number;
        switch (this.unk18) {
            case L.HIDDEN: case L.H_APPEAR: case L.H_VISIBLE: case L.H_DISAPPEAR: case L.H_INSERT: airMode = false; amount = inp.health; break;
            case L.DEMO: amount = inp.air; airMode = true; break;   // (the game leaves it as it was: Mario's air or health, both full here)
            default: amount = inp.air;
        }
        if (amount > 8) amount = 8;
        if (this.lRoot.pane.alpha !== 255) this.lRoot.pane.alpha = Math.min(255, this.lRoot.pane.alpha + 0x10);
        let airTimeout = false;
        if (inp.underWater) { if (this.unk268 < 0xF0) this.unk268++; else airTimeout = true; } else this.unk268 = 0;
        switch (this.unk18) {
            case L.HIDDEN:
                if (this.lRoot.pane.visible) this.lRoot.pane.hide();
                if (inp.diving) { this.startInsertLife(1, inp); this.unk18 = L.A_INSERT; }
                if (airTimeout) { this.resetLife(amount); this.startAppearLife(1, inp); amount = inp.air; this.unk1CC = amount; this.unk18 = L.A_APPEAR; }
                if (this.unk1CC < 8 && !this.lRoot.pane.visible && amount !== 0) { this.startAppearLife(0, inp); this.unk18 = L.H_APPEAR; }
                break;
            case L.H_APPEAR:
                if (this.processAppearLife(this.unk84++, inp)) { this.unk18 = L.H_VISIBLE; this.unk38 = false; }
                if (airTimeout && this.startDisappearLife(1)) this.unk18 = L.H_DISAPPEAR;
                break;
            case L.H_VISIBLE:
                if (this.unk1CC === 8) { this.startDisappearLife(0); this.unk18 = L.H_DISAPPEAR; }
                else if (airTimeout && this.startDisappearLife(1)) this.unk18 = L.H_DISAPPEAR;
                break;
            case L.H_DISAPPEAR:
            case L.A_DISAPPEAR:
                if (this.unk84 > 0x78) {
                    if (this.lRoot.update()) {
                        this.unk4C = false;
                        if (this.unk18 === L.H_DISAPPEAR || inp.health === 8) this.unk18 = L.HIDDEN;
                        else { amount = inp.health; this.unk1CC = amount; this.startInsertLife(0, inp); this.resetLife(amount); this.unk18 = L.H_INSERT; }
                    }
                } else this.unk84++;
                break;
            case L.H_INSERT:
                if (this.processInsertLife(this.unk84++)) this.unk18 = L.H_VISIBLE;
                break;
            case L.A_INSERT:
                if (this.processInsertLife(this.unk84++)) this.unk18 = inp.diving ? L.A_DIVING : L.A_VISIBLE;
                break;
            case L.A_APPEAR:
                if (this.processAppearLife(this.unk84, inp)) { this.unk18 = L.A_VISIBLE; this.unk38 = false; }
                if (!inp.underWater && this.unk84 === 0) this.unk84 = 1;
                if (!(amount >= 8 && this.unk84 === 0) && this.unk84 < 1000) this.unk84++;
                break;
            case L.A_VISIBLE:
                if (!inp.underWater) {
                    if (this.unk1CC === 8) { this.startDisappearLife(0); this.unk18 = L.A_DISAPPEAR; }
                    else if (this.unk1CC !== this.unk1C) { this.startAppearLife(1, inp); amount = inp.health; this.unk1CC = amount; this.resetLife(amount); this.unk18 = L.H_APPEAR; }
                }
                break;
            case L.DEMO:
                if (this.unk50) { if (this.lRoot.update()) this.unk4C = false; }
                else if (inp.health !== 8) { this.startInsertLife(0, inp); this.unk18 = L.H_INSERT; }
                else if (inp.underWater || inp.diving) { this.startInsertLife(1, inp); this.unk18 = L.A_INSERT; }
                else { amount = 8; this.unk1CC = amount; this.unk18 = L.HIDDEN; }
                break;
        }
        if (amount !== this.unk1CC && this.unk18 !== L.DEMO) {
            if (this.unk1CC < amount) { this.unk1CC++; this.petals[this.unk1CC * 2].show(); }
            else {
                const k = this.unk1CC;
                this.petals[k * 2].hide(); this.petals[k * 2].setBounds(this.petalBounds[k]); this.petals[k * 2 + 1].setBounds(this.petalBounds[k]);
                this.unk1CC--;
                if (this.unk1CC === 0) { this.petals[0].hide(); this.petals[0].setBounds(this.petalBounds[0]); this.petals[1].setBounds(this.petalBounds[0]); }
            }
            this.unk1C = this.unk1CC;
            const hi = this.unk1CC >= 4;   // setLifeMeterWhiteHigh / Low
            this.lText.pane.white = airMode ? (hi ? 0x00FFFFFF : 0x00A0FFFF) : (hi ? 0xFFFFFFFF : 0x808080FF);
            this.petals[0].white = airMode ? (hi ? 0x00FFFFFF : 0x008080FF) : (hi ? 0xFFFFFFFF : 0x808080FF);
        }
        const coins = Math.max(0, Math.min(999, inp.coins));
        if (coins !== this.unk20) { if (this.unk68 === 0) this.unk68 = 1; this.unk20 = coins; }
        if (inp.waiting && !this.unk50) {
            if (!this.sRoot.atZero() && ++this.unk30 > 200) { this.startAppearStar(); this.unk30 = 0; }
        } else {
            this.unk30 = 0;
            if (!this.unk34 && this.sRoot.atZero() && !this.unk50 && this.unk16C === 0 && this.unk8A === 0) this.startDisappearStar();
        }
        if (this.unk35) {
            let done = this.cRoot.update();
            done = this.sRoot.update() && done;
            done = this.dRoot.update() && done;
            if (done) { this.sRoot.pane.hide(); this.dRoot.pane.hide(); this.unk35 = false; }
        }
        if (this.unk168 !== inp.blue) {
            this.unk168++;
            const v = Math.max(0, this.unk168);
            this.setBlue(v);
            if (!this.dRoot.pane.visible) this.startAppearStar();
            this.unk170 = v; this.unk16C = 1;
        }
        if (this.unk16C !== 0 && ++this.unk16C > 400) this.unk16C = 0;
        const shines = inp.shines;
        if (this.unk8A === 0 && this.unk64 !== shines) this.unk8A = 1;
        if (this.unk8A !== 0) {
            if (this.unk8A === 0xFC) {
                const v = this.unk64;
                if (v < 100) {
                    if (this.sDig[2].pane.visible) this.sDig[2].pane.hide();
                    if (v % 10 === 0) this.sDig[0].setPaneBlend(10, num((v / 10) | 0));
                    this.sDig[1].setPaneBlend(10, num(v - ((v / 10) | 0) * 10));
                } else {
                    if (v % 100 === 0) { this.sDig[0].setPaneBlend(10, num((v / 100) | 0)); this.sDig[0].pane.show(); }
                    const r = v - ((v * 0.01) | 0) * 100;
                    if (r % 10 === 0) this.sDig[1].setPaneBlend(10, num((r / 10) | 0));
                    this.sDig[2].pane.show(); this.sDig[2].setPaneBlend(10, num(r % 10));
                }
            } else if (this.unk8A === 0x106) {
                if (shines > this.unk64) { this.unk64++; this.unk8A = 0xFB; }
            } else if (!this.unk34 && !this.unk35) for (const d of this.sDig) d.update();
            this.unk8A = (this.unk8A + 1) & 0xFFFF;
        }
        if (this.unk34) {
            let done = this.processAppearStar(this.unk5C, inp);
            done = this.processDownCoin(this.unk5C) && done;
            if (done) { this.unk24 = inp.shines; this.unk34 = false; }
            this.unk5C++;
        }
        // the tank: the nozzle shown, the water level, the X button's blink
        const nozzle = inp.nozzle;
        if (this.wRoot.atZero() && !this.unk45 && nozzle !== this.unk310) {
            this.nozzle.pane.hide(); this.xb.hide();
            const k = nozzle === 1 ? 2 : nozzle === 4 || nozzle === 2 ? 1 : nozzle === 5 ? 3 : 0;
            this.nozzle = this.nozzles[k]; this.xb = this.xbs[k];
            this.unk310 = nozzle;
            this.nozzle.pane.show(); this.xb.show();
        }
        this.unk2B8 = inp.water;
        this.wT[0].alpha = this.unk2B8 >= 1 ? 255 : this.unk2B8 === 0 ? 0 : 0x50;
        if (!this.unk46 && inp.fludd && !this.unk45 && !this.unk50) this.startAppearTank();
        if (this.unk45 && this.processAppearTank(this.unk7C++)) { this.unk45 = false; this.unk46 = true; this.unk7C = 0; }
        if (this.unk46) {
            if (this.unk7C < 0x46) this.xb.alpha = 0;
            else if (this.unk7C < 0x10E) this.xb.alpha = 255;
            else this.unk7C = 0;
            this.unk7C++;
        }
        if (this.unk4B) {
            let done = this.wRoot.update();
            for (const p of [this.nozzle, this.wText, this.wBack]) done = p.update() && done;
            if (done) { this.unk4B = false; this.unk46 = false; }
        }
        // the life meter's petals pulse (faster when it's low)
        if (this.lRoot.pane.visible) {
            const rate = amount === 3 ? 80 : amount === 2 ? 60 : amount === 1 ? 35 : 100;
            if (this.unk86 < rate * 2) {
                const ratio = Math.abs(this.unk86 - rate) / rate, mul = amount <= 3 ? 5 : 3;
                const o = (mul * Math.trunc(0.5 + ratio)) & 255;
                for (let i = 0; i < 9; i++) if (this.petals[i * 2].visible) {
                    const b = this.petalBounds[i], r = { x1: b.x1 - o, y1: b.y1 - o, x2: b.x2 + o, y2: b.y2 + o };
                    this.petals[i * 2].setBounds(r); this.petals[i * 2 + 1].setBounds(r);
                }
                this.unk86++;
            } else this.unk86 = 0;
        }
        if (this.unk4F && this.processAppearCoin(this.unk88++)) this.unk4F = false;
        if (this.unk4D && this.cRoot.update() && this.sRoot.update()) { this.cRoot.pane.hide(); this.unk4D = false; }
        if (!this.unk45) this.nozzle.update();   // (processMoveNozzle: the pressure bounce left out)
        const red = Math.max(0, Math.min(8, inp.red));
        if (inp.red !== this.unk444) {
            this.digit(this.rDig[0], red);
            if (!this.rRoot.pane.visible) this.startAppearRedCoin();
            this.unk444 = inp.red;
        }
        if (this.unk3C && this.processAppearRed(this.unk74++)) this.unk3C = false;
        if (this.unk58 && this.rRoot.update()) this.unk58 = false;
        if (calcAnim) this.calcAnim();
    }
    /** performCalcAnim: the coin counter rolls */
    private calcAnim() {
        if (this.wT0.pane.visible === false) this.wT0.pane.show();   // (not on Yoshi: the tank's own icon is always put back)
        if (this.unk68 > 0) {
            let counting = true;
            if (this.unk68 === 1) {
                if (this.unk20 >= this.unk6C) this.unk6C++;
                if (this.unk20 < this.unk6C) { this.unk6C--; counting = false; }
                if (this.unk6C > 999) { this.unk6C = 999; this.unk20 = 999; }
                if (this.unk6C < 0) { this.unk6C = 0; this.unk20 = 0; }
                const v = this.unk6C, d = this.cDig;
                if (counting) {
                    if (v >= 100) {
                        if (v % 100 === 0) this.digit(d[0], (v / 100) | 0);
                        const r = v - ((v * 0.01) | 0) * 100;
                        if (r % 10 === 0) this.digit(d[1], (r / 10) | 0);
                        d[2].pane.show(); this.digit(d[2], r % 10);
                    } else {
                        if (v % 10 === 0) this.digit(d[0], (v / 10) | 0);
                        this.digit(d[1], v % 10);
                        d[2].pane.hide();
                    }
                } else if (v >= 100) {
                    if (v % 100 === 99) this.digit(d[0], (v / 100) | 0);
                    const r = v - ((v * 0.01) | 0) * 100;
                    if (r % 10 === 9) this.digit(d[1], (r / 10) | 0);
                    d[2].pane.show(); this.digit(d[2], r % 10);
                } else {
                    if (v % 10 === 9) this.digit(d[0], (v / 10) | 0);
                    this.digit(d[1], v % 10);
                    d[2].pane.hide();
                }
                this.unk68++;
            }
            let done = true;
            if (!this.unk34) for (const d of this.cDig) done = d.update() && done;
            if (done) this.unk68 = this.unk20 === this.unk6C ? 0 : 1;
        }
    }
}
