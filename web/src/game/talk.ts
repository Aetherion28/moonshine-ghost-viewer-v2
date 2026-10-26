// Talking: TMarDirector's talk mode (System/MarDirectorEvent.cpp movement_game, findNearestTalkNPC,
// findNearestTakeNPC; System/MarDirectorDirect.cpp updateGameMode: unk124 / unk126 / unk128, unkA0)
// and the message window TTalk2D2 ("会話表示", GC2D/Talk2D2.cpp) with its messages
// (GC2D/MessageLoader.cpp: /scene/map/message.bmg and /common/2d/sys_message.bmg).
//
// The talk as the game runs it, a movement tick at a time:
// - movement_game (after PerformList Movement and the console's list, in the game state): with
//   Mario waiting (MARIO_STATUS_WAIT), not holding, no L camera or demo camera, and no NPC he could
//   take, the nearest NPC that wants to talk (its LIVE_FLAG_UNK20000, set by its changeNerveProc when
//   isTalkable_, and not UNK100000) is unkA0; the pad gets PAD_FLAG_TALK_NPC (B means
//   MEANING_TALK_B), and when there was one the tick before too (unk128 bit 2) a TALK_B press asks
//   for the talk (unk126 1);
// - updateGameMode (changeState, at the tick's end): 0 to 1: the NPC gets LIVE_FLAG_UNK40000 (its
//   next changeNerveProc pushes TNerveNPCTalk), the pad PAD_FLAG_TALK_SELECT (the select meanings
//   only: Mario gets no stick or buttons), the stopwatch stops; 1 to 2 (Mario has turned to the
//   NPC: TMario::readBillboard sets unk126 2): openTalkWindow; 2 to 0 once the window is closed
//   (unk248 0): unkA0 cleared, TALK_SELECT off, the stopwatch on;
// - isTalkModeNow (unk124 1 or 2): world.talkMode, which the objects read (most stand still),
//   and the scripts (isTalkModeNow / getTalkNPCName / setTalkMsgID / getTalkMode);
// - TTalk2D2::perform (Group 2D, PerformList Console: CUE_MOVE every tick, CUE_CALC_ANIM on the
//   frame's last) while unk124 is 2: 2 waits for the talk camera (CPolarSubCamera::isThing: a
//   talk mode, no longer in between), 3 counts 20 down on CALC_ANIM (21 frames), 4 shows the lines
//   (openNormalWindow: each line's sweep unk234 from 1 + its index down 0.04 a tick, a line
//   starting when its sweep is under 1 and the line before has shown its last character; a
//   character appears at alpha 0 and gains unk340 (0x40: four ticks a character, 0x80 while A is
//   held: unk26C) a tick, the next one shown at once, after the wait the message's 1A 06 00 0000 nn
//   tag gives (unk281, skipped while A is held)), 5 (all sweeps done) keeps showing them (one step
//   a tick: five ticks a character) and once the last line is out shows the next-arrow (or the
//   yes/no box), after which a SELECT_A / SELECT_B edge (A or B pressed that frame) closes the
//   window (the last page: 6) or erases it for the next page (7: unk90's alpha down 16 a call, on
//   CUE_MOVE and on CUE_CALC_ANIM: 16 calls), 6 fades it out (16 ticks) to 0 (the talk's end) or,
//   for a message set with flag bit 1 clear, to 1 (the window closed, the talk going on: the
//   script's next setTalkMsgID opens it again at 3). The board (TBaseNPC NPC_BOARD) has its own
//   window: TBoundPane moves (60 then 25 ticks in, 60 out) and a 4-a-tick fade, no text timing.
//
// What is left out: the presentation (the 2D panes' drawing, the sounds, the talk cursor, the
// telop / balloon / Mario icon of the console), makeBoxLine's cut of a line wider than its curve
// (the messages fit), the pause / guide / card save / stage transition / game over states
// updateGameMode asks of the director (nextState), the demo's jingle (MSBgm::getHandle(2)), and
// the jump of a talk started outside the game state.
//
// The camera demos: fireStartDemoCamera (the scripts', the Shine get) queues a TDemoInfo and sets
// DIRECTOR_FLAG_DEMO_PENDING; updateGameMode then goes to the demo mode (unk124 3, or 4 from a talk): the
// pad gets PAD_FLAG_NO_INPUT (Mario waits in T_WAIT), the camera starts the demo (a bck's
// (duration + 1) * 2 ticks), and when the camera's rest frames run out the mode returns to 0 (2 from 4).

import { fr, V3 } from './math.js';
import { World, NameRef, LF, CUE_MOVE, CUE_CALC_ANIM } from './engine.js';
import { AT } from './actortypes.js';
import { cameraBck } from './camera/bck.js';

/** MARIO_STATUS_WAIT, MARIO_STATUS_READ_BILLBOARD */
const MARIO_STATUS_WAIT = 0x0C400201;
/** TMarioGamePad flags and meanings (player/pad.ts PAD_FLAG / MEANING) */
const PAD_FLAG_TALK_NPC = 0x4, PAD_FLAG_TALK_SELECT = 0x8, PAD_FLAG_NO_INPUT = 0x10;
/** MARIO_FLAG_GAME_OVER */
const MF_GAME_OVER = 0x400;
/** MSF_GOT_SHINE_IN_PREV_STAGE (msflags.ts) */
const MSF_GOT_SHINE_IN_PREV_STAGE = 0x30006;
/** TMarDirector's DIRECTOR_FLAG_* (as far as updateGameMode reads them) */
const DF = {
    SHINE_GET_PENDING: 0x1, STAGE_TRANSITION_PENDING: 0x2, GAME_OVER_PENDING: 0x20, DEMO_PENDING: 0x40, END_DEMO_PENDING: 0x80,
    CARD_SAVE_PENDING: 0x200, SHINE_TAKEN: 0x8000,
};
/** MSBgm::getHandle(2) (the demo's jingle track): the BGM isn't simulated, taken as not playing */
const BGM_HANDLE2_PLAYING = false;
/** a TDemoInfo of mDemoQueue (fireStartDemoCamera's arguments) */
interface DemoInfo { name: string | null; offset: V3 | null; frames: number; angle: number; timed: boolean; actor: NameRef | null; }
const MEANING_TALK_B = 0x800, MEANING_SELECT_A = 0x20000, MEANING_SELECT_B = 0x40000, MEANING_SELECT_UP = 0x80000, MEANING_SELECT_DOWN = 0x100000;
/** CPolarSubCamera modes (camera/polar.ts CM) */
const CM_TALK_A = 0xC, CM_TALK_B = 0x2D, CM_TALK_C = 0x3F, CM_TALK_D = 0x40, CM_TALK_E = 0xA;
/** MSF_LANGUAGE (msflags.ts LANGUAGE) and the flags the window's tags print */
const MSF_LANGUAGE = 0xA0001;

