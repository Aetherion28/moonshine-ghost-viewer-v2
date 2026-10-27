// Stage changes (live play): what TMarDirector does when Mario leaves a stage, and how the next one
// starts him.
//
// - The way out: World.setNextStage (mapevent.ts: a warp plane, a pipe / gate / painting object, a
//   script, a streaming movie's stage) or the Shine get (talk.ts: decideNextStage, back to Delfino)
//   sets the next area and DIRECTOR_FLAG_STAGE_TRANSITION_PENDING; updateGameMode's moveStage then puts
//   the director in STATE_UNK9 (the fader's 0.4 s wipe out), after which TApplication loads the next
//   area. A miss (MARIO_FLAG_GAME_OVER) is STATE_UNK7: a life off, the miss wipe, then
//   decideNextStageOfMiss (a secret course again, else Delfino), or the game over (back to Delfino or
//   the airstrip). moveStage (MarDirectorDirect.cpp) picks the next area's scenario when it is 0xFF:
//   Delfino's by the story flags (decideNextScenario), a course's on the episode select
//   (TSelectMenu's default: the episode after the last Shine got), the others by MSF_EPISODE.
// - The way in: decideMarioPosIdx (MarDirectorSetupObjects.cpp): the start kind (1 the courses'
//   rolling start, 2 Delfino's return from a course, out of its door / painting / pipe, 0 waiting) and
//   the entrance (unkD0: an index into the scene's TMarioPositionObj "マリオセット位置"), which setMario
//   uses when the director starts the game.
// - LiveDirector: the director's opening as the game runs it live, not from a ghost: the stage's
//   intro camera (STATE_UNK1: startcamera or Delfino's demo of the moment) until the camera's demo has
//   a second left or the pad's Start / A / B skip it, the console's close wipe (TConsoleStr: after the
//   stage / episode names have shown, when they do), then setMario and the open wipe; and the stage
//   change's and the miss's fades.
//
// Approximations (marked): the console's wipe lengths are the counts the HUD's TConsoleStr port
// measured (hud/index.ts INTRO_FRAMES), the miss's fade is 2.2 s + 0.5 s, and the director's change to
// STATE_UNK3 is moved to the next tick that a ghost of the run can give back exactly (see
// LiveDirector.closeDemo); the card save, the pause menu, the episode select screen and the
// streaming movies (THP) are not shown.

import { register } from './scene.js';
import { NameRef, Stream, World, shineIDofExStage } from './engine.js';
import { V3 } from './math.js';
import { FlagManager, MSF, shineStage } from './flags.js';
import { PlayerDirector, PlayerMario, DIR, IntroTiming } from './player/player.js';
import { MEANING } from './player/pad.js';
import { A } from './player/tables.js';

// ---------------------------------------------------------------- TMarioPositionObj
/** TMarioPositionObj ("マリオセット位置"): up to 8 entrances, each a name, a position, a rotation (degrees) and a scale */
export class MarioPositionObj extends NameRef {
    pos: V3[] = []; rot: V3[] = [];
    load(s: Stream) {
        // (JSUMemoryInputStream: while more than 36 bytes are left)
        for (let i = 0; i < 8 && s.left > 36; i++) {
            s.str();
            this.pos.push(new V3(s.f32(), s.f32(), s.f32()));
            this.rot.push(new V3(s.f32(), s.f32(), s.f32()));
            s.f32(); s.f32(); s.f32();
        }
    }
    /** unkD0: how many were read */
    get count() { return this.pos.length; }
}
register('MarioPositionObj', (_w, n) => new MarioPositionObj(n));

