// The game's menus in live play, each a port of its GC2D class on the disc's own layout, run by
// the live runner (game/runner.ts LiveRunner) a game frame at a time with the pad and drawn by the
// HUD:
//
// - PauseMenu (TPauseMenu2, GC2D/PauseMenu2.cpp: pause_1.blo): PAUSE's letters dropping in, the
//   items (continue, save, exit the area; Delfino Plaza has no exit), the stage and episode names;
//   Start / A picks, B goes back; getNextState's 0 (go on), 1 (save) or 5 (exit the area).
// - GameOverMenu (TCardSave mode 7, CardSave.cpp waitForSelectOver: save.blo's w_6): after the
//   last life, "continue from the save" or "back to the title".
// - SelectMenu (TSelectMenu, TSelectGrad and TSelectShineManager, GC2D/SelectMenu.cpp,
//   SelectShine2.cpp: select.szs's scenario_select_1.blo): the episode select of a course. The
//   ring of Shines is shine_menu.bmd in the game (a 3D model with a colour animation); here each
//   Shine is the HUD's Shine icon at the ring's projected place, size and fade.
//
// The menus run as the game runs them: the pause menu and the card save on the director's console
// list (CUE_MOVE every one of a frame's four ticks), the episode select once per performed frame
// (TSelectDir: JDrama::TDirector::direct, at 60 a second: two a game frame here).

import { Pane, Screen } from './blo.js';
import { ExPane, BoundPane, P as Pt } from './panes.js';
import { Painter, M } from './draw.js';
import { MarioGamePad, MEANING, PAD_FLAG, PadStatus } from '../game/player/pad.js';

const f32 = Math.fround;
/** a pad as TMarioGamePad with PAD_FLAG_MENU_INPUT: read on a frame's first tick, its buttons reset on the others */
export class MenuPad {
    pad = new MarioGamePad();
    constructor() { this.pad.onFlag(PAD_FLAG.MENU_INPUT); }
    tick(p: PadStatus | null, first: boolean) {
        if (first) this.pad.read(p); else this.pad.resetButtons();
        this.pad.updateMeaning();
    }
    frame(m: number) { return this.pad.checkFrameMeaning(m); }
}
export interface Menu {
    /** one game frame with the pad */
    frame(p: PadStatus | null): void;
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M): void;
}