// ---------------------------------------------------------------- TMessageLoader
/** JMSMesgEntry: the message's offset in DAT1, and its sound (unk8[0]) */
export interface MesgEntry { off: number; unk4: number; unk6: number; sound: number; }
/** TMessageLoader: a BMG's INF1 entries (12 bytes each, at most 255) and its DAT1 */
export class MessageLoader {
    entries: MesgEntry[] = [];
    data: Uint8Array | null = null;
    unk2 = 0;
    constructor(bmg: Uint8Array | null) {
        if (!bmg || bmg.length < 0x20) return;
        const dv = new DataView(bmg.buffer, bmg.byteOffset, bmg.byteLength);
        const blocks = dv.getUint32(12);
        let p = 0x20;
        for (let i = 0; i < blocks && p + 8 <= bmg.length; i++) {
            const tag = String.fromCharCode(bmg[p], bmg[p + 1], bmg[p + 2], bmg[p + 3]);
            const size = dv.getUint32(p + 4);
            if (tag === 'INF1') {
                const n = dv.getUint16(p + 8);
                this.unk2 = dv.getUint16(p + 12);
                for (let k = 0; k < n && k < 255; k++) {
                    const e = p + 16 + k * 12;
                    this.entries.push({ off: dv.getUint32(e), unk4: dv.getInt16(e + 4), unk6: dv.getInt16(e + 6), sound: bmg[e + 8] });
                }
            } else if (tag === 'DAT1') this.data = bmg.subarray(p + 8, p + size);
            p += size;
        }
    }
    getMessageEntry(id: number) { id &= 0xFFFF; return id >= this.entries.length ? null : this.entries[id]; }
}

// ---------------------------------------------------------------- TTalk2D2's panes (what their timing reads)
class Pane { visible = false; alpha = 255; show() { this.visible = true; } hide() { this.visible = false; } }
/** TBoundPane: a move along a quadratic curve, step 1 / frames a call (only its end counts here) */
class BoundPane {
    unk24 = false; unk28 = 0; unk2C = 0;
    setPanePosition(frames: number) { this.unk28 = 0; this.unk2C = fr(1 / frames); this.unk24 = true; }
    update() {
        if (this.unk24) {
            if (this.unk28 > 1) { this.unk28 = 1; this.unk24 = false; }
            this.unk28 = fr(this.unk28 + this.unk2C);
        }
        return !this.unk24;
    }
}

/** a character's text box (unk9C[line * 30 + i]): only its visibility, alpha and whether it holds text */
class CharBox extends Pane { code = 0; }

// ---------------------------------------------------------------- TTalk2D2
export class Talk2D {
    /** unk28: the board's window (the talking NPC is a TNPCBoard) */
    unk28 = 0; unk29 = 0;
    unk9C: CharBox[] = [];
    /** unk90 (me_0: the window), unk3C (bac1..3), unk6C (cu_1..3: the next arrows), unk78 / unk84, unk204 (me_4: yes / no), unk20C (sc_1, sc_2) */
    unk90 = new Pane(); unk3C = [new Pane(), new Pane(), new Pane()]; unk6C = [new Pane(), new Pane(), new Pane()];
    unk78 = [new Pane(), new Pane(), new Pane()]; unk84 = [new Pane(), new Pane(), new Pane()];
    unk204 = new Pane(); unk20C = [new Pane(), new Pane()];
    /** the board: unk14 (mb_0), unk18 (its text), unk1C / unk20 / unk24 (cu_1, cc_1, cs_1) */
    unk14 = new BoundPane(); unk18 = new Pane(); unk1C = new Pane(); unk20 = new Pane(); unk24 = new Pane();
    unk214 = -1;
    unk218: string[] = ['', ''];
    unk224 = [0, 0, 0];
    unk228 = [0, 0, 0];
    unk234 = [1, 2, 3];
    /** unk248: the window's state (getTalkMode) */
    unk248 = 0;
    unk250 = 1; unk251 = 0; unk252 = 0;
    unk254: MesgEntry | null = null;
    unk258: MessageLoader; unk25C: MessageLoader; unk260: MessageLoader;
    unk264 = 3;
    unk26A = 0; unk26B = 0; unk26C = 0; unk26D = 0;
    unk270 = 1; unk274 = 0; unk278 = 0; unk27C = -1; unk280 = 0;
    /** unk281: each character's wait before the next (u8[0x5B]) */
    unk281 = new Uint8Array(0x5B);
    unk2DC = 0; unk2DE = 0;
    /** unk2E0: the NPCs with their own happy message (空港沈みモンテ 0x26, モンテ1 0x23) */
    unk2E0: { npc: NameRef | null; id: number }[] = [];
    unk338 = fr(0.04); unk33C = 1; unk340 = 0x64;
    /** a log of the talk for the viewer and the checks: [tick, what] */
    log: [number, string][] = [];