// ---------------------------------------------------------------- the areas
/** SMS_isExMap */
export const isExMap = (area: number) => area > 0x14 && area < 0x35;
/** StageUtil.hpp's scShineConvTable: each world's episode Shines (by SMS_getShineStage) */
const SHINE_CONV: (number[] | null)[] = [
    [0x56], null,
    [0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7], [0xA, 0xB, 0xC, 0xD, 0xE, 0xF, 0x10, 0x11],
    [0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B], [0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25],
    [0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F], [0x3C, 0x41, 0x3E, 0x3D, 0x40, 0x3F, 0x42, 0x43],
    [0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39], null,
];
/** SMS_isGetShine(stage, scenario, false) */
function isGetShine(f: FlagManager, stage: number, scenario: number) {
    const t = stage <= 9 ? SHINE_CONV[stage] : null;
    const id = t ? t[scenario] : undefined;
    return id !== undefined && f.getShineFlag(id);
}
/** TSelectMenu::initData's preselected episode: the one after the last Shine got (at most the 8th) */
export function selectMenuEpisode(f: FlagManager, area: number) {
    let n = 0;
    for (let i = 0; i < 8; i++) if (isGetShine(f, shineStage(area), i)) n = i + 2;
    if (n > 8) n = 8;
    if (n === 0) n = 1;
    return Math.max(0, n - 1);
}
/**
 * TSelectMenu::initData's reading of the save for the episode select (live play's select screen,
 * hud/menus.ts SelectMenu): each episode's state (3 got, 2 open, 0 not yet), how many are open, the
 * coin record (MSF_COIN_RECORD_BASE + the Shine stage), the 100-coin Shine and the extra Shines got.
 */
export function selectMenuInput(f: FlagManager, area: number) {
    const ETC: Record<number, number[]> = { 2: [0x64, 0x8, 0x9], 3: [0x65, 0x12, 0x13], 4: [0x66, 0x1C, 0x1D], 5: [0x67, 0x26, 0x27], 6: [0x68, 0x30, 0x31], 8: [0x6A, 0x44, 0x45], 9: [0x69, 0x3A, 0x3B] };
    const states = [2, 2, 2, 2, 2, 2, 2, 2];
    let open = 0;
    for (let i = 0; i < 8; i++) if (isGetShine(f, shineStage(area), i)) { states[i] = 3; open = i + 2; }
    if (open > 8) open = 8;
    if (open === 0) open = 1;
    for (let i = open; i < 8; i++) states[i] = 0;
    const etc = ETC[area] || [0, 0, 0];
    let extra = 0;
    for (let i = 1; i < 3; i++) if (f.getShineFlag(etc[i])) extra++;
    return { stage: area, states, open, coins: f.getFlag(0x20005 + shineStage(area)), coinShine: f.getShineFlag(etc[0]), extra };
}
/** checkDefeatShadowMarioAll */
function defeatShadowMarioAll(f: FlagManager) {
    for (const s of [0x6, 0x10, 0x1A, 0x24, 0x2E, 0x38, 0x42]) if (!f.getShineFlag(s)) return false;
    return true;
}
/** decideNextScenario(1): Delfino Plaza's scenario from the story flags */
export function decideNextScenario(f: FlagManager): number {
    if (f.getBool(MSF.CORONA_VISITED)) return 2;
    if (defeatShadowMarioAll(f)) return 9;
    if (f.getBool(MSF.BOWSER_BOAT_CUTSCENE_TRIGGERED)) return 8;
    if (f.getBool(MSF.M_PAINTED_ON_BOATHOUSE) && f.getBool(MSF.M_PAINTED_ON_LIGHTHOUSE)) return f.getFlag(MSF.SHINE_COUNT) >= 10 ? 7 : 6;
    if (f.getBool(MSF.M_PAINTED_ON_STATUE)) return 5;
    if (f.getBool(MSF.BIANCO_POLLUTED_PIRANHA_DEFEATED)) return 1;
    return 0;
}
export interface Area { stage: number; scenario: number; }
/** decideNextStageOfMiss: a secret course (or the airstrip / Corona's 60) again, else Delfino */
export function decideNextStageOfMiss(cur: Area): Area {
    if (isExMap(cur.stage) || cur.stage === 0 || cur.stage === 60) return { stage: cur.stage, scenario: 0 };
    return { stage: 1, scenario: 0xFF };
}
/**
 * TMarDirector::moveStage's flag writes and its scenario pick (a 0xFF scenario): what the next area
 * is. secondNozzle: Mario's TWaterGun::mSecondNozzle when he has FLUDD (-1: none). The episode select
 * of a course is its default (the player can't pick one here).
 */
