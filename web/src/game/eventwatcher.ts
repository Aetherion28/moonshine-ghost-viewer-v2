// TEventWatcher (System/EventWatcher.cpp): a stage's event scripts, and the builtins they call
// (EventWatcher.cpp's ev*, NpcEvent.cpp's TNpcEvent::initNpcBuiltin).
//
// TMarDirector::setupObjects makes one TEventWatcher ("<EventWatcher>") per .sb file of
// /common/sp (common.szs: sunglass.sb, the sunglasses shop) and then of /scene/map/sp (the stage
// archive's map/sp), in folder order, into the event group (イベントグループ). Each loads its file
// (launchScript: TSpcTypedBinary<TEventWatcher>, init, TSpcTypedInterp with 0x20 steps a call and
// 0x20-deep stacks) and, on every CUE_MOVE, runs its interpreter (perform: update). The event
// group is in PerformList Movement after the water manager (PerformLists.bin: map group, graffiti
// group, conductor, manager group, player group, camera 1, 水マネージャ, sky, mirror model, event
// group, silhouette, indirect scene): Stage.runFrame runs it there.
//
// What the scripts do (the stages' .sb files): wait on save flags and set them (Phantamanta's
// appearance: sirena0's appearmanta.sb sets MSF_MANTA_SPAWNED once Mario has talked to モンテＡ;
// red coins: redcoin.sb makes the Shine appear when MSF_RED_COIN_COUNT reaches 8; timerredcoin.sb
// the secret stages' timed red coins after the red coin switch), and above all talk: almost every
// script polls isTalkModeNow / getTalkNPCName and runs the NPC's dialogue (setTalkMsgID, then
// waits for the talk window), setting flags, giving Shines, warping, starting races.
//
// The builtins here act on the sim's objects through the names the scripts give (TNameRefGen::
// search: world.search) or through handles (a TNameRef* as an int: getNameRefHandle and the
// talk / view-object lookups return one; `handles` maps them back). The ones that only drive the
// 2D layout, the sound, the BGM, the movie player or the demo camera are no-ops here (a demo camera
// or a balloon is told as a world effect), but each pops its arguments and pushes its result as the
// game's does, so the scripts take the same paths and the same number of steps.
//
// Not simulated, so the scripts see the game's values for "not now":
// - with the ghost's own Mario (no input-driven player) TMarDirector's talk mode: world.talkMode
//   stays off, getTalkNPC is the scripts' own __forceStartTalk's, the window a closed one's 0 (with
//   the player, talk.ts runs the talk: isTalkModeNow, getTalkNPC, setTalkMsgID, getTalkMode,
//   getTalkSelectedValue and forceCloseTalk are its director's and window's);
// - the director's demo mode (isDemoMode: world.demoMode, which nothing sets; fireStartDemoCamera is
//   a 'demo:<name>' effect);
// - the timers: the director's stopwatch (unkE8: OSStopwatch, wall-clock time stopped during talks
//   and demos) is taken as running from the stage's start at 1000/30 ms a frame, and the console's
//   timer (TGCConsole2::setTimer(-1), its getFinishedTime) is updated once a frame after the
//   movement ticks; the insert / remove animations (unk3F) as done at once.

import { V3, fr, JMASSin, JMASCos } from './math.js';
import { World, NameRef, HitActor, LiveActor, LF, HF, CUE_MOVE } from './engine.js';
import { AT } from './actortypes.js';
import { SpcBinary, SpcInterp, SpcSlice, SLICE_INT, SLICE_STRING, SpcBuiltin } from './spc.js';
import { CubeManager } from './mapwire.js';
import type { StageFiles } from './scene.js';

/** TBaseNPC's live flags (npc/base.ts LF_N: the US / PAL values) */
const LF_N_DONT_TALK = LF.UNK10000, LF_N_SINK_BOTTOM = 0x1000000, LF_N_DONT_THROW = 0x40000000;
/** TBaseNPC::NPC_ACTION_DANCE */
const NA_DANCE = 0x4;
/** MARIO_STATUS_WAIT, MARIO_STATUS_FLAG_JUMPING */
const MARIO_STATUS_WAIT = 0x0C400201, MARIO_STATUS_FLAG_JUMPING = 0x800;