    constructor(public world: World, stageBmg: Uint8Array | null, sysBmg: Uint8Array | null, public dir: TalkDirector) {
        for (let i = 0; i < 90; i++) { const c = new CharBox(); c.hide(); this.unk9C.push(c); }
        this.unk258 = new MessageLoader(stageBmg);
        this.unk25C = new MessageLoader(sysBmg);
        this.unk260 = this.unk25C;
        this.unk204.hide();
        for (const p of this.unk6C) p.hide();
        // loadAfter: the window's first text (sys_message 3)
        const e = this.unk25C.getMessageEntry(3);
        if (e) this.setupTextBox(this.unk25C, e);
        this.unk260 = this.unk25C;
        const names = ['空港沈みモンテ', 'モンテ1'], ids = [0x26, 0x23];
        for (let i = 0; i < 10; i++) this.unk2E0.push({ npc: names[i] ? world.search(names[i]) : null, id: ids[i] ?? 0 });
    }
    private get pad() { return this.dir.pad(); }
    private lang() { return this.world.flags.getFlag(MSF_LANGUAGE); }
    private camera(): any { return this.dir.camera(); }

    getTalkMode() { return this.unk248 >>> 0; }
    /** getSelectedValue (evGetTalkSelectedValue: Fast text makes it 0, the first answer) */
    getSelectedValue() { return this.dir.fastText ? 0 : this.unk214; }