export function moveStage(f: FlagManager, cur: Area, next: Area, secondNozzle: number): Area & { select: boolean } {
    const n = { stage: next.stage, scenario: next.scenario, select: false };
    if (shineStage(n.stage) !== shineStage(cur.stage)) f.setFlag(MSF.GOLD_COIN_COUNT, 0);
    if (n.scenario === 0xFF) {
        const ep = f.getFlag(MSF.EPISODE);
        switch (n.stage) {
            case 1: n.scenario = decideNextScenario(f); f.setFlag(MSF.EPISODE, 0); break;
            case 13: n.scenario = ({ 0: 0, 2: 1, 4: 2, 5: 3, 6: 4, 7: 5 } as Record<number, number>)[ep] ?? 0; break;
            case 0x3A: n.scenario = ({ 0: 1, 7: 0 } as Record<number, number>)[ep] ?? 0; break;
            case 7: n.scenario = ({ 1: 0, 2: 1, 3: 2, 4: 2, 6: 3, 7: 4 } as Record<number, number>)[ep] ?? 0; break;
            case 14: n.scenario = ({ 3: 0, 4: 1 } as Record<number, number>)[ep] ?? 0; break;
            // APP_STATE_TITLE: the episode select (TSelectDir: mNextArea's scenario and MSF_EPISODE the episode chosen)
            case 2: case 3: case 4: case 5: case 6: case 8: case 9:
                n.scenario = selectMenuEpisode(f, n.stage); f.setFlag(MSF.EPISODE, n.scenario); n.select = true; break;
            case 0x34: n.scenario = 0; f.setFlag(MSF.EPISODE, 0); break;
            case 0: n.scenario = 0; f.setFlag(MSF.EPISODE, 0); break;
            default: n.scenario = 0; break;
        }
    }
    if (secondNozzle >= 0) f.setFlag(MSF.SECONDARY_NOZZLE, secondNozzle === 3 /* Yoshi */ ? 4 /* Hover */ : secondNozzle);
    return n;
}

/**
 * setupObjects' DEMO_FLAG_CAMERA_DEMO_ON_START for Delfino Plaza (read before its flag writes) and
 * nextStateInitialize(STATE_UNK1)'s demo name (after them).
 */
export function plazaDemoOnStart(f: FlagManager, scenario: number): boolean {
    if (!f.getBool(MSF.PLAZA_DEMO_WATCHED_SINCE_RESET)) return true;
    switch (scenario) {
        case 0: case 1: case 7: case 9: return true;
        case 5: return (!f.getBool(MSF.M_PAINTED_ON_BOATHOUSE) && f.getFlag(MSF.SHINE_COUNT) >= 3) || (!f.getBool(MSF.M_PAINTED_ON_LIGHTHOUSE) && f.getFlag(MSF.SHINE_COUNT) >= 5);
        case 8: {
            const shines = f.getFlag(MSF.SHINE_COUNT);
            if (!f.getBool(MSF.YOSHI_UNLOCKED) && f.getShineFlag(33)) return true;
            if (!f.nozzleRight(1, 1) && f.getBool(MSF.YOSHI_UNLOCKED) && shines >= 25) return true;
            if (!f.nozzleRight(1, 0) && f.nozzleRight(1, 1) && shines >= 30) return true;
            return shines >= 20;   // (with MSF_SHADOW_MARIO_EVENT 0, which the three above leave it at)
        }
    }
    return false;
}
export function stageDemoName(f: FlagManager, area: number, scenario: number, plazaDemo: boolean): string {
    if (area !== 1 || !plazaDemo) return 'startcamera';
    if (scenario === 8) {
        switch (f.getFlag(MSF.SHADOW_MARIO_EVENT)) {
            case 0: return f.getFlag(MSF.SHINE_COUNT) >= 0x14 ? 'mareopen_startcamera' : 'startcamera';
            case 1: return 'yoshi_startcamera';
            case 2: return 'turbo_startcamera';
            case 3: return 'rocket_startcamera';
        }
        return 'startcamera';
    }
    if (f.getBool(MSF.RICCO_UNLOCKABLE)) return 'sinkricco';
    if (f.getBool(MSF.GELATO_UNLOCKABLE)) return 'sinkmamma';
    return 'startcamera';
}