/** NerveGetByIndex (Strategic/liveinterp.cpp): the nerves the scripts name by index (0x6b on: none) */
const NERVE_BY_INDEX = ('TNerveSmallEnemyFreeze TNerveSmallEnemyDie TNerveSmallEnemyJump TNerveSmallEnemyHitWaterJump TNerveWalkerGenerate ' +
    'TNerveWalkerGraphWander TNerveWalkerEscape TNerveWalkerAttack TNerveWalkerPostAttack TNerveWalkerTraceMario TNerveNameKuriDrawPollute ' +
    'TNerveNameKuriLand TNerveNameKuriJumpAttack TNerveNameKuriJumpAttackPrepare TNerveNameKuriExplosion TNerveNameKuriDiffuse TNerveNKFollowMario ' +
    'TNerveBGWait TNerveBGTentacleDamage TNerveBGEyeDamage TNerveBGBeakDamage TNerveBGTug TNerveBGDie TNerveBGPollute TNerveBGPolDrop TNerveBGRoll ' +
    'TNerveBPWait TNerveBPCannon TNerveBPVomit TNerveBPTornado TNerveBPPivot TNerveBPSwallow TNerveBPTumbleIn TNerveBPTumble TNerveBPTumbleOut ' +
    'TNerveBPGetUp TNerveBPSwing TNerveBPStompReact TNerveBPJumpReact TNerveBPPreDie TNerveBPDie TNerveBPTakeOff TNerveBPFly TNerveBPTouchDown ' +
    'TNerveBPFlyCannon TNerveBPFlyPivot TNerveBPFall TNerveBPHover TNerveBPSleep TNerveBPBreakSleep TNerveBPWaitL TNerveBPCannonL ' +
    'TNerveBWGraphWander TNerveBWRoll TNerveBWBark TNerveBWJump TNerveBWStun TNerveBWWakeup TNerveBWJumpToBath TNerveBWDie TNerveBWJumpAway ' +
    'TNerveBWShake TNerveBWFall TNerveBEelTearsGenerate TNerveBEelTearsMarioRecover TNerveBEelTearsSplit TNerveBEelTearsWaterHit ' +
    'TNerveBEelTearsMoveUp TNerveOilBallStay TNerveBossEelWaitAppear TNerveBossEelFirstSpin TNerveBossEelSecondSpin TNerveBossEelAppear ' +
    'TNerveBossEelOutWait TNerveBossEelSlowBack TNerveBossEelQuickBack TNerveBossEelEat TNerveBossEelDie TNerveBossEelMouthOpenWait ' +
    'TNerveBossEelSleepOnBottom TNerveBossHanachanGraphWander TNerveBossHanachanTumble TNerveBossHanachanDown TNerveBossHanachanGetUp ' +
    'TNerveBossHanachanDamage TNerveBossHanachanSnort TNerveBossHanachanDead TNerveSBH_SleepContinue TNerveSBH_Fall TNerveTypicalGraphWander ' +
    'TNerveNPCGraphWander TNerveNPCUTurn TNerveNPCGraphWait TNerveNPCWaitContinue TNerveNPCWaitMarioApproach TNerveNPCTurnToMario TNerveNPCWet ' +
    'TNerveNPCSink TNerveNPCRecoverFromSink TNerveNPCRecoverAfter TNerveNPCSetPosAfterSinkBottom TNerveNPCTalk TNerveNPCThrow TNerveNPCMad ' +
    'TNerveNPCBlown TNerveNPCMareStand TNerveAnimalGraphWander').split(' ');
const nerveName = (i: number) => (i >= 0 && i < NERVE_BY_INDEX.length ? NERVE_BY_INDEX[i] : null);

// ---------------------------------------------------------------- the director's share the scripts reach
/** TMarDirector / TGCConsole2 state the builtins read and write (per world). */
export class ScriptDirector {
    /** unkA0: the talking NPC (handle target) */
    talkingNPC: NameRef | null = null;
    /** unk126: the requested director state (1: start a talk) — the talk itself isn't simulated */
    unk126 = 0;
    /** the director's stopwatch (unkE8), in movement ticks since its last reset */
    stopwatchTicks = 0;
    /** unkC8: the stopwatch's reading at startTimer (ms) */
    unkC8 = 0;
    /** unk120: setTimeLimit's limit */
    unk120 = 0;
    // TGCConsole2's timer
    unk510 = false; unk514 = 0; unk4A = 0; unk3F = 0; unk518 = 0; unk4FC = 0;
    /** the stopwatch in ms (OSTicksToMilliseconds(OSCheckStopwatch)) */
    ms() { return Math.floor(this.stopwatchTicks * 1000 / 120); }
    getRestTime() { return (this.unk120 - Math.trunc(this.ms() / 10)) | 0; }
    startTimer() { this.unkC8 = this.ms(); }
    /** TGCConsole2::setTimer */
    setTimer(v: number) {
        let t: number;
        if (v === -1) {
            t = Math.trunc(fr((this.ms() - this.unkC8) * fr(0.1))) >>> 0;
            if (!this.unk510) t = this.unk514 >>> 0 < t ? 0 : (this.unk514 - t) >>> 0;
        } else t = v >>> 0;
        if (t > 599999) t = 599999;
        this.unk4FC = t | 0;
    }
    startAppearTimer(kind: number, t: number) {
        if (kind === 0) { this.unk510 = true; this.unk514 = 0; } else { this.unk510 = false; this.unk514 = (t * 100) | 0; }
        if (t > 0) this.setTimer(this.unk514);
    }
    startDisappearTimer() { this.unk3F = 1; }
    startMoveTimer(t: number) { this.unk4A = 1; this.unk518 = (t * 100) | 0; }
    stopMoveTimer() { if (this.unk4A) this.unk4A = 0; }
    /** TGCConsole2's per-frame timer part (the disappear animation taken as one frame long) */
    consoleFrame() { if (this.unk3F) this.unk3F = 0; else if (this.unk4A) this.setTimer(-1); }
}

// ---------------------------------------------------------------- handles (a TNameRef* as an int)
class Handles {
    private list: NameRef[] = [];
    private of = new Map<NameRef, number>();
    get(o: NameRef | null): number {
        if (!o) return 0;
        let h = this.of.get(o);
        if (h === undefined) { this.list.push(o); h = (0x80400000 + this.list.length * 0x10) | 0; this.of.set(o, h); }
        return h;
    }
    obj(h: number): NameRef | null { if (!h) return null; const i = ((h - (0x80400000 | 0)) / 0x10) - 1; return this.list[i] ?? null; }
}

