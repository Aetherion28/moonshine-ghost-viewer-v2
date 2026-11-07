// The title scene's debug menu and its kin, ports of their classes on the disc's own layout:
//
// - MenuDirector (TMenuDirector, System/MenuDir.cpp): /data/title.arc's title.blo, its "Group 2D"
//   of a TMenuBase (the screen), a TFlashPane ('stat') and two TMenuPlanes ('lisB': the areas,
//   'lisC': the scenes, 33 = START | MENU_A confirms, 64 = MENU_B cancels); 'stag' shows the area
//   picked; marisun_stage.bmg names the areas (tx01..tx09, tx10..). direct's states: 0 the area
//   list, 1 the scene list, 2 fading out to the game (or a movie), 3 to quit. setFixedStageValue
//   turns the two lists' picks into the area and scene (TGameSequence) or the movie.
// - MenuBase (TMenuBase), MenuPlane (TMenuPlane), FlashPane (TFlashPane): GC2D/Menu.cpp.
// - HelpActor / SwitchHelpActor (THelpActor, TSwitchHelpActor: GC2D/HelpActor.cpp): scene.bin's
//   BalloonHelp / SwitchHelp; the console's help balloon while Mario touches one (here told as the
//   world effect 'balloon:<id>' / 'balloonOff:<id>'), a switch's not once it's pressed (state 3).
// - MapObjOptionWall (TMapObjOptionWall, MoveBG/MapObjOption.cpp): option_wall.col's warp collision,
//   set up and removed by its owner (the options screen).

import { Pane, Screen, tagOf } from './blo.js';
import { Painter, M } from './draw.js';
import { bmgMessage } from './gx.js';
import { MOVIES } from './moviescreen.js';
import { MenuPad } from './menus.js';
import { MEANING, PadStatus, PAD } from '../game/player/pad.js';
import { NameRef, HitActor, Stream, World, LiveActor, LF, HC } from '../game/engine.js';
import { register } from '../game/scene.js';
import { AT } from '../game/actortypes.js';
import { ObjCollision, KIND_WARP } from '../game/mapobj/objcol.js';
import { MSF } from '../game/msflags.js';
import { V } from '../game/version.js';
import type { FlagManager } from '../game/flags.js';

const CUE_MOVE = 0x1, CUE_DRAW = 0x8;
const TYPE_TEXTBOX = 0x13;
const typeID = (p: Pane) => (p.kind === 'TBX1' ? 0x13 : p.kind === 'PIC1' ? 0x12 : p.kind === 'WIN1' ? 0x11 : 0x10);
const rgba = (r: number, g: number, b: number, a: number) => (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);

/** snprintf(buf, n, ...): at most n - 1 bytes of Shift-JIS (two bytes a character past ASCII) */
function snprintf(n: number, s: string) {
    let out = '', len = 0;
    for (const ch of s) {
        const w = ch.charCodeAt(0) < 0x80 || (ch.charCodeAt(0) >= 0xFF61 && ch.charCodeAt(0) <= 0xFF9F) ? 1 : 2;
        if (len + w > n - 1) break;
        out += ch; len += w;
    }
    return out;
}
const d2 = (i: number) => (i < 10 && i >= 0 ? '0' + i : String(i));

// ---------------------------------------------------------------- TMenuBase
export class MenuBase extends NameRef {
    constructor(public mScreen: Screen, name = '<TMenuBase>') { super(name); }
    /** CUE_DRAW: the screen in a J2DOrthoGraph of the viewport */
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M) { P.drawScreen(cx, this.mScreen, base); }
}