// ---------------------------------------------------------------- decideMarioPosIdx / setMario
export interface Entrance { posIdx: number; kind: number; }
/** decideMarioPosIdx (its flag writes on f): the start kind (unkD1) and the entrance (unkD0) */
export function decideMarioPosIdx(f: FlagManager, area: number, prevArea: number): Entrance {
    let posIdx = 0, kind = 0;
    switch (area) {
        case 0: if (f.getBool(MSF.UNK30001)) f.setBool(false, MSF.UNK30001); break;
        case 2: case 3: case 4: case 5: case 6: case 8: case 9: kind = 1; break;
        case 1:
            if (f.getBool(MSF.UNK30001)) f.setBool(false, MSF.UNK30001);
            else if (f.getBool(MSF.PEACH_KIDNAP_FMV_WATCHED_SINCE_RESET)) { f.setBool(false, MSF.PEACH_KIDNAP_FMV_WATCHED_SINCE_RESET); posIdx = 4; }
            else if (prevArea >= 0) {
                const s = shineStage(prevArea);
                if (s >= 2 && s <= 8) { posIdx = s - 1; kind = 2; }
                else if (s === 9) posIdx = 8;
            }
            break;
    }
    return { posIdx, kind };
}
/**
 * TMarDirector::setMario's start for an entrance: the rolling start (the courses), the return to
 * Delfino (out of the door / pipe the course is behind: rolling out, or with the Shine when one was got
 * there: MSF_GOT_SHINE_IN_PREV_STAGE, which it clears; got overrides it), the waiting start.
 */
export function entranceStart(w: World, e: Entrance, prevArea: number, got?: boolean): (m: PlayerMario) => void {
    return (m: PlayerMario) => {
        let gotShine = w.flags.getBool(MSF.GOT_SHINE_IN_PREV_STAGE);
        if (gotShine) w.flags.setBool(false, MSF.GOT_SHINE_IN_PREV_STAGE);
        if (got !== undefined) gotShine = got;
        const mpo = w.search('マリオセット位置') as MarioPositionObj | null;
        let idx = e.posIdx;
        if (!(mpo instanceof MarioPositionObj) || mpo.count === 0 || idx > mpo.count) idx = 0;
        const pos = idx ? mpo!.pos[idx - 1].clone() : null, rotY = idx ? mpo!.rot[idx - 1].y : 0;
        switch (e.kind) {
            case 1: m.rollingStart(pos, rotY); break;
            case 2: {
                const s = prevArea >= 0 ? shineStage(prevArea) : 0;
                m.returnStart(pos, rotY, gotShine, s >= 5 && s <= 7 ? 1 : s === 8 ? 2 : 0);
                break;
            }
            // (4: toroccoStart, the Pianta 8 / Delfino minecart: not simulated)
            default: m.waitingStart(pos, 0); break;
        }
    };
}
/** A later segment's start from a ghost: the APPEAR animation it shows says whether a Shine was got */
export function gotShineFromSamples(samples: { anim: number }[]): boolean | undefined {
    for (const s of samples.slice(0, 40)) {
        if (s.anim === A.DEMO_GATE_OUT_APPEAR_GET) return true;
        if (s.anim === A.DEMO_GATE_OUT_APPEAR) return false;
    }
    return undefined;
}

// ---------------------------------------------------------------- LiveDirector
/** the console's close wipe: the bars (46 ticks), then dark until unk2BC 4 (41): hud/index.ts INTRO_FRAMES */
export const CLOSE_WIPE_TICKS = 46, CLOSE_HOLD_TICKS = 41;
/** TConsoleStr::processScenario: the stage / episode names showing (unk1C from -200 by 2 past 355) before the bars can close */
export const SCENARIO_TICKS = 278;
/** the fader's startWipe(.., 0.4 s) */
export const FADE_TICKS = 48;
/** STATE_UNK7: the miss's wipe (startWipe(10, 0, 2.2): 2.2 s before it), then its fade (taken as 0.5 s) */
export const MISS_WAIT_TICKS = 264, MISS_FADE_TICKS = 176;
/**
 * The last life's: startWipe(0xD, 0, 2.0): Hx_GameOver after 2 s, 244 drawn frames (hud/wipe.ts).
 * (Both waits leave out the jingle the director also waits on: MSBgm::getHandle(2).)
 */
export const GAME_OVER_WAIT_TICKS = 240, GAME_OVER_FADE_TICKS = 244 * 4;
/** DEMO_STAGES (player.ts): their intro shows the stage and episode names (TRANSITION_FLAG_SCENARIO_NAME_BANNER_PENDING) */
const NAMED = new Set([2, 3, 4, 5, 6, 8, 9, 0x34]);