// ---------------------------------------------------------------- the event watchers and their group
/** TEventWatcher: one script */
export class EventWatcher extends NameRef {
    interp: SpcInterp | null = null;
    file = '';
    constructor(public world: World, public group: EventGroup, name = '<EventWatcher>') { super(name); }
    launchScript(file: string, data: Uint8Array | null) {
        this.file = file;
        if (!data) return;
        const b = new SpcBinary(data);
        b.init((bin) => initUserBuiltin(bin));
        const it = new SpcInterp(b, this, 0x20, 0x20, 0x20, 0x20);
        (it as EvInterp).ev = this;
        this.interp = it;
    }
    perform(cue: number) { if ((cue & CUE_MOVE) && this.interp) this.interp.update(); }
}

/** イベントグループ: the watchers, and what their builtins share */
export class EventGroup extends NameRef {
    watchers: EventWatcher[] = [];
    dir = new ScriptDirector();
    handles = new Handles();
    private cubes = new Map<string, CubeManager>();
    constructor(public world: World, public files: StageFiles | null) { super('イベントグループ'); }
    cube(table: string) {
        let c = this.cubes.get(table);
        if (!c) { c = CubeManager.fromTables(this.files ? this.files.scene('map/tables.bin') : null, table); this.cubes.set(table, c); }
        return c;
    }
    perform(cue: number) {
        // (the stopwatch stops during a talk: OSStopStopwatch at its start, talk.ts)
        if ((cue & CUE_MOVE) && !(this.world.talk && !this.world.talk.stopwatchOn)) this.dir.stopwatchTicks++;
        for (const w of this.watchers) w.testPerform(cue);
    }
    /** the frame's 2D part (the console's timer) */
    frame() { this.dir.consoleFrame(); }
}

declare module './engine.js' { interface World { eventGroup: EventGroup | null; } }
World.prototype.eventGroup = null;

/**
 * TMarDirector::setupObjects' event part: a watcher per .sb of /common/sp then /scene/map/sp
 * (JKRFileFinder: the folders' archive order). common.szs' sp folder holds sunglass.sb alone
 * (the sim's StageFiles has no folder listing for common.szs: commonFolder when the host gives it).
 */
export function installEventWatchers(w: World, files: StageFiles) {
    const g = new EventGroup(w, files);
    w.eventGroup = g;
    const add = (file: string, data: Uint8Array | null) => {
        const ew = new EventWatcher(w, g);
        ew.launchScript(file, data);
        g.watchers.push(ew);
    };
    const cf = (files as any).commonFolder as ((p: string) => string[]) | undefined;
    const common = cf ? cf.call(files, 'sp') : ['sunglass.sb'];
    for (const f of common) if (f.includes('.sb')) add('/common/sp/' + f, files.common('sp/' + f));
    for (const f of files.folder('map/sp')) if (f.includes('.sb')) add('/scene/map/sp/' + f, files.scene('map/sp/' + f));
    return g;
}

// ---------------------------------------------------------------- the builtins
type EvInterp = SpcInterp & { ev: EventWatcher };
type Ev = SpcBuiltin<EvInterp>;
const W = (it: EvInterp) => it.ev.world;
const G = (it: EvInterp) => it.ev.group;
const D = (it: EvInterp) => it.ev.group.dir;
/** verifyArgNum's in-place count */
const args = (it: EvInterp, want: number, n: number) => { const a = { n }; it.verifyArgNum(want, a); return a.n; };
const search = (it: EvInterp, name: string) => W(it).search(name);
/** a handle (an int popped) back to its object */
const byHandle = (it: EvInterp, s: SpcSlice) => G(it).handles.obj(s.getDataInt());
/** getNameRefPtr: a name or a handle */
function getNameRefPtr(it: EvInterp, s: SpcSlice): NameRef | null {
    if (s.type === SLICE_STRING) return search(it, s.getDataString());
    if (s.type === SLICE_INT) return byHandle(it, s);
    return null;
}
const any = (o: unknown) => o as any;
const call = (o: any, m: string, ...a: any[]) => (o && typeof o[m] === 'function' ? o[m](...a) : undefined);
const onLive = (o: any, f: number, on: boolean) => { if (!o) return; if (typeof o.onLiveFlag === 'function') { if (on) o.onLiveFlag(f); else o.offLiveFlag(f); } };
const checkLive = (o: any, f: number) => !!o && typeof o.checkLiveFlag === 'function' && o.checkLiveFlag(f);
const effect = (it: EvInterp, kind: string, p?: V3 | null) => W(it).effect(kind, p ? p.clone() : W(it).mario.pos.clone());
/** a builtin that only does presentation: its arguments, then its void result */
const noop = (want: number, what?: (it: EvInterp, a: SpcSlice[]) => void): Ev => (it, n) => {
    args(it, want, n);
    const a: SpcSlice[] = []; for (let i = 0; i < want; i++) a.unshift(it.pop());
    if (what) what(it, a);
    it.pushVoid();
};
const marioAny = (it: EvInterp) => W(it).mario as any;
const marioAngleY = (it: EvInterp) => { const m = marioAny(it); return m.mFaceAngle ? m.mFaceAngle.y | 0 : (m.faceAngle | 0); };
const talkModeNow = (w: World) => !!w.talkMode;
/** TMarDirector::getTalkingNPC (unkA0): the talk director's (talk.ts) when the player runs, else the scripts' own */
const talkingNPC = (it: EvInterp) => { const T = W(it).talk; return T ? T.unkA0 : D(it).talkingNPC; };
const forceStartTalk = (it: EvInterp, npc: NameRef | null) => { const T = W(it).talk; if (T) T.forceStartTalk(npc); else { D(it).talkingNPC = npc; D(it).unk126 = 1; } };
const demoModeNow = (w: World) => !!w.demoMode;
/**
 * gpItemManager / gpMapObjManager: found by what they do (mapobj/base.ts' mapObjGlobals can't be
 * imported here: mapobj/base.ts imports scene.ts, which imports this file)
 */