    /** setMessageID (the scripts' setTalkMsgID) */
    setMessageID(id: number, flags: number) {
        const npc: any = this.dir.unkA0;
        id >>>= 0;
        if (npc && typeof npc.checkActionFlag === 'function' && npc.checkActionFlag(0x200 /* NPC_ACTION_HAPPY */)) {
            const child = npc.isChild();
            if (npc.isMonte()) this.unk264 = npc.isMonteW() ? (child ? 0x2C : 0x27) : (child ? 0x29 : 0x23);
            else if (npc.isMare()) this.unk264 = npc.isMareW() ? (child ? 0x2D : 0x28) : (child ? 0x2A : 0x24);
            else if (npc.actorType === AT.NPC_KINOPIO) this.unk264 = 0x25;
            else if (npc.actorType === AT.NPC_MARE_MB) this.unk264 = 0x2B;
            for (const e of this.unk2E0) if (e.npc === npc) { this.unk264 = e.id; break; }
        } else this.unk264 = id;
        this.unk28 = npc && npc.actorType === AT.NPC_BOARD ? 1 : 0;
        this.unk270 = flags >>> 0;
        this.unk278 = 0; this.unk214 = -1; this.unk26A = 0; this.unk27C = -1; this.unk280 = 0; this.unk26C = 0; this.unk26D = 0;
        this.unk254 = null; this.unk29 = 0;
        this.unk340 = this.lang() === 0x100 ? 0x20 : 0x40;
        let loader = (this.unk264 & 0xFFFF0000) === 0 ? this.unk25C : this.unk258;
        if (this.dir.fastText) {
            // Moonshine's Fast text: the message data read as null (the missing-file fallback, sys
            // message 3), its text replaced at that setupTextBox call by "！！！"
            this.unk264 = 3; loader = this.unk25C;
            const e = loader.getMessageEntry(3);
            if (e) this.setupTextBox(loader, e, FAST_TEXT_JP);
        } else if (loader.data) {
            let e = loader.getMessageEntry(this.unk264);
            if (!e) { this.unk264 = 4; loader = this.unk25C; e = loader.getMessageEntry(4); }
            if (e) this.setupTextBox(loader, e);
        } else {
            this.unk264 = 3; loader = this.unk25C;
            const e = loader.getMessageEntry(3);
            if (e) this.setupTextBox(loader, e);
        }
        this.unk260 = loader;
        this.unk2DC = 0;
        if (this.unk248 === 1) { this.unk248 = 3; this.unk90.alpha = 0xFF; }
        this.unk252 = 1;
        this.log.push([this.world.tickCount, `message ${(this.unk264 >>> 0).toString(16)} flags ${flags}${npc ? ' ' + npc.name : ''}`]);
    }
    /** forceCloseTalk */
    forceCloseTalk() {
        this.prevTalkCamera();
        this.unk248 = this.unk248 === 1 ? 0 : 6;
    }
    /** closeTalkWindow */
    closeTalkWindow() {
        if (this.unk270 & 1) { this.prevTalkCamera(); this.unk252 = 0; }
        this.unk248 = 6;
    }
    /** gpCamera->makeMtxForPrevTalk (with its npcTalkOut on every NPC) */
    private prevTalkCamera() {
        const C = this.camera();
        if (!C || typeof C.makeMtxForPrevTalk !== 'function') { for (const n of this.dir.npcs) (n as any).npcTalkOut(); return; }
        const was = C.isTalkCameraSpecifyMode ? C.isTalkCameraSpecifyMode(C.mMode) : isTalkMode(C.mMode);
        C.makeMtxForPrevTalk();
        if (was) for (const n of this.dir.npcs) (n as any).npcTalkOut();
    }
    /** openTalkWindow */
    openTalkWindow(npc: NameRef | null) {
        if (npc) {
            const C = this.camera();
            if (C && typeof C.makeMtxForTalk === 'function') C.makeMtxForTalk(talkCameraMode(npc));
        }
        if (this.unk28 !== 0) { this.unk14.setPanePosition(60); this.unk14.update(); this.unk1C.alpha = 0; this.unk248 = 4; }
        else this.unk248 = 2;
        this.unk90.alpha = 0xFF;
        this.unk250 = 1;
        this.log.push([this.world.tickCount, 'open']);
    }
    private openBoardWindow() {
        let r = false;
        switch (this.unk29) {
            case 0: if (this.unk14.update()) { this.unk14.setPanePosition(0x19); this.unk29++; } break;
            case 1: if (this.unk14.update()) { this.unk1C.alpha = 0; r = true; this.unk1C.show(); this.unk29++; } break;
        }
        return r;
    }
    private openNormalWindow() {
        let r = false;
        const P = this.pad;
        if (this.unk2DE > 2 && P && P.checkMeaning(MEANING_SELECT_A)) { this.unk26C = 1; this.unk340 = this.lang() === 0x100 ? 0x5A : 0x80; }
        let finished = true;
        for (let i = 0; i <= this.unk274; i++) {
            if (this.unk234[i] > fr(-0.109)) { finished = false; this.unk234[i] = fr(this.unk234[i] - this.unk338); }
            if (this.unk234[i] < 1 && i !== 0 && !this.unk9C[this.unk228[i - 1] + (i - 1) * 30].visible) this.unk234[i] = 1;
            if (this.unk224[i] === 0 && this.unk234[i] < this.unk33C) { this.unk224[i] = 1; this.unk9C[i * 30].show(); }
        }
        if (finished) { for (let i = 0; i <= this.unk274; i++) this.unk3C[i].show(); r = true; }
        for (let line = 0; line < 3; line++) {
            if (this.unk224[line] === 0) continue;
            let idx = this.unk224[line] + line * 30;
            while (this.unk224[line] <= this.unk228[line]) {
                const c = this.unk9C[idx];
                if (c.visible) {
                    // (Fast text: the increment loaded as 0x5000, a character a tick)
                    const a = (c.alpha + (this.dir.fastText ? 0x5000 : this.unk340)) << 16 >> 16;
                    c.alpha = a > 255 ? 255 : a & 0xFF;
                    this.unk2DE = idx & 0xFFFF;
                    if (a < 255) break;
                    this.unk224[line] = (this.unk224[line] + 1) & 0xFF;
                    idx++;
                } else {
                    if (this.unk2DC <= 0) { this.unk2DC = this.unk26C !== 0 ? 0 : this.unk281[idx]; c.show(); c.alpha = 0; }
                    else this.unk2DC = (this.unk2DC - 1) << 16 >> 16;
                    break;
                }
            }
        }
        return r;
    }
    private moveBoardWindow() {
        let a = this.unk1C.alpha;
        if (a < 0xFF) {
            a += 4;
            if (a > 0xFF) { this.unk24.alpha = 0; this.unk20.alpha = 0; this.unk26B = 1; a = 0xFF; }
            this.unk1C.alpha = a;
            return;
        }
        const p = this.unk26A !== 0 ? this.unk24 : this.unk20;
        a = p.alpha;
        if (this.unk26B !== 0) { a += 4; if (a > 0xFF) { this.unk26B = 0; a = 0xFF; } }
        else { a -= 4; if (a < 0) { this.unk26B = 1; a = 0; } }
        p.alpha = a;
    }
    private checkBoardControler() {
        const P = this.pad;
        if (!P) return;
        if (this.unk26A !== 0) {
            if (this.unk26D !== 0 || P.checkFrameMeaning(MEANING_SELECT_A) || P.checkFrameMeaning(MEANING_SELECT_B)) {
                this.unk14.setPanePosition(60);
                this.closeTalkWindow();
            }
        } else if (P.checkFrameMeaning(MEANING_SELECT_A | MEANING_SELECT_B)) this.unk248 = 7;
    }
    private moveTalkWindow() {
        for (let line = 0; line < 3; line++) {
            const idx = this.unk224[line] + line * 30;
            if (this.unk224[line] !== 0 && this.unk224[line] <= this.unk228[line]) {
                const c = this.unk9C[idx];
                if (c.visible) {
                    const a = (c.alpha + this.unk340) << 16 >> 16;
                    c.alpha = a > 255 ? 255 : a & 0xFF;
                    if (a >= 255) this.unk224[line] = (this.unk224[line] + 1) & 0xFF;
                } else if (this.unk2DC <= 0) { this.unk2DC = this.unk281[idx]; c.show(); c.alpha = 0; }
                else this.unk2DC = (this.unk2DC - 1) << 16 >> 16;
            }
        }
        const L = this.unk274;
        if (this.unk224[L] < 30 && this.unk224[L] <= this.unk228[L]) return;
        let pane: Pane, fade: Pane;
        if (this.unk214 === -1) {
            pane = this.unk6C[L];
            if (this.unk26A !== 0) { fade = this.unk84[L]; this.unk78[L].hide(); this.unk84[L].show(); }
            else { fade = this.unk78[L]; this.unk78[L].show(); this.unk84[L].hide(); }
        } else { pane = this.unk204; fade = this.unk20C[this.unk214]; }
        if (pane.visible) {
            if (pane.alpha < 255) pane.alpha = Math.min(255, pane.alpha + 0x10);
            let f = fade.alpha;
            if (this.unk26B !== 0) { f += 2; if (f > 255) { this.unk26B = 0; f = 255; } }
            else { f -= 4; if (f < 60) { this.unk26B = 1; f = 60; } }
            fade.alpha = f;
        } else { pane.show(); pane.alpha = 0; fade.alpha = 255; }
    }
    private checkControler() {
        const P = this.pad;
        if (!P) return;
        const L = this.unk274;
        if (this.unk6C[L].visible) {
            if (this.unk26A !== 0) {
                if (this.unk26D !== 0 || P.checkFrameMeaning(MEANING_SELECT_A) || P.checkFrameMeaning(MEANING_SELECT_B)) { this.log.push([this.world.tickCount, 'close']); this.closeTalkWindow(); }
            } else if (P.checkFrameMeaning(MEANING_SELECT_A | MEANING_SELECT_B)) { this.log.push([this.world.tickCount, 'next']); this.unk248 = 7; }
        } else if (this.unk204.visible) {
            if (P.checkFrameMeaning(MEANING_SELECT_UP) && this.unk214 === 1) {
                this.unk214 = 0; this.unk20C[1].alpha = 0xFE; this.unk20C[1].hide(); this.unk20C[0].show();
            } else if (P.checkFrameMeaning(MEANING_SELECT_DOWN) && this.unk214 === 0) {
                this.unk214 = 1; this.unk20C[0].alpha = 0xFE; this.unk20C[0].hide(); this.unk20C[1].show();
            } else if (this.unk26A !== 0) {
                if (P.checkFrameMeaning(MEANING_SELECT_A | MEANING_SELECT_B)) {
                    if (this.unk270 & 1) this.prevTalkCamera();
                    this.log.push([this.world.tickCount, `select ${this.unk214}`]);
                    this.unk248 = 6;
                }
            } else if (P.checkFrameMeaning(MEANING_SELECT_A | MEANING_SELECT_B)) { this.log.push([this.world.tickCount, `select-next ${this.unk214}`]); this.unk248 = 7; }
        }
    }
    private resetLines() {
        for (let i = 0; i < 3; i++) { this.unk234[i] = i + 1; this.unk3C[i].hide(); this.unk224[i] = 0; this.unk6C[i].hide(); }
        for (const c of this.unk9C) c.hide();
    }
    private closeNormalWindow() {
        let a = this.unk90.alpha - 0x10, r = false;
        if (a < 0) { a = 0; this.resetLines(); if (this.unk204.visible) this.unk204.hide(); r = true; }
        this.unk90.alpha = a;
        if (this.unk204.visible) this.unk204.alpha = a;
        return r;
    }
    private closeBoardWindow() { return this.unk14.update(); }
    private eraseNormalWindow() {
        let a = this.unk90.alpha - 0x10, r = false;
        if (a < 0) {
            a = 0xFF;
            this.resetLines();
            const e = this.unk260.getMessageEntry(this.unk264);
            if (e) this.setupTextBox(this.unk260, e);
            this.unk26C = 0;
            this.unk340 = this.lang() === 0x100 ? 0x20 : 0x40;
            this.unk27C = -1; this.unk2DE = 0; this.unk2DC = 0;
            r = true;
        }
        this.unk90.alpha = a;
        return r;
    }
    private eraseBoardWindow() {
        let a = this.unk18.alpha - 4, r = false;
        if (a < 0) {
            a = 0;
            const e = this.unk260.getMessageEntry(this.unk264);
            if (e) this.setupTextBox(this.unk260, e);
            this.unk27C = -1; this.unk2DE = 0; this.unk2DC = 0;
            r = true;
        }
        this.unk18.alpha = a;
        return r;
    }
    private appearBoardBoxWindow() {
        let a = (this.unk18.alpha + 4) & 0xFFFF, r = false;
        if (a > 255) { a = 255; r = true; }
        this.unk18.alpha = a;
        return r;
    }