export interface LiveTiming extends IntroTiming {
    live: true;
    area: number; scenario: number;
    /** the stage's intro can be skipped (not Delfino's scenario 1 and 9) */
    skippable: boolean;
    makeDirector: (p: PlayerMario, map: number, start: boolean, t: IntroTiming) => PlayerDirector;
    flags?: FlagManager | null;
}

/**
 * The director's opening and endings live (the base class runs a ghost's, its intro's end given).
 * STATE_UNK1 ends the game's way (changeState): once the camera's demo has a second or less left
 * (getRestDemoFrames() / 120 <= getWipeCloseTime()) or Start / A / B is pressed, the console's close
 * wipe starts (after the names have shown on a named stage) and the director goes on to STATE_UNK3
 * when it is done.
 */
export class LiveDirector extends PlayerDirector {
    /** the tick the state last changed, the demo started, the close wipe started; the tick of setMario */
    enteredTick = 0; demoTick = -1; closeTick = -1; setMarioTick = -1;
    /** the miss was the last life (STATE_UNK7's game over wipe, 0xD; else 10): hud/wipe.ts draws it */
    lastLife = false;
    /** the miss's wipe: its type and the tick it starts (the HUD's) */
    get missWipe() { return this.state === DIR.GAME_OVER ? { type: this.lastLife ? 13 : 10, tick: this.enteredTick + (this.lastLife ? GAME_OVER_WAIT_TICKS : MISS_WAIT_TICKS) } : null; }
    private tick = 0;
    constructor(mario: PlayerMario, map: number, hasStartCamera: boolean, public live: LiveTiming) {
        super(mario, map, hasStartCamera, live);
        live.demoEndTick = Infinity;
    }
    setMario() {
        const was = this.setMarioDone;
        super.setMario();
        if (!was && this.setMarioDone) this.setMarioTick = this.tick;
    }
    changeState(tick: number) {
        this.tick = tick;
        const prev = this.state;
        if (prev === DIR.DEMO && this.closeTick < 0) this.checkDemo(tick);
        super.changeState(tick);
        if (this.state !== prev) {
            this.enteredTick = tick;
            if (this.state === DIR.DEMO) this.demoTick = tick;
            if (this.state === DIR.GAME_OVER) {
                // STATE_UNK7's nextStateInitialize: a life off (updateGameMode cleared the gold coins)
                const f = this.mario.world.flags;
                f.setFlag(MSF.GOLD_COIN_COUNT, 0);
                f.decFlag(MSF.LIFE_COUNT, 1);
                this.lastLife = f.getFlag(MSF.LIFE_COUNT) < 0;
                // (MSBgm::startBGM: the miss jingle (MSD_BGM_BOSS, the decomp's name) with lives left, else the game over's (MSD_BGM_BOSSHANA_2ND3RD))
                const w = this.mario.world;
                w.events.push({ t: w.tickCount, kind: 'bgm', data: { id: this.lastLife ? 0x80010028 : 0x8001000C } });
            }
        }
    }
    /** the pause menu's "exit the area" (case 5: moveStage, STATE_UNK9) */
    exitArea(tick: number) {
        (this as any).enter(DIR.MOVE_STAGE, tick);
        this.enteredTick = tick;
    }
    private checkDemo(tick: number) {
        const C: any = this.mario.simCamera;
        const rest = C && C.getRestDemoFrames ? C.getRestDemoFrames() : 0;
        const P = this.mario.mGamePad;
        const skip = this.live.skippable && P.checkFrameMeaning(MEANING.START | MEANING.MENU_A | MEANING.MENU_B);
        if (rest / 120 <= 1 || skip) this.closeDemo(tick);
    }
    /**
     * startCloseWipe: the bars close from this tick (a named stage's wait for its names to finish
     * first), and the director's STATE_UNK1 -> STATE_UNK3 comes when the console's wipe is done. That
     * tick is then moved on to the next one a ghost of the run gives back exactly (player.ts
     * introDemoEnd: a ghost's first sample is the end of the frame after setMario's, five ticks on
     * for an intro (≡ 3 mod 4), seven without (Delfino's demo: ≡ 1 mod 4, as its replay starts him at
     * once)): at most 3 ticks.
     */
    private closeDemo(tick: number) {
        const named = NAMED.has(this.map) || this.map === 1;
        const from = named && this.demoTick >= 0 ? Math.max(tick, this.demoTick + SCENARIO_TICKS) : tick;
        this.closeTick = from;
        let end = from + CLOSE_WIPE_TICKS + CLOSE_HOLD_TICKS;
        const want = this.map === 1 ? 1 : 3;
        end += ((want - (end & 3)) + 4) & 3;
        this.timing.demoEndTick = end;
    }
    /** the stage change's fade (STATE_UNK9) or the miss (STATE_UNK7) is done: the next area can load */
    done(tick: number) {
        if (this.state === DIR.MOVE_STAGE) return tick - this.enteredTick >= FADE_TICKS;
        if (this.state === DIR.GAME_OVER) return tick - this.enteredTick >= (this.lastLife ? GAME_OVER_WAIT_TICKS + GAME_OVER_FADE_TICKS : MISS_WAIT_TICKS + MISS_FADE_TICKS);
        return false;
    }
    /** how dark the screen is (0..1): the fade in, the console's wipes, the fades out */
    wipe(tick: number): number {
        const c = (v: number) => Math.max(0, Math.min(1, v));
        const t = tick - this.enteredTick;
        switch (this.state) {
            case DIR.BOOT: return 1;
            case DIR.DEMO: return this.closeTick >= 0 && tick >= this.closeTick ? c((tick - this.closeTick) / CLOSE_WIPE_TICKS) : c(1 - tick / FADE_TICKS);
            case DIR.WIPE_OPEN: return c(1 - t / 31);
            case DIR.MOVE_STAGE: return c(t / FADE_TICKS);
            case DIR.GAME_OVER: return this.lastLife ? c((t - GAME_OVER_WAIT_TICKS) / GAME_OVER_FADE_TICKS) : c((t - MISS_WAIT_TICKS) / MISS_FADE_TICKS);
            default: return this.enteredTick < FADE_TICKS && tick < FADE_TICKS ? c(1 - tick / FADE_TICKS) : 0;
        }
    }
}