function manager(it: EvInterp, item: boolean): any {
    const g = G(it) as any;
    const key = item ? '_item' : '_mapobj';
    if (g[key] !== undefined) return g[key];
    let r: any = null;
    for (const o of W(it).byName.values()) {
        const a = o as any;
        if (typeof a.getObjNumWithActorType !== 'function') continue;
        const isItem = typeof a.makeShineAppearWithDemo === 'function';
        if (isItem === item) { r = a; break; }
    }
    g[key] = r;
    return r;
}
const itemManager = (it: EvInterp) => manager(it, true);
/** JGeometry::TVec3::length of a - b */
const dist3 = (a: V3, b: V3) => { const x = fr(a.x - b.x), y = fr(a.y - b.y), z = fr(a.z - b.z); return fr(Math.sqrt(fr(fr(fr(x * x) + fr(y * y)) + fr(z * z)))); };

const EV: Record<string, Ev> = {
    getSystemFlag: (it, n) => { args(it, 1, n); const id = it.pop().getDataInt(); it.pushInt(W(it).flags.getFlag(id)); },
    setSystemFlag: (it, n) => { args(it, 2, n); const v = it.pop(), f = it.pop(); W(it).flags.setFlag(f.getDataInt(), v.getDataInt()); it.pushVoid(); },
    getNameRefHandle: (it, n) => { args(it, 1, n); it.pushInt(G(it).handles.get(search(it, it.pop().getDataString()))); },
    getNameRefName: (it, n) => { args(it, 1, n); const o = byHandle(it, it.pop()); it.pushStr(o ? o.name : ''); },
    getNPCType: (it, n) => { args(it, 1, n); let r = -1; const npc = getNameRefPtr(it, it.pop()); if (npc) r = (any(npc).actorType - AT.NPC_MONTE_M) | 0; it.pushInt(r); },
    setFlagNPCDontTalk: (it, n) => { args(it, 2, n); const on = it.pop().getDataInt() !== 0; onLive(getNameRefPtr(it, it.pop()), LF_N_DONT_TALK, on); it.pushVoid(); },
    setFlagNPCDontThrow: (it, n) => { args(it, 2, n); const on = it.pop().getDataInt() !== 0; onLive(getNameRefPtr(it, it.pop()), LF_N_DONT_THROW, on); it.pushVoid(); },
    setFlagNPCDead: (it, n) => { args(it, 2, n); const on = it.pop().getDataInt() !== 0; onLive(getNameRefPtr(it, it.pop()), LF.DEAD, on); it.pushVoid(); },
    isNearSameActors: (it, n) => {
        args(it, 3, n);
        const first = getNameRefPtr(it, it.pop()) as HitActor | null;
        if (!first) { it.pushVoid(); return; }
        const type = first.actorType;
        const dist = it.pop().getDataFloat();
        const which = getNameRefPtr(it, it.pop()) as LiveActor | null;
        if (!which) { it.pushVoid(); return; }
        let count = 0;
        const mgr = manager(it, false);
        for (const o of (mgr?.objs ?? []) as HitActor[]) if (type === o.actorType && dist3(which.pos, o.pos) <= dist) count++;
        it.pushInt(count);
    },
    isNearActors: (it, n) => {
        let count = 0;
        const P = it.proc;
        if (n >= 3) {
            const which = getNameRefPtr(it, P.at(P.size - n)) as HitActor | null;
            if (which) {
                const dist = P.top(n - 2).getDataFloat();
                count = 1;
                for (let i = 2; i < n; i++) {
                    const o = getNameRefPtr(it, P.at(P.size - (n - i))) as HitActor | null;
                    if (o && dist3(which.pos, o.pos) <= dist) count++;
                }
            }
        }
        for (let i = 0; i < n; i++) it.pop();
        it.pushInt(count);
    },
    getTalkNPC: (it, n) => { args(it, 0, n); it.pushInt(G(it).handles.get(talkingNPC(it))); },
    getTalkNPCName: (it, n) => { args(it, 0, n); const npc = talkingNPC(it); it.pushStr(npc ? npc.name : ''); },
    // TTalk2D2::setMessageID(id, flags) (talk.ts; without the player's talk director, nothing)
    setTalkMsgID: (it, n) => {
        args(it, 2, n); const flags = it.pop().getDataInt(), id = it.pop().getDataInt();
        const T = W(it).talk; if (T) T.talk.setMessageID(id, flags);
        it.pushVoid();
    },
    // TTalk2D2::getTalkMode / getSelectedValue (a closed window's 0 without the talk director)
    getTalkMode: (it, n) => { args(it, 0, n); const T = W(it).talk; it.pushInt(T ? T.talk.getTalkMode() | 0 : 0); },
    getTalkSelectedValue: (it, n) => { args(it, 0, n); const T = W(it).talk; it.pushInt(T ? T.talk.getSelectedValue() : 0); },
    setValue2TalkVariable: noop(2),
    isTalkModeNow: (it, n) => { args(it, 0, n); it.pushBool(talkModeNow(W(it))); },
    setFlagNPCCanTaken: (it, n) => { args(it, 2, n); const on = it.pop().getDataInt(); onLive(search(it, it.pop().getDataString()), LF.UNK100000, !!on); it.pushVoid(); },
    pushNerve4LiveActor: (it, n) => {
        args(it, 2, n);
        const idx = it.pop().getDataInt(); const name = it.pop().getDataString();
        // TODO: the sim's nerves aren't indexed (NerveGetByIndex): no stage script calls this
        if (nerveName(idx) && search(it, name)) console.warn('[ev] pushNerve4LiveActor not ported', name, nerveName(idx));
        it.pushVoid();
    },
    isOnLiveActorFlag: (it, n) => { args(it, 2, n); const f = it.pop().getDataInt(); const a = any(getNameRefPtr(it, it.pop())); it.pushInt(a && typeof a.liveFlag === 'number' ? a.liveFlag & f : 0); },
    setHide4LiveActor: (it, n) => {
        args(it, 2, n); const v = it.pop().getDataInt(); const a = any(search(it, it.pop().getDataString()));
        if (a) { onLive(a, LF.HIDDEN, !!v); if (v) call(a, 'onHitFilter', HF.NO_COLLISION); else call(a, 'offHitFilter', HF.NO_COLLISION); }
        it.pushVoid();
    },
    setDead4LiveActor: (it, n) => {
        args(it, 2, n); const v = it.pop().getDataInt(); const a = any(search(it, it.pop().getDataString()));
        if (a) { onLive(a, LF.DEAD, !!v); if (v) call(a, 'onHitFilter', HF.NO_COLLISION); else call(a, 'offHitFilter', HF.NO_COLLISION); }
        it.pushVoid();
    },
    setTimeLimit: (it, n) => { args(it, 1, n); const t = it.pop().getDataInt(); D(it).stopwatchTicks = 0; D(it).unk120 = t; it.pushVoid(); },
    setAttentionTime: noop(1),
    setPollutionIncreaseCount: noop(1),
    getRestTime: (it, n) => { args(it, 0, n); it.pushInt(D(it).getRestTime()); },
    getPollutionLevel: (it, n) => { args(it, 0, n); const p = any(W(it).pollution); it.pushInt(p ? p.getPollutionDegree() | 0 : 0); },
    setNextStage: (it, n) => {
        args(it, 2, n); const sc = it.pop().getDataInt(), st = it.pop().getDataInt();
        const id = ((sc & 0xFF) + ((st + 1) << 8)) & 0xFFFF;
        call(W(it), 'setNextStage', id, null);
        W(it).events.push({ t: W(it).tickCount, kind: 'nextStage', data: { stage: id, p: W(it).mario.pos.clone(), name: it.ev.file } });
        it.pushVoid();
    },
    // fireStreamingMovie: the movie (and the stage change it brings)
    registerMovie: noop(1, (it, a) => W(it).events.push({ t: W(it).tickCount, kind: 'movie', data: { id: a[0].getDataInt() } })),
    // onFlag(DIRECTOR_FLAG_SHINE_GET_PENDING)
    gameOver: noop(0, (it) => W(it).events.push({ t: W(it).tickCount, kind: 'shineGetPending', data: {} })),
    isGraffitoCoverage0: (it, n) => { args(it, 0, n); const p = any(W(it).pollution); it.pushBool(!!p && (typeof p.cleanedAll === 'function' ? p.cleanedAll() : p.getPollutionDegree() === 0)); },
    setGraffitoMultiplied: (it, n) => {
        args(it, 1, n); const on = it.pop().getDataInt();
        const p = any(W(it).pollution);
        for (const L of (p?.layers ?? [])) call(L, on ? 'startSpread' : 'stopSpread');
        it.pushVoid();
    },
    isBossDefeated: (it, n) => { args(it, 0, n); it.pushBool(!!call(W(it).conductor, 'isBossDefeated')); },
    // the console's shine-get layout
    launchEventClearDemo: noop(0),
    isEMarioReachedToGoal: (it, n) => { args(it, 1, n); it.pushBool(!!call(getNameRefPtr(it, it.pop()), 'isReachedToGate')); },
    isEMarioDownWaitingToTalk: (it, n) => { args(it, 1, n); it.pushBool(!!call(getNameRefPtr(it, it.pop()), 'isDownWaitingToTalk')); },
    startEMarioRunAway: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'startRunAway')),
    startEMarioGateDrawing: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'startGateDrawing')),
    startEMarioDisappear: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'forceDisappear')),
    startOpenModelGate: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'startOpen')),
    isMapEventFinishedAll: (it, n) => { args(it, 1, n); it.pushBool(!!call(getNameRefPtr(it, it.pop()), 'isFinishedAll')); },
    raiseBuilding: noop(1, (it, a) => call(search(it, 'イベント（カゲマリオゲート）'), 'raiseBuilding', a[0].getDataInt())),
    forceCloseTalk: noop(0, (it) => { const T = W(it).talk; if (T) T.talk.forceCloseTalk(); }),
    insertTimer: (it, n) => {
        args(it, 2, n); const t = it.pop().getDataInt(), k = it.pop().getDataInt();
        if (k === 1) D(it).startAppearTimer(0, t); else if (k === 2) D(it).startAppearTimer(1, t); else D(it).startDisappearTimer();
        it.pushVoid();
    },
    startTimer: (it, n) => { args(it, 1, n); const t = it.pop().getDataInt(); D(it).startTimer(); D(it).startMoveTimer(t); it.pushVoid(); },
    startMonteman: (it, n) => { args(it, 1, n); const mm = search(it, 'モンテマン'); const id = it.pop().getDataInt(); if (mm) call(mm, 'startMonteReplay', id); it.pushVoid(); },
    stopTimer: noop(0, (it) => D(it).stopMoveTimer()),
    monteManReachFlag: (it, n) => { args(it, 0, n); it.pushBool(!!call(search(it, 'モンテマン'), 'isGoal')); },
    getTime: (it, n) => { args(it, 0, n); it.pushInt(D(it).unk4FC); },
    killShine: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'kill')),
    killMushroom1up: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'kill')),
    appearMushroom1up: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'appear')),
    appearShineFromNPC: (it, n) => {
        args(it, 3, n);
        const demo = it.pop().getDataString(), npcS = it.pop(), shine = it.pop().getDataString();
        const npc = getNameRefPtr(it, npcS) as LiveActor | null;
        const p = npc ? npc.pos : new V3();
        if (demo !== '') call(itemManager(it), 'makeShineAppearWithDemo', shine, demo, p.x, p.y, p.z);
        else { const s = any(search(it, shine)); if (s) { if (s.initialPos) s.initialPos.set(p); s.pos.set(p); call(s, 'appearWithTime', 1200, -1, -1, -1); } }
        it.pushVoid();
    },
    appearShine: (it, n) => {
        args(it, 2, n);
        const demo = it.pop().getDataString(), shine = it.pop().getDataString();
        if (demo !== '') call(itemManager(it), 'makeShineAppearWithDemoOffset', shine, demo, 0, 0, 0);
        else call(search(it, shine), 'appearWithTime', 1200, -1, -1, -1);
        it.pushVoid();
    },
    appearShineFromNPCWithoutDemo: (it, n) => {
        args(it, 2, n);
        const npcS = it.pop(), shine = it.pop().getDataString();
        const npc = getNameRefPtr(it, npcS) as LiveActor | null, s = any(search(it, shine));
        if (s && npc) { s.pos.set(npc.pos); call(s, 'makeObjAppeared'); }
        it.pushVoid();
    },
    appearShineFromKageMario: (it, n) => {
        args(it, 3, n);
        const t = it.pop().getDataInt(), from = it.pop().getDataString(), shine = it.pop().getDataString();
        const a = search(it, from) as HitActor | null, s = any(search(it, shine));
        if (s && a) { s.pos.set(a.pos); call(s, 'appearSimple', t); }
        it.pushVoid();
    },
    appearShineForWoodBox: (it, n) => {
        args(it, 1, n);
        const i = it.pop().getDataInt() ? 1 : 0;
        call(itemManager(it), 'makeShineAppearWithDemo', ['木箱ゲーム用シャイン１', '木箱ゲーム用シャイン２'][i], '木箱ゲーム用シャインカメラ', -4010, 9850, -4040);
        it.pushVoid();
    },
    changeNozzle: (it, n) => {
        args(it, 1, n);
        const id = it.pop().getDataInt(), m = marioAny(it);
        // TWaterGun::DivingHelmet (7, cmpwi r4, 7 @0x800e0700): setDivHelm (mare2.sb's changeNozzle(7) before the bottle demo)
        if (id === 7) call(m, 'setDivHelm'); else if (m.mWaterGun) call(m.mWaterGun, 'changeNozzle', id, true);
        it.pushVoid();
    },
    startMarioTalking: noop(0, (it) => call(marioAny(it), 'startTalking')),
    isInsideCube: (it, n) => {
        args(it, 1, n); const id = it.pop().getDataInt();
        const p = W(it).mario.pos.clone(); p.y = fr(p.y + 10);
        it.pushBool(G(it).cube('エリアキューブテーブル').isInCube(p, id));
    },
    setMarioWaiting: noop(0, (it) => call(marioAny(it), 'changePlayerStatus', MARIO_STATUS_WAIT, 0, true)),
    setTransScale: (it, n) => {
        args(it, 7, n);
        const tz = it.pop().getDataFloat(), ty = it.pop().getDataFloat(), tx = it.pop().getDataFloat();
        const sz = it.pop().getDataFloat(), sy = it.pop().getDataFloat(), sx = it.pop().getDataFloat();
        const o = any(getNameRefPtr(it, it.pop()));
        if (o) { call(o, 'makeObjAppeared'); call(o, 'changeObjSRT', new V3(sx, sy, sz), new V3(0, 0, 0), new V3(tx, ty, tz)); }
        it.pushVoid();
    },
    setEventID: (it, n) => { args(it, 2, n); const id = it.pop().getDataInt() & 0xFFFF; const o = any(getNameRefPtr(it, it.pop())); if (o) { if (typeof o.setEventId === 'function') o.setEventId(id); else o.eventId = id; } it.pushVoid(); },
    // the console's stars
    maniCoinFallDown: noop(0),
    startBGM: noop(1),
    eggYoshiStartFruit: noop(1, (it, a) => { const e = any(getNameRefPtr(it, a[0])); if (e && !checkLive(e, LF.DEAD)) call(e, 'startFruit'); }),
    putNozzle: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'put')),
    stopBGM: noop(1),
    startSE: noop(1),
    startEventSE: noop(1),
    startMiss: noop(0, (it) => call(marioAny(it), 'loserExec')),
    changeSunglass: (it, n) => {
        args(it, 1, n); const off = it.pop().getDataInt(); const m = marioAny(it);
        // TSunGlass::startFade (the screen fade) and the shirt's flag (Shine 0x77)
        if (!off) { call(m, 'wearGlass'); if (W(it).flags.getShineFlag(0x77)) call(m, 'onFlag', 0x10000); }
        else { call(m, 'takeOffGlass'); if (W(it).flags.getShineFlag(0x77)) call(m, 'offFlag', 0x10000); }
        it.pushVoid();
    },
    setCollision: (it, n) => { args(it, 2, n); const v = it.pop().getDataInt(); const a = any(getNameRefPtr(it, it.pop())); if (v) call(a, 'offHitFilter', HF.NO_COLLISION); else call(a, 'onHitFilter', HF.NO_COLLISION); it.pushVoid(); },
    warpMario: (it, n) => {
        args(it, 4, n);
        const ang = it.pop().getDataInt(), z = it.pop().getDataInt(), y = it.pop().getDataInt(), x = it.pop().getDataInt();
        call(marioAny(it), 'warpRequest', new V3(fr(x), fr(y), fr(z)), ang);
        it.pushVoid();
    },
    // the console's jet balloon / red coin counters
    startAppearJetBalloon: noop(2),
    appear8RedCoinsAndTimer: (it, n) => {
        args(it, 0, n);
        const sw = any(search(it, '赤コイン用スイッチ'));
        const t = sw ? sw.unk138 | 0 : 0;
        const im = itemManager(it);
        for (let i = 0; i < 8; i++) {
            const coin = any(call(im, 'makeObjAppeared', AT.COIN_RED));
            if (!coin) continue;
            call(coin, 'killByTimer', t - (coin.unk150 | 0));
            // (the coin's sparkle and disappear particles)
            effect(it, 'redCoinAppear', coin.pos);
        }
        D(it).startAppearTimer(1, Math.trunc(fr(t * fr(0.008333334))));
        D(it).startTimer();
        D(it).startMoveTimer(10);
        it.pushVoid();
    },
    warpFrontToMario: (it, n) => {
        args(it, 1, n);
        const a = any(byHandle(it, it.pop()));
        const ang = marioAngleY(it), m = W(it).mario.pos;
        // (the decomp's rotateY of (0, 0, 400) by Mario's angle)
        if (a) {
            a.pos.set(fr(m.x + fr(400 * JMASSin(ang))), m.y, fr(m.z + fr(400 * JMASCos(ang))));
            a.rot.y = fr(((((ang - 0x8000) << 16) >> 16) * 360) / 65536);
        }
        it.pushVoid();
    },
    // the console's READY / GO
    appearReadyGo: noop(0),
    onNeutralMarioKey: noop(0, (it) => { const pad = marioAny(it).mGamePad; call(pad, 'onNeutralMarioKey'); }),
    invalidatePad: noop(1, (it, a) => { const pad = marioAny(it).mGamePad; if (pad) pad.mDisabledFrames = a[0].getDataInt() & 0xFFFF; }),
    checkWoodBox: (it, n) => {
        args(it, 2, n); const hi = it.pop().getDataInt(), lo = it.pop().getDataInt();
        let count = hi - lo + 1;
        for (let i = lo; i <= hi; i++) { const o = search(it, woodBoxName(i)); if (o && checkLive(o, LF.DEAD)) count--; }
        it.pushInt(count);
    },
    refreshWoodBox: noop(2, (it, a) => { for (let i = a[0].getDataInt(); i <= a[1].getDataInt(); i++) call(search(it, woodBoxName(i)), 'appear'); }),
    killWoodBox: noop(2, (it, a) => { for (let i = a[0].getDataInt(); i <= a[1].getDataInt(); i++) call(search(it, woodBoxName(i)), 'makeObjDead'); }),
    startMareBottleDemo: noop(0, (it) => {
        const o = any(search(it, 'ＥＸビン'));
        if (!o) return;
        call(o.mactor, 'setBck', 'exbottle_bottle_in');
        const m = marioAny(it); m.pos.set(o.pos);
        // MARIO_STATUS_BOTTLE_IN (li r4, 0x1310 @0x800dfae0; 0x1336 is MARIO_STATUS_TALKING)
        call(m, 'changePlayerStatus', 0x1310, 0, true);
    }),
    isFinishMareBottleDemo: (it, n) => { args(it, 0, n); const o = any(search(it, 'ＥＸビン')); it.pushBool(!!(o && o.mactor && o.mactor.curAnmEndsNext(0, null))); },
    isInsideFastCube: (it, n) => {
        args(it, 2, n); const id = it.pop().getDataInt(), k = it.pop().getDataInt();
        const p = W(it).mario.pos.clone(); p.y = fr(p.y + 10);
        const t = ['高速Ａキューブテーブル', '高速Ｂキューブテーブル', '高速Ｃキューブテーブル'][k];
        it.pushBool(!!t && G(it).cube(t).isInCube(p, id));
    },
    setEventForWaterMelon: noop(1, (it, a) => call(getNameRefPtr(it, a[0]), 'startEvent')),
    isWaterMelonIsReached: (it, n) => {
        args(it, 1, n); const m = any(byHandle(it, it.pop()));
        let r = 0;
        if (m) { const dx = fr(-4660 - m.pos.x), dz = fr(12000 - m.pos.z); if (fr(fr(dx * dx) + fr(dz * dz)) <= 90000) r = 1; }
        it.pushInt(r);
    },
    // (EventWatcher.cpp binds no function to these two names; a script could only end in the void)
    setEventStart: (it, n) => { },
    setEventEnd: (it, n) => { },
};
/** ゲーム木箱NN (the buffer's ASCII digits: one below 10; '0' + i past 99 as the game's char math) */
const woodBoxName = (i: number) => 'ゲーム木箱' + (i < 10 ? String.fromCharCode(48 + i) : String.fromCharCode(48 + Math.trunc(i / 10)) + String.fromCharCode(48 + (i % 10)));