// ---------------------------------------------------------------- TMenuPlane
export const MENU_PLANE_FLAG = { CONFIRMED: 0x1, CANCELLED: 0x2, INPUT_DISABLED: 0x4 };
export class MenuPlane extends NameRef {
    mFlags = 0;
    mSelectedCharColor = rgba(255, 60, 0, 255);
    mSelectedGradColor = rgba(255, 255, 0, 255);
    mNormalColor = rgba(255, 255, 255, 255);
    mItemCount = 0;
    mSelectedIndex = 0;
    mItems: Pane[];
    mColumnStride = 0;
    constructor(public mGamePad: MenuPad, public mRootPane: Pane, public mConfirmInputMask: number, public mCancelInputMask: number) {
        super('<TMenuPlane>');
        const found: Pane[] = [];
        for (const it of mRootPane.children) {
            if (typeID(it) === TYPE_TEXTBOX && it.tag !== tagOf('rset')) {
                found[this.mItemCount] = it;
                if (this.mItemCount === 0) {
                    this.mNormalColor = it.charColor;
                    it.charColor = this.mSelectedCharColor;
                    it.gradColor = this.mSelectedGradColor;
                }
                ++this.mItemCount;
            }
        }
        this.mItems = found.slice(0, this.mItemCount);
    }
    show() { this.mColumnStride = 10; this.mRootPane.show(); this.flags &= ~CUE_MOVE; this.mFlags = 0; }
    hide() { this.mColumnStride = 10; this.mRootPane.hide(); this.flags |= CUE_MOVE; this.mFlags = 0; }
    fade() { this.mFlags |= MENU_PLANE_FLAG.INPUT_DISABLED; this.mRootPane.alpha = 160; }
    unfade() { this.mFlags = 0; this.mRootPane.alpha = 255; }
    checkFlag(f: number) { return (this.mFlags & f) !== 0; }
    perform(cue: number) {
        if (this.mFlags & MENU_PLANE_FLAG.INPUT_DISABLED) return;
        if (!(cue & CUE_MOVE)) return;
        const pad = this.mGamePad;
        if (pad.frame(this.mConfirmInputMask)) { this.mFlags |= MENU_PLANE_FLAG.CONFIRMED; return; }
        if (pad.frame(this.mCancelInputMask)) { this.mFlags |= MENU_PLANE_FLAG.CANCELLED; return; }
        if (this.mItemCount > 1 && pad.frame(MEANING.MENU_UP | MEANING.MENU_DOWN | MEANING.MENU_LEFT | MEANING.MENU_RIGHT)) {
            this.mItems[this.mSelectedIndex].charColor = this.mNormalColor;
            this.mItems[this.mSelectedIndex].gradColor = this.mNormalColor;
            if (pad.frame(MEANING.MENU_LEFT | MEANING.MENU_RIGHT)) {
                if (this.mSelectedIndex < this.mColumnStride) {
                    if (this.mItemCount > this.mSelectedIndex + this.mColumnStride) this.mSelectedIndex += this.mColumnStride;
                } else this.mSelectedIndex -= this.mColumnStride;
            }
            if (pad.frame(MEANING.MENU_UP)) {
                if (this.mSelectedIndex === 0) this.mSelectedIndex = this.mItemCount;
                this.mSelectedIndex -= 1;
            } else if (pad.frame(MEANING.MENU_DOWN)) {
                this.mSelectedIndex += 1;
                if (this.mSelectedIndex >= this.mItemCount) this.mSelectedIndex = 0;
            }
            this.mItems[this.mSelectedIndex].charColor = this.mSelectedCharColor;
            this.mItems[this.mSelectedIndex].gradColor = this.mSelectedGradColor;
        }
    }
}

// ---------------------------------------------------------------- TFlashPane
export class FlashPane extends NameRef {
    mAlpha = 0; mAlphaStep = 4;
    constructor(public mPane: Pane, name = '<TFlashPane>') { super(name); }
    hide() { this.mPane.hide(); this.flags |= CUE_MOVE; }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        this.mAlpha += this.mAlphaStep;
        if (this.mAlphaStep < 0) {
            if (this.mAlpha <= 0) { this.mAlpha = 0; this.mAlphaStep = 4; }
        } else if (this.mAlpha >= 255) { this.mAlpha = 255; this.mAlphaStep = -4; }
        this.mPane.alpha = this.mAlpha & 0xFF;
    }
}