/** the secret course's Shine is got (setMario keeps FLUDD on Mario, its red coin switch is there) */
export function exShineGot(f: FlagManager, area: number) { const id = shineIDofExStage(area); return id !== 0xFF && f.getShineFlag(id); }

// ---------------------------------------------------------------- a recorded live run's stage changes, replayed
/** a course's episode Shine (scShineConvTable), or a secret course's (shineIDofExStage); -1: not known */
export function episodeShineId(area: number, episode: number): number {
    const ex = shineIDofExStage(area);
    if (ex !== 0xFF) return ex;
    const s = shineStage(area), t = s >= 2 && s <= 9 ? SHINE_CONV[s] : null;
    return t && t[episode] !== undefined ? t[episode] : -1;
}
/** the animations of a miss (TMario::loserExec's downings: downLoser / elecDowning, swimDown, sinkLoser's sand and goop) */
const MISS_ANIMS = new Set([A.SHOCK_DOWN, A.SWIM_DOWN, A.SWIM_P_DOWN, A.SINK_DOWN, A.SAND_FILL_HEAD_END, A.SANDFILL_LEG_END]);
/** how far back from a stage's last sample the miss's animation can be (STATE_UNK7: its wipe and fade) */
const MISS_LOOKBACK_QF = MISS_WAIT_TICKS + MISS_FADE_TICKS + 120;
const cloneFlags = (f: FlagManager) => { const c = new FlagManager(), b = (f as any).banks; for (const k in b) (c as any).banks[k] = Int32Array.from(b[k]); return c; };

/**
 * What a recorded live run (runner.ts LiveRunner, ghostwrite.ts) carried into segment segI of the
 * ghost (parseSmsGhost's): the save's flags and the area left, as LiveRunner.leave and the stages
 * before wrote them. From the ghost: each stage's own setup (setupStage, decideMarioPosIdx and
 * setMario's MSF_GOT_SHINE_IN_PREV_STAGE), how it ended (a Shine: the next stage's APPEAR_GET, or a
 * Delfino stage followed by Delfino without a miss; a miss: its downing animation at the stage's end,
 * a life off, the game over below 0 lives; else a stage change), and moveStage (its scenario pick when
 * that gives the episode recorded, else the recorded one, as the episode select picks it).
 * Approximations: what a stage's objects and scripts wrote along the way (a red coin switch, an NPC
 * event, a 1-up) isn't in the ghost, and a Shine got in Delfino Plaza is counted as none (its ID).
 */