// ---------------------------------------------------------------- TPauseMenu2
const enum PS { CLOSED, APPEARING, OPEN, UNK2, SAVING, DISAPPEARING }
interface R { x1: number; y1: number; x2: number; y2: number; }
const reform = (r: R, a: number, b: number, c: number, d: number): R => ({ x1: r.x1 + a, y1: r.y1 + b, x2: r.x2 + c, y2: r.y2 + d });
export class PauseMenu implements Menu {
    state = PS.APPEARING;
    private mask: Pane; private menu: Pane; private letters: Pane[]; private items: Pane[]; private stage: Pane; private stagePane: Pane; private task: Pane;
    private origItem: R[] = []; private origLetter: R[] = []; private origAngle: number[] = [];
    private bgAlpha = 0; private bgSpeed = 0; private firstAngle = 0; private itemColor = 0;
    private selected = 0; private bounce = 0; private fade = 0; private unkFC = 6;
    private pressedB = false; private confirmed = false;
    numItems = 3;
    private pad = new MenuPad();
    /** the sounds asked for (the viewer has no SE player for them yet): for tests */
    log: string[] = [];
    constructor(public scr: Screen, o: { delfino: boolean; stageName: string; scenarioName: string }) {
        const s = scr;
        if (o.delfino) this.numItems = 2;
        this.mask = s.find('mask'); this.menu = s.find('t_0');
        this.letters = [0, 1, 2, 3, 4].map((i) => s.find(`pa0${i}`));
        this.items = [1, 2, 3].map((i) => s.find(`tx_${i}`));
        for (const it of this.items) { if (this.numItems === 2) it.add(0, 20); it.visible = false; }
        this.stage = s.find('map'); this.stage.fontOn = true; this.stage.text = o.stageName;
        this.task = s.find('task'); this.task.fontOn = true;
        // (mapx / tasx, the shadows, keep their blo font: none in game_6, so they draw nothing)
        for (const t of ['mapx', 'tasx']) { try { s.find(t).fontOn = false; } catch { } }
        this.stagePane = s.find('brek');
        if (!o.scenarioName) { this.stage.add(0, 15); this.menu.add(0, 0x1E); }
        this.task.text = o.scenarioName;
        // loadAfter
        this.itemColor = this.items[0].white;
        for (let i = 0; i < this.numItems; i++) this.origItem[i] = { ...this.items[i].bounds };
        for (let i = 0; i < 5; i++) { this.origLetter[i] = { ...this.letters[i].bounds }; this.origAngle[i] = this.letters[i].rotation; }
        this.bgAlpha = this.mask.alpha; this.bgSpeed = f32(this.bgAlpha / 45);
        this.firstAngle = this.items[0].rotation;
        if (this.firstAngle > 180) this.firstAngle -= 360;
        this.setDrawStart();
    }
    private setDrawStart() {
        this.pressedB = false; this.confirmed = false; this.selected = 0; this.fade = 0; this.state = PS.APPEARING; this.bounce = 0;
        this.items[0].white = this.itemColor; this.items[0].visible = false;
        for (let i = 1; i < this.numItems; i++) { this.items[i].white = 0xFFFFFFFF; this.items[i].visible = false; }
        for (let i = 0; i < 5; i++) this.letters[i].rotation = (this.origAngle[i] + 180) & 0xFFFF;
        this.menu.alpha = 255; this.menu.rotation = 0;
    }
    private setDrawEnd() { this.fade = 0; this.state = PS.DISAPPEARING; }
    private drawAppearPane(p: Pane, anim: number, r: R, rot: number) {
        if (anim < 0) { if (p.visible) p.hide(); return; }
        if (anim >= 20) return;
        if (!p.visible) { p.show(); p.alpha = 0; }
        const n = f32(0.05 * anim);
        const shrink = Math.trunc(f32(f32(f32(2 * n) * f32(1 - n)) * 80)), off = Math.trunc(f32(0.75 * (19 - anim)));
        p.rotation = rot;
        p.setBounds({ x1: r.x1 + off, y1: r.y1 - shrink + off, x2: r.x2 - off, y2: r.y2 - shrink - off });
        p.alpha = Math.min(255, Math.trunc(anim * 12.8) & 0xFFFF);
    }
    private appearWindow() {
        const a = this.fade;
        if (a <= 45) {
            for (let i = 0; i < 5; i++) { const la = f32(a - 5 * i); this.drawAppearPane(this.letters[i], la, this.origLetter[i], f32(180 + this.origAngle[i] - f32(9 * la))); }
            this.mask.alpha = Math.min(this.bgAlpha, Math.trunc(f32(f32(this.bgSpeed * a) * 1.5)));
        }
        let sa = Math.trunc(f32(f32(a * this.bgSpeed) * 1.5));
        if (sa > this.bgAlpha) sa = 255;
        this.stagePane.alpha = Math.max(0, Math.min(255, sa));
        if (a >= 30) {
            for (let i = 0; i < this.numItems; i++) {
                const it = this.items[i];
                if (!it.visible) { it.visible = true; it.alpha = 0; }
                const r = this.origItem[i];
                if (a <= 40) {
                    const hx = Math.trunc(f32(3 * (a - 35))), hy = Math.trunc(f32(1.5 * (a - 35)));
                    it.setBounds(reform(r, -hx, -hy, hx, hy));
                    it.alpha = Math.min(255, Math.trunc(f32(26 * (a - 30))));
                    if (i === 0) it.rotation = Math.trunc(f32(f32(this.firstAngle * 0.1) * (a - 30))) << 16 >> 16;
                } else if (a <= 45) {
                    const hx = Math.trunc(f32(3 * (a - 45))), hy = Math.trunc(f32(1.5 * (a - 45)));
                    it.setBounds(reform(r, hx, hy, -hx, -hy));
                } else if (a >= 46 && this.state !== PS.OPEN) this.state = PS.OPEN;
            }
        }
        this.fade = f32(this.fade + 0.5);
    }
    private disappearWindow() {
        if (this.fade === 0) this.items[this.selected].setBounds(this.origItem[this.selected] || this.items[this.selected].bounds);
        if (this.fade <= 10) {
            const al = Math.max(0, this.menu.alpha - 12);
            this.menu.alpha = al;
            if (al < this.mask.alpha) this.mask.alpha = al;
            if (al < this.stagePane.alpha) this.stagePane.alpha = al;
            const shrink = (p: Pane) => {
                const r = p.bounds, w = r.x2 - r.x1, h = r.y2 - r.y1;
                const dx = Math.trunc(f32(f32(0.025 * -r.x1) + f32(0.01 * w))), dy = Math.trunc(f32(f32(0.025 * -r.y1) + f32(0.01 * h)));
                const x1 = r.x1 + dx, y1 = r.y1 + dy;
                p.setBounds({ x1, y1, x2: x1 + Math.trunc(f32(0.98 * w)), y2: y1 + Math.trunc(f32(0.98 * h)) });
            };
            for (const l of this.letters) shrink(l);
            for (let i = 0; i < this.numItems; i++) shrink(this.items[i]);
            this.menu.rotation = f32(-this.fade * 2);
        } else this.state = PS.CLOSED;
        this.fade = f32(this.fade + 0.5);
    }
    private setItem(cur: number) {
        if (this.selected === cur) return;
        this.log.push('cursor');
        this.items[this.selected].white = this.itemColor;
        this.items[cur].white = 0xFFFFFFFF;
        this.items[cur].setBounds(this.origItem[cur]);
        this.bounce = 0;
    }
    private move() {
        switch (this.state) {
            case PS.APPEARING: this.appearWindow(); break;
            case PS.OPEN: {
                const cur = this.selected, P = this.pad;
                if (P.frame(MEANING.START | MEANING.MENU_A)) {
                    this.confirmed = true;
                    if (cur === 1) this.log.push('save');
                    this.setDrawEnd();
                } else if (P.frame(MEANING.MENU_B)) { this.pressedB = true; this.fade = 0; this.setDrawEnd(); }
                else if (P.frame(MEANING.MENU_DOWN)) {
                    this.selected = this.numItems > 2 ? (cur < this.numItems - 1 ? cur + 1 : 0) : this.numItems - 1;
                    this.setItem(cur);
                } else if (P.frame(MEANING.MENU_UP)) {
                    this.selected = this.numItems > 2 ? (cur === 0 ? this.numItems - 1 : cur - 1) : 0;
                    this.setItem(cur);
                }
                if (this.state !== PS.OPEN) break;
                const r = this.origItem[this.selected], it = this.items[this.selected], b = this.bounce;
                const shift = (v: number) => ((this.itemColor + ((v << 24) >>> 0)) >>> 0);
                if (b < 18) { const hw = Math.trunc(b), hh = Math.trunc(f32(0.5 * b)); it.setBounds(reform(r, -hw, -hh, hw, hh)); it.white = shift(Math.trunc(f32(10 * b))); }
                else if (b < 35) { const hw = Math.trunc(b - 35), hh = Math.trunc(f32(0.5 * (b - 35))); it.setBounds(reform(r, hw, hh, -hw, -hh)); it.white = shift(Math.trunc(f32((35 - b) * 10))); }
                else { this.bounce = -0.5; this.unkFC = -this.unkFC; }
                this.bounce = f32(this.bounce + 0.5);
                break;
            }
            case PS.DISAPPEARING: this.disappearWindow(); break;
        }
    }
    frame(p: PadStatus | null) {
        for (let t = 0; t < 4; t++) { this.pad.tick(p, t === 0); this.move(); }
    }
    /** getNextState: 2 (still open), 0 (go on), 1 (the save's own result: here, go on), 5 (exit the area) */
    nextState() {
        if (this.confirmed) {
            if (this.state !== PS.CLOSED) return 2;
            return this.selected === 2 ? 5 : 0;
        }
        return this.pressedB && this.state === PS.CLOSED ? 0 : 2;
    }
    get savePicked() { return this.confirmed && this.selected === 1; }
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M) { if (this.state !== PS.CLOSED) P.drawScreen(cx, this.scr, base); }
}