    /** perform (Group 2D in PerformList Console: CUE_MOVE every tick, CUE_CALC_ANIM on the frame's last) */
    perform(move: boolean, calcAnim: boolean) {
        const mode = this.dir.unk124;
        if (move && mode === 2) {
            switch (this.unk248) {
                case 2: { const C = this.camera(); if (!C || cameraIsThing(C)) { this.unk251 = 0x14; this.unk248 = 3; } break; }
                case 4: if (this.unk28 !== 0 ? this.openBoardWindow() : this.openNormalWindow()) this.unk248 = 5; break;
                case 5: if (this.unk28 !== 0) { this.moveBoardWindow(); this.checkBoardControler(); } else { this.moveTalkWindow(); this.checkControler(); } break;
                case 6: if (this.unk28 !== 0 ? this.closeBoardWindow() : this.closeNormalWindow()) { this.unk248 = (this.unk270 & 1) ? 0 : 1; this.log.push([this.world.tickCount, `closed ${this.unk248}`]); } break;
                case 7: if (this.unk28 !== 0 ? this.eraseBoardWindow() : this.eraseNormalWindow()) this.unk248 = this.unk28 !== 0 ? 8 : 4; break;
                case 8: if (this.appearBoardBoxWindow()) this.unk248 = 5; break;
            }
        }
        if (calcAnim && this.dir.unk124 === 2) {
            switch (this.unk248) {
                case 3: this.unk251 = (this.unk251 - 1) & 0xFF; if ((this.unk251 << 24 >> 24) < 0) { this.unk2DE = 0; this.unk248 = 4; } break;
                // (the normal window's erase, the board's too: the game's)
                case 7: if (this.eraseNormalWindow()) { this.unk27C = -1; this.unk248 = 4; } break;
            }
        }
    }