/** NpcEvent.cpp */
const NPC: Record<string, Ev> = {
    getAddressFromViewObjName: (it, n) => { args(it, 1, n); it.pushInt(G(it).handles.get(search(it, it.pop().getDataString()))); },
    checkCurNerve4Npc: (it, n) => checkNerve(it, n, false),
    checkLatestNerve4Npc: (it, n) => checkNerve(it, n, true),
    isNpcSinkBottom: (it, n) => { args(it, 1, n); it.pushBool(checkLive(byHandle(it, it.pop()), LF_N_SINK_BOTTOM)); },
    isGameModeNormal: (it, n) => { args(it, 0, n); it.pushBool(!talkModeNow(W(it)) && !demoModeNow(W(it))); },
    __forceStartTalk: (it, n) => {
        args(it, 1, n);
        let r = 0;
        if (canForceTalk(it)) { forceStartTalk(it, byHandle(it, it.pop())); r = 1; }
        else it.pop();
        it.pushInt(r);
    },
    __forceStartTalkExceptNpc: (it, n) => {
        args(it, 1, n);
        let r = 0;
        it.pop();
        if (canForceTalk(it)) { const d = search(it, 'ダミーＮＰＣ'); if (d) { forceStartTalk(it, d); r = 1; } }
        it.pushInt(r);
    },
    connectDummyNpc: (it, n) => {
        args(it, 1, n);
        let r = 0;
        const d = any(search(it, 'ダミーＮＰＣ'));
        if (d) { d.dummyConnect = byHandle(it, it.pop()); r = 1; } else it.pop();
        it.pushInt(r);
    },
    onTalkToDummyNpc: noop(0, (it) => { const d = any(search(it, 'ダミーＮＰＣ')); if (d) { onLive(d, LF.DEAD, false); onLive(d, LF.UNK40000, false); d.talkForbid = 120; } }),
    // the NPC's balloon (presentation)
    setNpcBalloonMessage: noop(3, (it, a) => effect(it, 'balloon:' + a[1].getDataInt(), any(byHandle(it, a[0]))?.pos)),
    setNpcTalkForbidCount: noop(2, (it, a) => { const npc = any(byHandle(it, a[0])); if (npc) npc.talkForbid = a[1].getDataInt() & 0xFFFF; }),
    npcDanceOn: noop(1, (it, a) => call(byHandle(it, a[0]), 'npcDanceIn')),
    npcDanceOffHappyOn: noop(1, (it, a) => { const npc = any(byHandle(it, a[0])); call(npc, 'offActionFlag', NA_DANCE); call(npc, 'npcHappyIn', 2); }),
    resetFruitNum: noop(1, (it, a) => call(byHandle(it, a[0]), 'reset')),
    getFruitNum: (it, n) => {
        args(it, 2, n); const k = it.pop().getDataInt(), b = byHandle(it, it.pop());
        const idx = [0, 4, 3, 1][k] ?? 0;
        it.pushInt(call(b, 'getFruitNum', idx) | 0);
    },
    setFruitType: noop(3, (it, a) => {
        const b = any(byHandle(it, a[0]));
        if (!b) return;
        b.unk150 = a[2].getDataInt() !== 0 ? ([AT.FRUIT_BANANA, AT.FRUIT_COCONUT, AT.FRUIT_PINE, AT.FRUIT_DURIAN][a[1].getDataInt()] ?? 0) : 0;
    }),
    fireStartDemoCamera: noop(1, (it, a) => { const name = a[0].getDataString(); effect(it, 'demo:' + name, null); const T = W(it).talk; if (T) T.fireStartDemoCamera(name); }),
    isDemoMode: (it, n) => { args(it, 0, n); it.pushBool(demoModeNow(W(it))); },
    checkMonteClear: (it, n) => {
        args(it, 1, n); const i = it.pop().getDataInt();
        const npc = any(search(it, 'モンテ' + i));
        it.pushBool(!!npc && !checkLive(npc, LF.UNK400000) && !!call(npc, 'isClean'));
    },
};
/** !isTalkOrDemoModeNow, SMS_IsMarioTouchGround4cm, and Mario not jumping */
function canForceTalk(it: EvInterp) {
    const w = W(it), m = marioAny(it);
    if (talkModeNow(w) || demoModeNow(w)) return false;
    const ground = typeof m.isTouchGround4cm === 'function' ? m.isTouchGround4cm() : true;
    const jumping = typeof m.checkStatusType === 'function' ? m.checkStatusType(MARIO_STATUS_FLAG_JUMPING) : false;
    return ground && !jumping;
}
/** CheckNerve4Npc_: the NPC's current (or latest) nerve against NerveGetByIndex's */
function checkNerve(it: EvInterp, n: number, latest: boolean) {
    args(it, 2, n);
    const idx = it.pop().getDataInt(); const npc = any(byHandle(it, it.pop()));
    const want = nerveName(idx);
    const sp = npc?.spine;
    const cur = sp ? (latest ? sp.getLatestNerve() : sp.current) : null;
    it.pushBool(cur ? cur.name === want : want === null);
}

/** TSpcTypedBinary<TEventWatcher>::initUserBuiltin (GMSJ01's list: no Monteman BGM builtins) */
function initUserBuiltin(b: SpcBinary) {
    for (const [k, f] of Object.entries(EV)) if (k !== 'setEventStart' && k !== 'setEventEnd') b.bindSystemDataToSymbol(k, f);
    for (const [k, f] of Object.entries(NPC)) b.bindSystemDataToSymbol(k, f);
}