// ---------------------------------------------------------------- TMenuDirector
/** TApplication's states direct returns */
export const APP_STATE = { DEFAULT: 0, GAMEPLAY: 4, MOVIE: 5, QUIT: 6 };
export interface MenuHost {
    /** TFlagManager (confirming an area without X held fills the save: all Shines, the nozzle and card bools) */
    flags?: FlagManager;
    /** the fader: startFadeinT / startFadeoutT, isFullyFadedOut */
    fadeIn?(t: number): void; fadeOut?(t: number): void; fadedOut?(): boolean;
    /** SMSGetApplication()->setNextArea / setMovie */
    setNextArea?(stage: number, scenario: number): void; setMovie?(id: number): void;
}
export class MenuDirector {
    unk18 = 0;
    unk1C: Uint8Array | null = null;
    unk20!: Pane; unk24!: FlashPane;
    unk38!: Pane; unk3C!: Screen;
    unk40!: MenuPlane; unk44!: MenuPlane;
    unk48 = 0; unk4C = 0;
    unk50 = false;
    /** the movie setFixedStageValue picked (SMSGetApplication()->setMovie), -1 none */
    movie = -1;
    /** "Group 2D": the view objects in their order */
    group2d: NameRef[] = [];
    unk2C = new MenuPad();
    private fadeT = 0; private fadeDir = 0;
    constructor(private host: MenuHost = {}) { }
    /** rsetup: title.arc's title.blo and marisun_stage.bmg; 1 when the layout lacks a pane, 0 done */
    rsetup(arc: Map<string, Uint8Array>, parse: (b: Uint8Array) => Screen) {
        const blo = arc.get('title.blo') || arc.get('scrn/title.blo') || [...arc.entries()].find(([k]) => k.endsWith('/title.blo'))?.[1];
        if (!blo) return 1;
        const scr = this.unk3C = parse(blo);
        this.group2d.push(new MenuBase(scr));
        this.unk20 = scr.find('lisA');
        this.unk20.hide();
        const stat = scr.search(tagOf('stat'));
        if (!stat) return 1;
        if (typeID(stat) !== 0x12) return 1;
        this.unk24 = new FlashPane(stat);
        this.group2d.push(this.unk24);
        this.unk24.hide();
        this.unk40 = new MenuPlane(this.unk2C, scr.find('lisB'), 33, 64);
        this.group2d.push(this.unk40);
        this.unk40.hide();
        this.unk44 = new MenuPlane(this.unk2C, scr.find('lisC'), 33, 64);
        this.group2d.push(this.unk44);
        this.unk44.hide();
        const stag = scr.search(tagOf('stag'));
        if (!stag) return 1;
        this.unk38 = stag;
        this.unk38.hide();
        this.unk1C = [...arc.entries()].find(([k]) => k.endsWith('marisun_stage.bmg'))?.[1] || null;
        if (this.unk1C) {
            for (let i = 0; i < 19; ++i) {
                const message = bmgMessage(this.unk1C, i);
                let s: string;
                if (message) s = snprintf(22, `${d2(i)} ${message}`);
                else if (i === 17 || i === 18) s = snprintf(22, `show movie ${i === 17 ? 1 : 2}`);
                else s = snprintf(22, `${d2(i)} No Data            `);
                const p = i < 9 ? scr.search((tagOf('tx01') + i) >>> 0) : scr.search((tagOf('tx10') + i - 9) >>> 0);
                if (p) p.text = s;
            }
        }
        // (SMSMakeTextBuffer: st_1..st_9, st_a.. a 22-byte buffer each)
        // the 2D camera (TOrthoProj -1, 1, 16, 464, 0, 600) and "Screen 2D": the HUD's 600 x 480 layout
        this.unk40.show();
        return 0;
    }
    private box(i: number) { return this.unk3C.search(i < 9 ? (tagOf('st_1') + i) >>> 0 : (tagOf('st_a') + i - 9) >>> 0); }
    private put(tag: string, s: string) { const p = this.unk3C.search(tagOf(tag)); if (p) p.text = snprintf(22, s); }
    /** direct: one frame with the pad; the application state to go to (APP_STATE) */
    direct(p: PadStatus | null) {
        if (!this.unk50) {
            this.host.fadeIn?.(0.25);
            if (this.host.flags && !this.host.flags.getBool(MSF.MSOUND_WAVE_LOADED)) this.host.flags.setBool(true, MSF.MSOUND_WAVE_LOADED);
            this.unk50 = true;
        }
        let uVar13 = APP_STATE.DEFAULT;
        // JDrama::TDirector::direct: the pad, then the view objects' movement
        this.unk2C.tick(p, true);
        for (const o of this.group2d) o.testPerform(CUE_MOVE);
        const sel = this.unk40.mSelectedIndex;
        switch (this.unk18) {
        case 0:
            if (this.unk40.checkFlag(MENU_PLANE_FLAG.CONFIRMED)) {
                const F = this.host.flags;
                if (!(this.unk2C.pad.mButton.mButton & PAD.X) && F) {
                    F.firstStart();
                    for (let i = 0; i < 30; ++i) F.setShineFlag(i);
                    for (let i = MSF.NOZZLE_BASE; i < MSF.CARD_BOOL_END; ++i) F.setBool(true, i);
                    (F as any).saveSuccess?.();
                }
                this.unk40.fade();
                this.unk38.text = this.unk40.mItems[sel].text;
                if (sel === 6) {
                    for (let i = 0; i < 10; ++i) {
                        const b = this.unk3C.search(i === 9 ? tagOf('st_a') : (tagOf('st_1') + i) >>> 0);
                        if (b) b.text = snprintf(22, i < 6 ? `ビーチ ${i}` : `ホテル ${i - 6}`);
                    }
                    this.put('st_f', 'ビーチ 6'); this.put('st_g', 'ビーチ 7'); this.put('st_h', 'ホテル 4');
                    this.put('st_i', 'カジノ 0'); this.put('st_j', 'カジノ 1'); this.put('st_k', 'ボス');
                } else if (sel === 5) {
                    for (let i = 0; i < 10; ++i) {
                        const b = this.unk3C.search(i === 9 ? tagOf('st_a') : (tagOf('st_1') + i) >>> 0);
                        if (b) b.text = snprintf(22, i < 4 ? `ビーチサイド ${i}` : `ピンナパーコ ${i - 4}`);
                    }
                    this.put('st_b', 'ピンナパーコ 6'); this.put('st_c', 'ピンナパーコ 7'); this.put('st_d', 'ビーチサイド 4');
                    this.put('st_h', 'ボス 0'); this.put('st_i', 'ボス 1'); this.put('st_j', 'デモ 0'); this.put('st_k', 'デモ 1');
                } else if (sel === 8) {
                    for (let i = 0; i < 10; ++i) {
                        const b = this.unk3C.search(i === 9 ? tagOf('st_a') : (tagOf('st_1') + i) >>> 0);
                        if (!b) continue;
                        if (i < 8) b.text = snprintf(22, `マーレ ${i}`);
                        if (i === 8) b.text = snprintf(22, 'カイテイ');
                        if (i === 9) b.text = snprintf(22, 'ボス');
                    }
                } else if (sel === 0x11 || sel === 0x12) {
                    for (let i = 0; i < 20; ++i) {
                        const b = this.box(i);
                        let movie = i;
                        if (sel === 0x12) movie += 20;
                        const name = movie < 20 ? MOVIES[movie] : null;
                        if (!b) continue;
                        if (name) {
                            let s = snprintf(22, name);
                            const dot = s.lastIndexOf('.');
                            if (dot >= 0) s = s.slice(0, dot);
                            b.text = s;
                        } else b.text = snprintf(22, `${d2(movie)} not found`);
                    }
                } else {
                    for (let i = 0; i < 20; ++i) {
                        const b = this.box(i);
                        if (b) b.text = snprintf(22, i < 10 ? `${d2(i)} シーン ${i}` : `${d2(i)} EX ${i - 10}`);
                    }
                }
                this.unk38.show();
                this.unk44.show();
                this.unk18 = 1;
            }
            break;
        case 1:
            if (this.unk44.checkFlag(MENU_PLANE_FLAG.CONFIRMED)) {
                this.setFixedStageValue();
                this.unk18 = 2;
                this.startFadeout(0.25);
                this.host.setNextArea?.(this.unk48 & 0xFF, this.unk4C & 0xFF);
            } else if (this.unk44.checkFlag(MENU_PLANE_FLAG.CANCELLED)) {
                this.unk18 = 0;
                this.unk40.unfade();
                this.unk38.hide();
                this.unk44.hide();
            }
            break;
        case 2:
            // (and the default wave on ARAM: checkWaveOnAram)
            if (this.fullyFadedOut()) uVar13 = sel === 0x11 || sel === 0x12 ? APP_STATE.MOVIE : APP_STATE.GAMEPLAY;
            break;
        case 3:
            if (this.fullyFadedOut()) uVar13 = APP_STATE.QUIT;
            break;
        }
        if (this.fadeDir) this.fadeT = Math.min(1, this.fadeT + 1 / (0.25 * 60));
        return uVar13;
    }
    private startFadeout(t: number) { if (this.host.fadeOut) this.host.fadeOut(t); this.fadeDir = 1; this.fadeT = 0; }
    private fullyFadedOut() { return this.host.fadedOut ? this.host.fadedOut() : this.fadeT >= 1; }
    setFixedStageValue() {
        this.unk48 = this.unk40.mSelectedIndex;
        this.unk4C = this.unk44.mSelectedIndex;
        const local_30 = [0, 0x14, 0x1c, 0x1e, 0x20, 0x22, 0x28, 0, 0x2a, 0x2c, 0x2e];
        const ex = () => { this.unk48 = this.unk4C - 10 + local_30[this.unk48]; this.unk4C = 0; };
        const set = (a: number, b: number) => { this.unk48 = a; this.unk4C = b; };
        const s = this.unk4C;
        if (this.unk48 === 0x11 || this.unk48 === 0x12) {
            let movie = s;
            if (this.unk48 === 0x12) movie += 0x14;
            this.movie = movie; this.host.setMovie?.(movie);
            set(0xf, 0);
            return;
        }
        if (this.unk48 >= 7) this.unk48 += 1;
        switch (this.unk48) {
        case 3: if (s === 0x13) set(0x3b, 0); else if (s >= 10) ex(); break;
        case 9: if (s >= 10) ex(); else if (s === 8) set(0x10, 0); else if (s === 9) set(0x39, 0); break;
        case 6:
            if (s >= 0x13) set(0x38, 0);
            else if (s >= 0x11) set(0xe, s - 0x11);
            else if (s >= 0x10) set(7, 4);
            else if (s >= 0xe) set(6, s - 8);
            else if (s >= 10) ex();
            else if (s >= 6) set(7, s - 6);
            break;
        case 5:
            if (s === 0x12) set(0xd, 9);
            else if (s === 0x13) set(0xd, 10);
            else if (s >= 4 && s <= 0xb) set(0xd, s - 4);
            else if (s === 0xc) set(5, 4);
            else if (s === 0x11) set(0x3a, 1);
            else if (s === 0x10) set(0x3a, 0);
            else if (s >= 10) ex();
            break;
        case 10: if (s >= 10) ex(); else if (s === 7) set(0x3c, 0); break;
        case 2: if (s >= 10) ex(); else if (s === 8) set(0x37, 0); break;
        case 0: break;
        default: if (s >= 10) ex(); break;
        }
    }
    /** the Group 2D's CUE_DRAW: the screen (TMenuBase) */
    draw(cx: CanvasRenderingContext2D, P: Painter, base: M) {
        for (const o of this.group2d) if (o instanceof MenuBase) o.draw(cx, P, base);
        if (this.fadeDir && this.fadeT > 0 && !this.host.fadeOut) {
            cx.save(); cx.setTransform(1, 0, 0, 1, 0, 0); cx.globalAlpha = this.fadeT; cx.fillStyle = '#000';
            cx.fillRect(0, 0, cx.canvas.width, cx.canvas.height); cx.restore();
        }
    }
}