    // ------------------------------------------------------------ the text (setupTextBox, setTagParam)
    /** setupTextBox (text: Fast text's replacement, read from its start instead of the entry's offset) */
    private setupTextBox(loader: MessageLoader, entry: MesgEntry, text: Uint8Array | null = null) {
        if (this.unk28 !== 0) { this.setupBoardTextBox(loader, entry, text); return; }
        const d = text || loader.data!;
        const base = (text ? 0 : entry.off) + this.unk278;
        let pos = 0;
        const rd = () => (base + pos < d.length ? d[base + pos++] : (pos++, 0));
        this.unk254 = entry;
        const ctx = { charIdx: 0, lineIdx: 0 };
        this.unk274 = 0; this.unk2DE = 0;
        while (ctx.lineIdx < 3) {
            const code = rd();
            if (code === 0x0A) {
                this.unk228[ctx.lineIdx] = ctx.charIdx === 0 ? 0 : ctx.charIdx - 1;
                ctx.charIdx = 0; ctx.lineIdx++;
            } else if (code === 0x00) {
                if (ctx.charIdx !== 0) { this.unk228[ctx.lineIdx] = ctx.charIdx - 1; ctx.charIdx = 0; }
                ctx.lineIdx = 3; this.unk26A = 1;
            } else if (code === 0x1A) {
                pos = this.setTagParam(d, base, pos, ctx);
            } else {
                if (this.unk274 !== ctx.lineIdx) this.unk274 = ctx.lineIdx;
                const k = ctx.charIdx + ctx.lineIdx * 30;
                const c = this.unk9C[k];
                c.code = code;
                if (code >= 0x80) rd();
                this.unk281[this.unk2DE] = this.unk280;
                this.unk2DE = k;
                ctx.charIdx++;
            }
        }
        if (this.unk26A === 0 && (base + pos >= d.length || d[base + pos] === 0)) this.unk26A = 1;
        this.unk278 += pos;
    }
    /** setTagParam: returns the stream's position after the tag */
    private setTagParam(d: Uint8Array, base: number, pos: number, ctx: { charIdx: number; lineIdx: number }) {
        const at = (i: number) => (base + i < d.length ? d[base + i] : 0);
        const size = at(pos), group = at(pos + 1), tag = (at(pos + 2) << 8) | at(pos + 3);
        pos += 4;
        const skip = () => { pos += size - 5; };
        const F = this.world.flags;
        const put = (n: number) => {
            const k = ctx.charIdx + ctx.lineIdx * 30;
            for (let i = 0; i < n; i++) this.unk9C[k + i].code = 0x30;
            ctx.charIdx += n;
        };
        switch (group) {
            case 0:
                if (tag === 0) { this.unk280 = at(pos); pos++; }
                else if (tag === 1) this.unk26D = 1;
                else skip();
                break;
            case 1:
                if (tag === 0 || tag === 1) {
                    if (this.unk214 === -1) {
                        this.unk214 = tag;
                        this.unk20C[1 - tag].alpha = 0xFE; this.unk20C[1 - tag].hide(); this.unk20C[tag].show();
                    }
                    let s = ''; for (let i = 0; i < Math.min(size - 5, 16); i++) { const ch = at(pos + i); if (!ch) break; s += String.fromCharCode(ch); }
                    this.unk218[tag] = s;
                }
                skip();
                break;
            case 2:
                if (tag === 0 || tag === 1 || tag === 6) {
                    const k = ctx.charIdx + ctx.lineIdx * 30;
                    put(8);
                    for (let i = 0; i < 8; i++) this.unk281[k + i] = this.unk280;
                } else if (tag === 2) {
                    // MSF_BOX_GAME_RECORD: (record + 99) / 100 boxes, one or two digits
                    const count = Math.trunc(fr(fr(0.01) * (F.getFlag(0x60005) + 99)));
                    put(count < 10 ? 1 : 2);
                } else if (tag === 3) {
                    // the blue coins not yet traded (MSF_BLUE_COIN_COUNT less 10 a traded Shine): one or two digits
                    let v = F.getFlag(0x40001), got = 0;
                    for (let i = 0x46; i < 0x56; i++) if (F.getFlag(0x10000 + i)) got++;
                    for (let i = 0x6C; i <= 0x73; i++) if (F.getFlag(0x10000 + i)) got++;
                    v -= got * 10;
                    put(v < 100 ? 1 : 2);
                } else if (tag === 4) {
                    const which = at(pos); pos++;
                    const name = ['フルーツかごＡ', 'フルーツかごＢ', 'フルーツかごＣ', 'フルーツかごＤ'][which];
                    if (name && this.world.search(name)) put(2);
                }
                break;
            case 0xFF:
                if (tag === 0) { this.unk27C = TALK_COLORS[at(pos)] ?? 0; pos++; }
                break;
            default: skip(); break;
        }
        return pos;
    }
    /** setupBoardTextBox: six lines a page, the tag byte alone skipped (the game's) */
    private setupBoardTextBox(loader: MessageLoader, entry: MesgEntry, text: Uint8Array | null = null) {
        const d = text || loader.data!;
        const base = (text ? 0 : entry.off) + this.unk278;
        let pos = 0;
        const rd = () => (base + pos < d.length ? d[base + pos++] : (pos++, 0));
        this.unk254 = entry;
        let line = 0;
        while (line < 6) {
            const c = rd();
            if (c === 0x0A) line++;
            else if (c === 0) { this.unk26A = 1; line = 6; }
            else if (c !== 0x1A && c >= 0x80) rd();
        }
        if (this.unk26A === 0 && (base + pos >= d.length || d[base + pos] === 0)) { this.unk26A = 1; pos++; }
        this.unk278 += pos;
    }
}
/** Moonshine's Fast text message, JP ("！！！"; US "!", PAL "!!!") */
const FAST_TEXT_JP = new Uint8Array([0x81, 0x49, 0x81, 0x49, 0x81, 0x49, 0]);
/** TTalk2D2::cColorTable */
const TALK_COLORS = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFB48CFF, 0x6EE6FFFF, 0xFFFF00FF, 0xAAFF50FF];
const isTalkMode = (m: number) => m === CM_TALK_E || m === CM_TALK_A || m === CM_TALK_B || m === CM_TALK_C || m === CM_TALK_D;
/** CPolarSubCamera::isThing: a talk mode, not in between */
function cameraIsThing(C: any) { return isTalkMode(C.mMode) && !(typeof C.isNowInbetween === 'function' && C.isNowInbetween()); }
/** makeMtxForTalk's mode by the NPC */
function talkCameraMode(npc: any) {
    switch (npc.actorType) {
        case AT.NPC_SUNFLOWER_S: return CM_TALK_C;
        case AT.NPC_SUNFLOWER_L: return CM_TALK_D;
        case AT.NPC_MONTE_MF: return CM_TALK_E;
    }
    return typeof npc.isSmallNpc === 'function' && npc.isSmallNpc() ? CM_TALK_B : CM_TALK_A;
}