// ---------------------------------------------------------------- TCardSave (7): the game over
export class GameOverMenu implements Menu {
    private win: ExPane; private init: R;
    private hands: Pane[][]; private opts: Pane[];
    private unk10 = 0; choice = -1; selected = 0;
    private pad = new MenuPad();
    constructor(public scr: Screen) {
        const s = scr;
        this.win = new ExPane(s, 'w_6'); this.init = { ...this.win.pane.bounds };
        this.hands = [0, 1].map((i) => [s.find(`sc${6 + i}a`), s.find(`sc${6 + i}b`)]);
        this.opts = [0, 1].map((i) => s.find(`sm${7 + i}b`));
        for (let i = 0; i < 2; i++) { s.find(`sm${7 + i}a`).fontOn = true; this.opts[i].fontOn = true; }
        // (the other windows' text boxes have no font: setFont only on theirs; the whole screen but w_6 and the mask stay hidden)
        const walk = (p: Pane) => { if (p.kind === 'TBX1' && p.fontOn === undefined) p.fontOn = false; for (const c of p.children) walk(c); };
        walk(s);
        // init(7): the mask shown, at 255
        const mask = s.find('mask'); mask.show(); mask.alpha = 255;
    }
    private centered(time: number, tw: number, th: number, iw: number, ih: number) {
        const W = this.init.x2 - this.init.x1, H = this.init.y2 - this.init.y1;
        this.win.setPaneSize(time, tw, th, iw, ih);
        this.win.setPaneOffset(time, f32((W - tw) * 0.5), f32((H - th) * 0.5), f32((W - iw) * 0.5), f32((H - ih) * 0.5));
    }
    private move() {
        const W = this.init.x2 - this.init.x1, H = this.init.y2 - this.init.y1;
        switch (this.unk10) {
            case 0:
                this.win.pane.show(); this.centered(20, W, H, 0, 0);
                for (let i = 0; i < 2; i++) { this.opts[i].hide(); this.hands[i][0].hide(); this.hands[i][1].hide(); }
                this.unk10 = 1; break;
            case 1:
                if (this.win.update()) { this.unk10 = 2; this.selected = 0; for (const o of this.opts) o.show(); this.hands[0][0].show(); this.hands[0][1].show(); }
                break;
            case 2: {
                const old = this.selected;
                if (this.pad.frame(MEANING.MENU_A)) this.unk10 = 4;
                else if (this.pad.frame(MEANING.MENU_UP)) this.selected = 0;
                else if (this.pad.frame(MEANING.MENU_DOWN)) this.selected = 1;
                if (old !== this.selected) { this.hands[old][0].hide(); this.hands[old][1].hide(); this.hands[this.selected][0].show(); this.hands[this.selected][1].show(); }
                break;
            }
            case 4:
                this.centered(20, 0, 0, W, H);
                for (const o of this.opts) o.hide();
                this.hands[this.selected][0].hide(); this.hands[this.selected][1].hide();
                this.unk10 = 3; break;
            case 3: if (this.win.update()) { this.win.pane.hide(); this.unk10 = 5; } break;
            case 5: this.choice = this.selected; break;
        }
    }
    frame(p: PadStatus | null) { for (let t = 0; t < 4; t++) { this.pad.tick(p, t === 0); this.move(); } }
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M) { P.drawScreen(cx, this.scr, base); }
}