export function liveRunCarry(g: any, segI: number): { flags: FlagManager; prevArea: number } {
    const f = new FlagManager();
    let prev = -1;
    const samples = (k: number) => { const s = g.segments[k], out: { qf: number; anim: number }[] = []; for (let i = s.firstSample; i < s.firstSample + s.sampleCount; i++) out.push({ qf: g.qf[i], anim: g.anim[i] }); return out; };
    for (let k = 0; k < segI && k + 1 < g.segments.length; k++) {
        const seg = g.segments[k], area = seg.route.area, ep = seg.route.episode, nx = g.segments[k + 1].route;
        // the stage's start: Stage's setupStage (the first stage's a fresh save's, with the inferences), setMario's entrance
        const exId = shineIDofExStage(area);
        f.setupStage(area, ep, k > 0 && exId !== 0xFF && f.getShineFlag(exId), exId, k === 0);
        decideMarioPosIdx(f, area, prev);
        f.setBool(false, MSF.GOT_SHINE_IN_PREV_STAGE);
        // how it ended
        const own = samples(k), end = own.length ? own[own.length - 1].qf : 0;
        const miss = own.some((s) => s.qf >= end - MISS_LOOKBACK_QF && MISS_ANIMS.has(s.anim));
        const next = samples(k + 1).slice(1);   // (past the pose copied back to the stage's start)
        const got = !miss && (gotShineFromSamples(next) ?? (area === 1 && nx.area === 1));
        let to: Area = { stage: nx.area, scenario: 0xFF };
        if (got) {
            f.setBool(true, MSF.GOT_SHINE_IN_PREV_STAGE);
            const id = area === 1 ? -1 : episodeShineId(area, ep);
            if (id >= 0) f.setShineFlag(id);
        } else if (miss) {
            f.setFlag(MSF.GOLD_COIN_COUNT, 0);
            f.decFlag(MSF.LIFE_COUNT, 1);
            if (f.getFlag(MSF.LIFE_COUNT) >= 0) f.setBool(true, MSF.LOST_LIFE_IN_PREV_STAGE);
            else { f.setFlag(MSF.LIFE_COUNT, 0); f.correctFlag(); f.setBool(true, MSF.UNK30001); }
        }
        // FLUDD's second nozzle (moveStage's MSF_SECONDARY_NOZZLE): the last one the inputs saw
        const I = g.inputs;
        let second = -1;
        if (I && I.hasFludd && I.fluddMode) {
            for (let i = 0; i < I.count; i++) {
                if (I.qf[i] < seg.startQf - g.header.startQf || I.qf[i] > seg.endQf - g.header.startQf) continue;
                const m = I.fluddMode[i];
                if (m & 0x80 || !(m & 0x08)) second = -1;
                else if ((m & 7) !== 0 || second < 0) second = (m & 7) || 4;
            }
        }
        const cur: Area = { stage: area, scenario: ep };
        if (moveStage(cloneFlags(f), cur, to, second).scenario !== nx.episode) {
            to = { stage: nx.area, scenario: nx.episode };
            if ([1, 0, 0x34].includes(nx.area)) f.setFlag(MSF.EPISODE, 0);
            else if (nx.area >= 2 && nx.area <= 9 && nx.area !== 7) f.setFlag(MSF.EPISODE, nx.episode);
        }
        moveStage(f, cur, to, second);
        prev = area;
    }
    return { flags: f, prevArea: prev };
}

/**
 * The QF between one stage's last recorded frame and the next stage's first, by the destination, as
 * the real Moonshine ghosts have them (their segment gaps: 96-100 into a secret course, 104 into
 * 0x39 / 0x3C, 8 into everything else: courses, Delfino, Bianco / Ricco / Delfino bosses, Pinna,
 * Sirena's hotel and casino). The load's black screen, in live play (LiveRunner) and its recordings.
 */
export function loadGapQf(dest: number): number {
    if (isExMap(dest)) return 96;
    if (dest === 0x39 || dest === 0x3C) return 104;
    return 8;
}