// ---------------------------------------------------------------- THelpActor / TSwitchHelpActor
const HELP_BASE = V.GMSJ01 ? 0xE0030 : V.GMSJ01_01 ? 0xE0033 : 0x33;
export class HelpActor extends HitActor {
    unk68 = -1; unk6C: string | null = null; unk70: LiveActor | null = null; unk74 = false;
    constructor(public world: World, name: string) { super(name); }
    load(s: Stream) {
        super.load(s);
        s.u32();
        const local_10 = s.u32();
        this.unk6C = s.str();
        this.initHitActor(AT.HELP_ACTOR, 1, HC.PLAYER, Math.fround(this.scale.x * 100), Math.fround(this.scale.y * 100), 1, 1);
        this.unk68 = (local_10 + HELP_BASE) | 0;
    }
    loadAfter() {
        super.loadAfter();
        this.unk70 = (this.unk6C ? this.world.search(this.unk6C) : null) as LiveActor | null;
        // (the GCコンソール's entryHelpActor)
        const w = this.world as any; (w.helpActors = w.helpActors || []).push(this);
    }
    check() { return this.unk70!.checkLiveFlag(LF.DEAD); }
    getHelpID() {
        if (this.unk70 && this.check()) return -1;
        if (this.collisions.length !== 0 && this.collisions[0].isActorType(AT.MARIO)) return this.unk68;
        return -1;
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        if (this.unk74) {
            if (this.getHelpID() === -1) { this.world.effect('balloonOff:' + (this.unk68 >>> 0).toString(16), this.pos); this.unk74 = false; }
        } else if (this.getHelpID() !== -1) { this.world.effect('balloon:' + (this.unk68 >>> 0).toString(16), this.pos); this.unk74 = true; }
    }
}
export class SwitchHelpActor extends HelpActor {
    check() { return (this.unk70 as any).isState(3) ? true : false; }
}
register('BalloonHelp', (w, n) => new HelpActor(w, n));
register('SwitchHelp', (w, n) => new SwitchHelpActor(w, n));

// ---------------------------------------------------------------- TMapObjOptionWall
export class MapObjOptionWall extends HitActor {
    unk68: ObjCollision | null = null;
    constructor(public world: World, name: string) { super(name); }
    init() {
        this.unk68 = new ObjCollision(this.world, KIND_WARP, null);
        this.unk68.init('/map/map/option_wall.col', 0);   // ("/scene/map/map/option_wall.col")
    }
    onCollision() { this.unk68!.setUp(); }
    offCollision() { this.unk68!.remove(); }
}