// ---------------------------------------------------------------- TSelectMenu / TSelectGrad / TSelectShineManager
const enum SS { CLOSE_MENU, LETTERBOX_ANIMATION, STAGE_BANNER_SLIDE, STAGE_BANNER_SQUASH, STAGE_BANNER_STRETCH, APPEAR_MENU, MENU_INPUT_LOOP, MENU_ANIM_LOOP, DISAPPEAR_MENU, WAIT_BEFORE_CLOSE }
export interface SelectInput {
    stage: number;
    /** each episode's state (mShineUnlockStates: 3 got, 2 open, 0 not yet) and how many are open */
    states: number[]; open: number;
    /** the coin record (MSF_COIN_RECORD_BASE + the stage) and the stage's 100-coin / extra Shines got */
    coins: number; coinShine: boolean; extra: number;
    stageName: string; scenarioName: (episode: number) => string;
}
/** TSelectShine (its bob, spin and colour frame), drawn as a sprite */
class SelectShine {
    selected = false; phase = 0; height = 10; speed = 0.01; spin = 0; spinSpeed = 3; frame = 0; unk48 = false; unk49 = false;
    pos = { x: 0, y: 0, z: 0 }; offY = 0;
    constructor(public type: number, phase: number) { this.phase = phase; }
    static curve(t: number, a: number, b: number, c: number) { const s = f32(1 - t); return f32(f32(a * f32(s * s)) + f32(f32(b * f32(f32(2 * s) * t)) + f32(c * f32(t * t)))); }
    move(frameMax: number) {
        const h = this.height, p = this.phase;
        let y = 0;
        if (p < 1) y = SelectShine.curve(p, 0, f32(h * 0.9), h);
        else if (p < 2) y = SelectShine.curve(f32(p - 1), h, f32(h * 0.9), 0);
        else if (p < 3) y = SelectShine.curve(f32(p - 2), 0, f32(-h * 0.9), -h);
        else if (p < 4) y = SelectShine.curve(f32(p - 3), -h, f32(-h * 0.9), 0);
        this.offY = y;
        let fr = Math.trunc(f32(-0.05 * this.pos.z)) << 16 >> 16;
        if (fr < 30) fr = 30;
        if (this.unk48) { this.frame -= 8; if (this.frame < fr) this.frame = fr; }
        else if (this.unk49) { this.frame += 8; if (this.frame > frameMax - 1) this.frame = frameMax - 1; }
        else this.frame = Math.max(0, Math.min(frameMax, fr));
        if (this.selected) { this.spin += this.spinSpeed * 0.5; if (this.spin > 360) this.spin -= 360; }
        else if (this.spin !== 0) { this.spin += Math.trunc(this.spinSpeed * 0.5); if (this.spin > 360) this.spin = 0; }
        this.phase = f32(this.phase + this.speed);
        if (this.phase > 4) this.phase = 0;
    }
}
/** shine_menu.bpk's (and shine_menu_empty.bpk's) colour animation length: 99 frames (its PAK1 duration) */
const SHINE_FRAME_MAX = 99;
export class SelectMenu implements Menu {
    state = SS.CLOSE_MENU;
    closeMenu = false; selected = 0;
    private pad = new MenuPad();
    private top: ExPane; private bottom: ExPane; private stageName: Pane; private sc1: ExPane; private sc2: ExPane;
    private img1: Pane; private sh1: Pane; private img2: Pane; private sh2: Pane;
    private dist = 0; private shineList: Pane; private score: Pane;
    private marks: (Pane | null)[] = []; private arrowL: Pane | null = null; private arrowR: Pane | null = null;
    private arrowLB: R | null = null; private arrowRB: R | null = null;
    private arrowDir = true; private arrowPos = 0; private markDir = true;
    private selCol = 0; private selAlpha = 255; private markCol = 0; private markAlpha = 255;
    private banner: ExPane; private bannerText: BoundPane; private bannerShadow: BoundPane;
    private txt1: Pane; private txt2: Pane;
    private frameN = 0; private waitN = 0; private waitMax = 10;
    private rcp = 2;
    // TSelectGrad
    private cycle = [2, 0, 4]; private tl = [255, 0, 0]; private br = [255, 255, 0];
    // TSelectShineManager
    shines: (SelectShine | null)[] = [];
    private ring = 0; private ringSpeed = 0; private inc = false; private dec = false; private mgrSel = 0;
    constructor(public scr: Screen, public inp: SelectInput, private numTex: (i: number) => string, private rand: () => number) {
        const s = scr, st = inp.stage;
        this.top = new ExPane(s, 'msk1'); this.bottom = new ExPane(s, 'msk2');
        this.stageName = s.find('map');
        this.sc1 = new ExPane(s, 's_0'); this.sc2 = new ExPane(s, '0_0');
        this.sc2.pane.hide();
        this.img1 = s.find('s_2a'); this.sh1 = s.find('s_2b'); this.img2 = s.find('0_2a'); this.sh2 = s.find('0_2b');
        this.txt1 = s.find('sttx'); this.txt2 = s.find('0ttx');
        this.dist = this.sc2.pane.bounds.x1 - this.sc1.pane.bounds.x1;
        this.shineList = s.find('i_0'); this.score = s.find('sc_0');
        // (the text boxes the game gives no font draw nothing)
        const walk = (p: Pane) => { if (p.kind === 'TBX1') p.fontOn = false; for (const c of p.children) walk(c); };
        walk(s);
        // the coin record
        const coins = Math.max(0, Math.min(999, inp.coins));
        const dg = [0, 1, 2].map((i) => s.find(`sc_${1 + i}`));
        s.find('sc_s').hide();
        if (coins < 100) { dg[1].tex = `coin_number_${Math.trunc(f32(coins * 0.1))}.bti`; dg[2].tex = `coin_number_${coins % 10}.bti`; dg[0].hide(); }
        else {
            const h = f32(coins * 0.01), d0 = Math.trunc(h);
            dg[0].tex = `coin_number_${d0}.bti`; dg[1].tex = `coin_number_${Math.trunc(f32(0.1 * (coins - 100 * d0)))}.bti`; dg[2].tex = `coin_number_${coins % 10}.bti`;
            if (inp.coinShine) s.find('sc_s').show();
        }
        if (inp.extra === 0) { s.find('sc_0').add(83, 0); s.find('r_i').hide(); }
        else if (inp.extra === 1) s.find('r_s2').hide();
        s.find('bi_0').hide();
        const TAGS = ['', '', 'bi_', 'rc_', 'mm_', 'pi_', 'sr_', '', 'mo_', 'mr_', ''];
        const tg = TAGS[st] || 'bi_';
        this.banner = new ExPane(s, tg + '0'); this.banner.pane.show();
        this.bannerText = new BoundPane(s, tg + 'a'); this.bannerText.pane.show();
        this.bannerShadow = new BoundPane(s, tg + 'b'); this.bannerShadow.pane.show();
        this.stageName.text = inp.stageName.slice(0, 17); this.stageName.fontOn = true;
        const n = inp.open;
        this.selected = Math.max(0, n - 1);
        if (n > 1) {
            this.arrowL = s.find(`a_l${n}`); this.arrowR = s.find(`a_r${n}`);
            this.arrowLB = { ...this.arrowL.bounds }; this.arrowRB = { ...this.arrowR.bounds };
            if (this.selected !== 0) this.arrowL.show();
            if (this.selected !== n - 1) this.arrowR.show();
        }
        // the open episodes' marks along the bottom, centred (odd counts on i_o, even on i_e)
        const odd = (n & 1) === 1, first = odd ? (7 - n) >> 1 : (8 - n) >> 1;
        for (let i = 0, slot = first; slot <= first + n - 1; slot++, i++) {
            const m = s.find(`${odd ? 'i_o' : 'i_e'}${slot}`);
            this.marks[i] = m; m.show();
            if (inp.states[i] === 2 || inp.states[i] === 1) m.tex = 'sc_mark_0.bti';
            else if (inp.states[i] === 0) m.hide();
        }
        this.selCol = s.find('i_o0').white; this.selAlpha = 255;
        this.markCol = s.find('i_o2').white; this.markAlpha = s.find('i_o2').alpha;
        s.find('i_o0').white = this.markCol; s.find('i_o0').alpha = this.markAlpha;
        const ms = this.marks[this.selected];
        if (ms) { ms.white = this.selCol; ms.alpha = this.selAlpha; }
        this.img1.tex = this.sh1.tex = numTex(this.selected);
        this.txt1.fontOn = this.txt2.fontOn = true;
        this.txt1.text = inp.scenarioName(this.selected);
        // initData's Shine ring (TSelectShineManager::initData: a rand() each Shine there is)
        this.mgrSel = this.selected; this.ring = this.selected * -40;
        for (let i = 0; i < 8; i++) {
            const pos = this.position(this.ring + i * 40);
            const stt = inp.states[i];
            if (stt === 3 || stt === 1 || stt === 2) {
                const ph = Math.trunc(f32(4000 * f32(this.rand() * f32(1 / 32768)))) / 1000;
                const sh = new SelectShine(stt === 3 ? 0 : 1, f32(ph));
                sh.pos = pos;
                this.shines[i] = sh;
            } else this.shines[i] = null;
        }
        if (this.shines[this.selected]) this.shines[this.selected]!.selected = true;
        this.startOpenWindow();
    }
    /** TSelectShineManager::getPosition: the ring (radius 1500 across, 9000 deep about (300, 160, -9000)); JMASSin's s16 angle is 57.3 x the step's */
    private position(a: number) {
        const s16 = (Math.trunc(f32(57.295776 * (a << 16 >> 16))) << 16) >> 16, r = (s16 * Math.PI) / 32768;
        return { x: f32(f32(1500 * Math.sin(r)) + 300), y: 160, z: f32(f32(9000 * Math.cos(r)) - 9000) };
    }
    private startOpenWindow() {
        this.state = SS.LETTERBOX_ANIMATION;
        this.stageName.hide(); this.banner.pane.hide(); this.sc1.pane.hide(); this.shineList.hide(); this.score.hide();
        const t = Math.trunc(30 * this.rcp);
        let r = this.top.pane.bounds;
        this.top.setPaneSize(t, r.x2 - r.x1, r.y2 - r.y1, r.x2 - r.x1, 0);
        r = this.bottom.pane.bounds;
        this.bottom.setPaneSize(t, r.x2 - r.x1, r.y2 - r.y1, r.x2 - r.x1, 0);
        this.bottom.setPaneOffset(t, 0, 0, 0, r.y2 - r.y1);
        this.frameN = 0;
    }
    private next() { for (let i = this.selected + 1; i < 8; i++) if (this.inp.states[i] === 2 || this.inp.states[i] === 3) return i; return -1; }
    private prev() { for (let i = this.selected - 1; i >= 0; i--) if (this.inp.states[i] === 2 || this.inp.states[i] === 3) return i; return -1; }
    private choose(to: number, right: boolean) {
        const mgrStep = right ? to - this.selected : this.selected - to;
        // TSelectShineManager::startIncrease / startDecrease
        if (right) { this.inc = true; this.ringSpeed = Math.trunc((mgrStep * -40) / 10); this.mgrSel += mgrStep; }
        else { this.dec = true; this.ringSpeed = Math.trunc((mgrStep * 40) / 10); this.mgrSel -= mgrStep; }
        this.sc2.pane.show(); this.sc2.setPaneAlpha(10, 255, 0);
        this.sc2.setPaneOffset(10, -this.dist, 0, right ? 0 : -this.dist * 2, 0);
        this.sc1.pane.show(); this.sc1.setPaneAlpha(10, 0, 255);
        this.sc1.setPaneOffset(10, right ? -this.dist : this.dist, 0, 0, 0);
        this.img2.tex = this.sh2.tex = this.numTex(to);
        this.img1.tex = this.sh1.tex = this.numTex(this.selected);
        this.txt1.text = this.inp.scenarioName(this.selected);
        const old = this.marks[this.selected];
        if (old) { old.white = this.markCol; old.alpha = this.markAlpha; }
        if (this.shines[this.selected]) this.shines[this.selected]!.selected = false;
        this.selected = to;
        this.txt2.text = this.inp.scenarioName(to);
        const nm = this.marks[to];
        if (nm) { nm.white = this.selCol; nm.alpha = this.selAlpha; }
        if (this.shines[to]) this.shines[to]!.selected = true;
        const n = this.inp.open;
        if (n > 1 && this.arrowL && this.arrowR) {
            if (this.selected !== 0 && !this.arrowL.visible) this.arrowL.show();
            if (this.selected !== n - 1 && !this.arrowR.visible) this.arrowR.show();
        }
        this.state = SS.MENU_ANIM_LOOP;
    }
    private perform() {
        const rc = this.rcp;
        switch (this.state) {
            case SS.LETTERBOX_ANIMATION: {
                let u = this.top.update(); u = this.bottom.update() && u;
                if (u || this.frameN > Math.trunc(20 * rc)) {
                    this.banner.pane.show();
                    this.banner.setPaneOffset(Math.trunc(20 * rc), 0, 0, 601 - this.banner.init.x1, 0);
                    this.state = SS.STAGE_BANNER_SLIDE;
                }
                this.frameN++;
                break;
            }
            case SS.STAGE_BANNER_SLIDE: {
                let u = this.top.update(); u = this.bottom.update() && u; u = this.banner.update() && u;
                if (u) {
                    const t = Math.trunc(15 * rc);
                    for (const b of [this.bannerText, this.bannerShadow]) { b.setPanePosition(t, Pt(0, 0), Pt(0, -6), Pt(0, -10)); b.setPaneSize(t, Pt(0, 0), Pt(-110, 12), Pt(-160, 20)); }
                    this.state = SS.STAGE_BANNER_SQUASH;
                }
                break;
            }
            case SS.STAGE_BANNER_SQUASH: {
                let u = this.bannerText.update(); u = this.bannerShadow.update() && u;
                if (u) {
                    const t = Math.trunc(20 * rc);
                    for (const b of [this.bannerText, this.bannerShadow]) { b.setPanePosition(t, Pt(0, -10), Pt(0, -6), Pt(0, 4)); b.setPaneSize(t, Pt(-160, 20), Pt(-110, 12), Pt(40, -8)); }
                    this.state = SS.STAGE_BANNER_STRETCH;
                }
                break;
            }
            case SS.STAGE_BANNER_STRETCH: {
                let u = this.bannerText.update(); u = this.bannerShadow.update() && u;
                if (u) {
                    const t = Math.trunc(15 * rc);
                    for (const b of [this.bannerText, this.bannerShadow]) { b.setPanePosition(t, Pt(0, 4), Pt(0, 3), Pt(0, 0)); b.setPaneSize(t, Pt(40, -8), Pt(15, -6), Pt(0, 0)); }
                    this.stageName.show(); this.stageName.alpha = 0;
                    this.sc1.pane.show(); this.sc1.pane.alpha = 0;
                    this.shineList.show(); this.shineList.alpha = 0;
                    this.score.show(); this.score.alpha = 0;
                    this.state = SS.APPEAR_MENU;
                }
                break;
            }
            case SS.APPEAR_MENU: {
                let u = this.bannerText.update(); u = this.bannerShadow.update() && u;
                const sa = Math.min(255, Math.trunc(f32(0.5 * 6 + this.stageName.alpha)) & 0xFFFF);
                this.stageName.alpha = sa;
                let ma = 0;
                if (sa > 128) {
                    const ca = this.sc1.pane.alpha;
                    ma = Math.trunc(Math.min(255, f32(0.5 * 6 + ca)));
                    this.sc1.pane.alpha = ma; this.shineList.alpha = ma; this.score.alpha = ma;
                }
                if (u && ma === 255) this.state = SS.MENU_INPUT_LOOP;
                break;
            }
            case SS.WAIT_BEFORE_CLOSE:
                if (this.waitN > this.waitMax) this.state = SS.CLOSE_MENU;
                this.waitN++;
                break;
            case SS.MENU_INPUT_LOOP:
            case SS.MENU_ANIM_LOOP: {
                if (this.state === SS.MENU_INPUT_LOOP) {
                    const P = this.pad;
                    if (P.frame(MEANING.MENU_A)) {
                        const t = Math.trunc(30 * rc);
                        let r = this.top.pane.bounds;
                        this.top.setPaneSize(t, r.x2 - r.x1, 224, r.x2 - r.x1, r.y2 - r.y1);
                        this.top.setPaneAlpha(t, 255, this.top.pane.alpha);
                        r = this.bottom.pane.bounds;
                        this.bottom.setPaneSize(t, r.x2 - r.x1, r.y2 - 224, r.x2 - r.x1, r.y2 - r.y1);
                        this.bottom.setPaneOffset(t, 0, 224 - r.y1, 0, 0);
                        this.bottom.setPaneAlpha(t, 255, this.bottom.pane.alpha);
                        // TSelectShineManager::startClose
                        if (this.shines[this.mgrSel]) this.shines[this.mgrSel]!.selected = false;
                        this.shines.forEach((s, i) => { if (s && i !== this.mgrSel && !s.unk49) { s.unk49 = true; s.unk48 = false; } });
                        this.state = SS.DISAPPEAR_MENU;
                        break;
                    } else if (P.frame(MEANING.MENU_LEFT)) { const p = this.prev(); if (p !== -1) this.choose(p, false); }
                    else if (P.frame(MEANING.MENU_RIGHT)) { const n = this.next(); if (n !== -1) this.choose(n, true); }
                }
                const n = this.inp.open, L = this.arrowL, Rr = this.arrowR;
                if (n > 1 && L && Rr && this.arrowLB && this.arrowRB) {
                    const x = Math.trunc(f32(f32(this.arrowPos * 0.5) * 0.5));
                    if (L.visible) L.move(this.arrowLB.x1 - x, this.arrowLB.y1);
                    if (Rr.visible) Rr.move(this.arrowRB.x1 + x, this.arrowRB.y1);
                    if (this.arrowDir) { this.arrowPos++; if (this.arrowPos > 10) this.arrowDir = false; }
                    else { this.arrowPos--; if (this.arrowPos === 0) this.arrowDir = true; }
                    let a = L.alpha;
                    if (this.selected === 0) { if (a !== 0) { a -= 4; if (a < 0) { a = 0; L.hide(); } L.alpha = a; } }
                    else if (a < this.markAlpha) { a = Math.min(this.markAlpha, a + 4); L.alpha = a; }
                    a = Rr.alpha;
                    if (this.next() === -1) { if (a !== 0) { a -= 4; if (a < 0) { a = 0; Rr.hide(); } Rr.alpha = a; } }
                    else if (a < this.markAlpha) { a = Math.min(this.markAlpha, a + 4); Rr.alpha = a; }
                }
                if (this.state !== SS.MENU_INPUT_LOOP) {
                    let u = this.sc1.update(); u = this.sc2.update() && u;
                    if (u) { this.sc1.pane.hide(); this.state = SS.MENU_INPUT_LOOP; }
                }
                const mk = this.marks[this.selected];
                if (mk) {
                    let a = mk.alpha;
                    if (this.markDir) { a += 6; if (a > this.selAlpha) { this.markDir = false; a = this.selAlpha; } }
                    else { a -= 6; if (a < 64) { this.markDir = true; a = 64; } }
                    mk.alpha = a;
                }
                break;
            }
            case SS.DISAPPEAR_MENU: {
                let u = true;
                let a = this.stageName.alpha - 16;
                if (a <= 0) a = 0; else u = false;
                this.stageName.alpha = a; this.bannerText.pane.alpha = a;
                if (a < this.bannerShadow.pane.alpha) this.bannerShadow.pane.alpha = a;
                this.sc1.pane.alpha = a; this.sc2.pane.alpha = a; this.shineList.alpha = a; this.score.alpha = a;
                u = this.top.update() && u; u = this.bottom.update() && u;
                for (const m of [this.top, this.bottom]) {
                    const c = m.pane.corner, v1 = (c[0] & 0xFF) + 16, v2 = (c[2] & 0xFF) + 16;
                    if (v1 <= 255) u = false;
                    if (v2 <= 255) u = false;
                    const A1 = Math.min(255, v1), A2 = Math.min(255, v2);
                    m.pane.corner = [A1, A1, A2, A2];
                }
                if (u) { this.state = SS.WAIT_BEFORE_CLOSE; this.waitN = 0; }
                break;
            }
            case SS.CLOSE_MENU: this.closeMenu = true; break;
        }
    }
    private grad() {
        let nextCycle = false;
        for (let i = 0; i < 3; i++) {
            switch (this.cycle[i]) {
                case 0: { let v = this.br[i] + 2; if (v > 255) { v = 255; nextCycle = true; } this.br[i] = v; break; }
                case 3: { let v = this.br[i] - 2; if (v < 0) { v = 0; nextCycle = true; } this.br[i] = v; break; }
            }
            let tc = this.cycle[i] - 1;
            if (tc < 0) tc = 5;
            switch (tc) {
                case 0: this.tl[i] = Math.min(255, this.tl[i] + 2); break;
                case 3: this.tl[i] = Math.max(0, this.tl[i] - 2); break;
            }
        }
        if (nextCycle) this.cycle = this.cycle.map((c) => (c + 1 >= 6 ? 0 : c + 1));
    }
    /** TSelectGrad::setStageColor */
    setStageColor(st: number) {
        const S: Record<number, [number[], number[], number[]]> = { 2: [[3, 1, 5], [255, 255, 0], [0, 255, 0]], 3: [[4, 2, 0], [0, 255, 0], [0, 255, 255]], 4: [[2, 0, 4], [255, 0, 0], [255, 255, 0]], 13: [[0, 4, 2], [0, 0, 255], [255, 0, 255]] };
        const v = S[st];
        if (v) { this.cycle = [...v[0]]; this.tl = [...v[1]]; this.br = [...v[2]]; }
    }
    private shineMgr() {
        for (const s of this.shines) if (s) { s.move(SHINE_FRAME_MAX); }
        if (this.inc || this.dec) {
            this.ring += this.ringSpeed;
            if (this.inc && this.ring < this.mgrSel * -40) { this.ring = this.mgrSel * -40; this.inc = false; }
            if (this.dec && this.ring > this.mgrSel * -40) { this.ring = this.mgrSel * -40; this.dec = false; }
            this.shines.forEach((s, i) => { if (s) s.pos = this.position(this.ring + i * 40); });
        }
    }
    /** one game frame: two performs (the select director's 60 a second) */
    frame(p: PadStatus | null) {
        for (let k = 0; k < 2; k++) {
            this.pad.tick(p, true);
            this.perform();   // (Group 2D: TSelectMenu)
            this.shineMgr();  // (Group 3D: the Shines)
            this.grad();      // (Group Grad: its CUE_CALC_ANIM)
        }
    }
    /** TSelectDir: the screen draws Grad, 3D (the Shines), 2D (the menu) — after the A press the menu before the Shines (changeOrder) */
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M, shineIcon?: (cx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number, empty: boolean, spin: number) => void) {
        // TSelectGrad: 0..600 x 16..464 in four corner colours (the mid colour at the other two)
        const mid = [0, 1, 2].map((i) => (this.tl[i] + this.br[i]) >> 1);
        const g = cx.createLinearGradient(0, 16, 600, 464);
        g.addColorStop(0, `rgb(${this.tl.join(',')})`); g.addColorStop(0.5, `rgb(${mid.join(',')})`); g.addColorStop(1, `rgb(${this.br.join(',')})`);
        cx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
        cx.globalAlpha = 1; cx.fillStyle = g; cx.fillRect(-200, -100, 1000, 680);
        const after = this.state === SS.DISAPPEAR_MENU || this.state === SS.WAIT_BEFORE_CLOSE || this.state === SS.CLOSE_MENU;
        if (after) P.drawScreen(cx, this.scr, base);
        if (shineIcon) {
            // the select's camera: (300, 240, 1300) to (300, 240, 0), 30 degrees, 4:3 over the 600 x 448 view at y 16
            const f = 1 / Math.tan((15 * Math.PI) / 180);
            const order = this.shines.map((s, i) => ({ s, i })).filter((o) => o.s).sort((a, b) => a.s!.pos.z - b.s!.pos.z);
            for (const { s } of order) {
                const sh = s!, d = 1300 - sh.pos.z;
                if (d <= 50) continue;
                const x = 300 + ((sh.pos.x - 300) / d) * (f / (4 / 3)) * 300, y = 240 - (((sh.pos.y + sh.offY) - 240) / d) * f * 224;
                const size = (230 / d) * f * 224;
                const alpha = Math.max(0, Math.min(1, 1 - sh.frame / SHINE_FRAME_MAX));
                cx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
                shineIcon(cx, x, y, size, alpha, sh.type === 1, sh.spin);
            }
        }
        if (!after) P.drawScreen(cx, this.scr, base);
    }
}