// ---------------------------------------------------------------- TMarDirector's talk part
export class TalkDirector {
    /** unk124: the game mode (0 game, 1 / 2 talk, 3 / 4 demo); unk125 its last; unk126 the next asked */
    unk124 = 0; unk125 = 0; unk126 = 0;
    /** unk128: bit 1 a talk NPC near this tick, bit 2 the tick before */
    unk128 = 0;
    /** unkA0: the talking NPC (the nearest talkable one while none talks) */
    unkA0: NameRef | null = null;
    /** unk88: the NPCs (entryNPC, at their loadAfter) */
    npcs: NameRef[] = [];
    talk: Talk2D;
    /** the director's stopwatch runs (OSStart/StopStopwatch, eventwatcher's) */
    stopwatchOn = true;
    /**
     * Moonshine's Fast text (its QOL setting, Talk2D2 / EventWatcher patches: every message is
     * "！！！", shown a character a tick, getTalkSelectedValue 0). The ghosts don't record it; the
     * runs seen so far had it on (their talks close on the first A after a one-line window).
     */
    fastText = true;
    constructor(public world: World, stageBmg: Uint8Array | null, sysBmg: Uint8Array | null) {
        this.talk = new Talk2D(world, stageBmg, sysBmg, this);
    }
    /** the player (gpMarioOriginal) */
    private mario(): any { const m: any = this.world.mario; return m && m.mGamePad ? m : null; }
    pad(): any { const m = this.mario(); return m ? m.mGamePad : null; }
    /** gpCamera: the simulated CPolarSubCamera (a recorded camera has no modes: null) */
    camera(): any { const m = this.mario(); return m && m.simCamera ? m.simCamera : null; }
    isTalkModeNow() { return this.unk124 === 1 || this.unk124 === 2; }
    private setMode(v: number) {
        this.unk124 = v;
        const w = this.world;
        w.talkMode = v === 1 || v === 2;
        w.demoMode = v === 3 || v === 4;
        const m = this.mario();
        if (m && m.simCamera) { m.simCamera.talkModeNow = w.talkMode; m.simCamera.demoModeNow = w.demoMode; }
    }
    private findNearestTakeNPC() {
        const m = this.mario();
        let r: NameRef | null = null;
        for (const n of this.npcs) { const a: any = n; if (a.isNowCanTaken() && m.isTakeSituation(a)) r = n; }
        return r;
    }
    private findNearestTalkNPC() {
        const m = this.mario();
        let r: NameRef | null = null;
        if ((m.mStatus >>> 0) === MARIO_STATUS_WAIT) {
            let best = 5000000;
            const p = m.pos;
            for (const n of this.npcs) {
                const a: any = n;
                if (a.checkLiveFlag(LF.UNK100000) || !a.checkLiveFlag(LF.UNK20000)) continue;
                const dx = fr(a.pos.x - p.x), dy = fr(a.pos.y - p.y), dz = fr(a.pos.z - p.z);
                const d = fr(fr(dz * dz) + fr(fr(dx * dx) + fr(dy * dy)));
                if (d < best) { best = d; r = n; }
            }
        }
        return r;
    }
    /** movement_game (TMarDirector::movement in the game state, after the console's list) */
    movementGame() {
        const m = this.mario();
        if (!m || this.unk124 !== 0) return;
        const P = m.mGamePad;
        P.offFlag(PAD_FLAG_TALK_NPC);
        if (m.mHeldObject) return;
        const C = this.camera();
        if (C && typeof C.isLButtonCamera === 'function' && C.isLButtonCamera()) return;
        if (C && typeof C.isDemoCamera === 'function' && C.isDemoCamera()) return;
        if (this.findNearestTakeNPC()) return;
        const npc = this.findNearestTalkNPC();
        if (!npc) return;
        this.unkA0 = npc;
        P.onFlag(PAD_FLAG_TALK_NPC);
        this.unk128 |= 1;
        if ((this.unk128 & 2) && P.checkFrameMeaning(MEANING_TALK_B)) this.unk126 = 1;
    }
    /** the scripts' __forceStartTalk */
    forceStartTalk(npc: NameRef | null) { this.unkA0 = npc; this.unk126 = 1; }
    // ------------------------------------------------------------ the demo queue (fireStartDemoCamera)
    /** mFlags (DIRECTOR_FLAG_*): the pending demo / shine / game over */
    dflags = 0;
    /** mDemoQueue (8 entries, head / tail) */
    private demoQueue: DemoInfo[] = [];
    private demoHead = 0; private demoTail = 0;
    /** unk60: the tick the demo started (mTickCount) */
    private unk60 = 0;
    /** the state updateGameMode last asked of the director (mState: STATE_UNK4 is 4; 7 the game over, 5 pause, 10 guide, 11 card save) */
    nextState = 4;
    /** TMarDirector::fireStartDemoCamera: queue a camera demo (the script's: timed, no offset) */
    fireStartDemoCamera(name: string | null, offset: V3 | null = null, frames = -1, angle = 0, timed = true, actor: NameRef | null = null) {
        if (((this.demoTail - this.demoHead) & 7) >= 7) return;
        this.dflags |= DF.DEMO_PENDING;
        this.demoQueue[this.demoTail] = { name, offset, frames, angle, timed, actor };
        this.demoTail = (this.demoTail + 1) & 7;
    }
    /**
     * TCameraBck::isFileExist / startDemo: the stage's map/camera/<name>.bck (or a common camera
     * demo's), its length ((duration + 1) * 2 ticks, a looping one -1) and its view (camera/bck.ts).
     */
    private demoBck(name: string) { return cameraBck(this.world, name); }
    /** unk25C: the Shine got (fireGetStar) */
    shine: NameRef | null = null;
    /**
     * TMarDirector::fireGetStar (TMario::winDemo, once he lands): the Shine get pending and its demo
     * camera, the common camera_demo_shine_get_outside.bck (inside: the Shine's unk190) about Mario,
     * turned by the Shine's initial Y rotation.
     */
    fireGetStar(shine: NameRef | null) {
        this.shine = shine;
        this.dflags |= DF.SHINE_GET_PENDING;
        const s: any = shine, m: any = this.world.mario;
        const r = s ? (s.mInitialRotation || s.initRot || s.initialRot || s.rot) : null;
        this.fireStartDemoCamera(s && s.unk190 ? 'camera_demo_shine_get_inside' : 'camera_demo_shine_get_outside', m ? m.pos : null, -1, r ? r.y : 0, false);
    }
    /** TMarDirector::fireEndDemoCamera */
    fireEndDemoCamera() { this.dflags |= DF.END_DEMO_PENDING; }
    private startQueuedDemo() {
        const d = this.demoQueue[this.demoHead], C: any = this.camera();
        if (C && !C.bckSource) C.bckSource = (name: string) => this.demoBck(name);
        if (C && C.startDemoCamera) C.startDemoCamera(d.name, d.offset, d.frames, d.angle, d.timed);
    }
    /** updateGameMode (changeState in the game state, at the tick's end) */
    updateGameMode() {
        const w = this.world;
        const m: any = this.mario();
        const P = this.pad();
        const C: any = this.camera();
        this.nextState = 4;
        // DIRECTOR_FLAG_STAGE_TRANSITION_PENDING: World.setNextStage's (mapevent.ts)
        if (w.stageTransitionPending) this.dflags |= DF.STAGE_TRANSITION_PENDING;
        switch (this.unk124) {
            case 0:
                if (!(this.dflags & ~DF.SHINE_TAKEN)) {
                    // (the pause menu / guide (STATE_PAUSE_MENU 5 / STATE_GUIDE 10) are not simulated)
                    if (m && m.checkFlag(MF_GAME_OVER)) this.dflags |= DF.GAME_OVER_PENDING;
                } else if (this.dflags & DF.GAME_OVER_PENDING) {
                    this.dflags &= ~DF.GAME_OVER_PENDING;
                    this.nextState = 7;
                } else if (this.dflags & DF.SHINE_GET_PENDING) {
                    this.dflags &= ~DF.SHINE_GET_PENDING;
                    this.unk126 = 3;
                    // (the console's shine-get banner, the jingle and the BGM fade are not simulated)
                    w.flags.setBool(true, MSF_GOT_SHINE_IN_PREV_STAGE);
                    const sh: any = this.shine;
                    if (sh && typeof sh.eventId === 'number') w.flags.setShineFlag(sh.eventId);
                    this.dflags |= DF.SHINE_TAKEN | DF.CARD_SAVE_PENDING | DF.STAGE_TRANSITION_PENDING;
                    // decideNextStage: back to Delfino Plaza, its scenario picked by moveStage
                    w.nextArea = { stage: 1, scenario: 0xFF };
                    w.stageTransitionPending = true;
                } else if (this.dflags & DF.DEMO_PENDING) {
                    this.unk126 = 3;
                } else if (this.dflags & DF.CARD_SAVE_PENDING) {
                    // (STATE_CARD_SAVE: not simulated)
                    this.dflags &= ~DF.CARD_SAVE_PENDING;
                } else if (this.dflags & DF.STAGE_TRANSITION_PENDING) {
                    // moveStage: the director goes to STATE_UNK9 (the fade out; the pad loses GAME_INPUT)
                    this.nextState = 9;
                }
                // (the gate demo's camera is fired by setNextStage itself (mapevent.ts), the actor demo's isn't simulated)
                break;
            case 2:
                if (this.dflags & DF.DEMO_PENDING) this.unk126 = 4;
                else if (this.talk.unk248 === 0) this.unk126 = 0;
                break;
            case 3: case 4: {
                let end = false, endCamera = false;
                if (this.dflags & DF.END_DEMO_PENDING) { endCamera = true; end = true; this.dflags &= ~DF.END_DEMO_PENDING; }
                else if ((!C || !C.getRestDemoFrames || !C.getRestDemoFrames())
                    && (!BGM_HANDLE2_PLAYING || w.tickCount - this.unk60 >= 720)) {
                    // (mTickCount counts movement ticks: direct's loop, DOL 0x800ecfa8; 720 = 6 s)
                    end = true;
                    endCamera = this.demoQueue[this.demoHead] ? this.demoQueue[this.demoHead].timed : false;
                }
                if (end) {
                    this.demoHead = (this.demoHead + 1) & 7;
                    if (this.demoHead !== this.demoTail) {
                        if (C) C.endDemoCamera();
                        this.startQueuedDemo();
                    } else {
                        this.dflags &= ~DF.DEMO_PENDING;
                        this.unk126 = this.unk124 === 4 ? 2 : 0;
                        if (endCamera && C) C.endDemoCamera();
                    }
                }
                break;
            }
        }
        if (this.demoHead === this.demoTail) this.dflags &= ~DF.DEMO_PENDING;
        this.unk125 = this.unk124;
        if (this.unk124 !== this.unk126) {
            switch (this.unk124) {
                case 2:
                    if (this.unk126 === 0) {
                        w.events.push({ t: w.tickCount, kind: 'talk:end', data: { npc: this.unkA0 ? this.unkA0.name : '' } });
                        this.unkA0 = null;
                        if (P) P.offFlag(PAD_FLAG_TALK_SELECT);
                        this.stopwatchOn = true;
                    }
                    break;
                case 3: case 4:
                    if (P) P.offFlag(PAD_FLAG_NO_INPUT);
                    this.stopwatchOn = true;
                    break;
            }
            switch (this.unk126) {
                case 1: {
                    const a: any = this.unkA0;
                    if (a && typeof a.onLiveFlag === 'function') a.onLiveFlag(LF.UNK40000);
                    // unkA0->unkC.off(CUE_MOVE | CUE_CALC_ANIM): the cue skip mask's bits cleared
                    if (a) a.flags &= ~(CUE_MOVE | CUE_CALC_ANIM);
                    if (P) P.onFlag(PAD_FLAG_TALK_SELECT);
                    this.stopwatchOn = false;
                    w.events.push({ t: w.tickCount, kind: 'talk:start', data: { npc: a ? a.name : '' } });
                    break;
                }
                case 2: if (this.unk124 === 1) this.talk.openTalkWindow(this.unkA0); break;
                case 3: case 4:
                    if (P) P.onFlag(PAD_FLAG_NO_INPUT);
                    this.startQueuedDemo();
                    this.stopwatchOn = false;
                    this.unk60 = w.tickCount;
                    break;
            }
            this.setMode(this.unk126);
        }
        if (this.unk128 & 1) { this.unk128 &= ~1; this.unk128 |= 2; } else this.unk128 &= ~2;
    }
    /** a movement tick's console list (TTalk2D2) and movement_game, after PerformList Movement */
    tick(last: boolean, gameState: boolean) {
        this.talk.perform(true, last);
        if (gameState) this.movementGame();
    }
}

declare module './engine.js' { interface World { talk: TalkDirector | null; } }
World.prototype.talk = null;

/** set the stage's talk up: its NPCs (TBaseNPC's, in their loadAfter order) and the messages */
export function installTalk(w: World, objects: NameRef[], stageBmg: Uint8Array | null, sysBmg: Uint8Array | null) {
    const t = new TalkDirector(w, stageBmg, sysBmg);
    for (const o of objects) { const a: any = o; if (typeof a.npcTalkOut === 'function' && typeof a.isNowCanTaken === 'function') t.npcs.push(o); }
    w.talk = t;
    return t;
}
