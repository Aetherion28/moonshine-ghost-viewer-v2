// v3: plays a trace in the game itself. The machine boots the user's DOL; when the logos end the
// application is sent into the recorded stage with the recorded flag manager, RNG seed and NPC phase; from
// then on the recorded pad is delivered at PADRead and the game runs its own code. Everything the trace
// recorded is checked as it happens, in the trace's order:
//   - every rand() call's caller and seed (so the first call that differs names the function that diverged),
//   - at every frame (before direct()): the seed, the director's state, the number of movement ticks, the pad,
//   - at every movement tick (before TMario::perform): the first 0x574 bytes of Mario, and his controller.
// The GPU results the game reads back (occlusion, the bath water's height) come from the trace.
import { Machine } from '../ppc/machine.js';
import { installHle, type Sym } from '../ppc/hle.js';
import type { VirtualDisc } from '../ppc/disc.js';
import { f32FromBits } from '../ppc/fpu.js';
import { TB_DIV } from '../ppc/cpu.js';
import { Ev, EV_NAMES, IN, MARIO_BYTES, type Trace, type TraceFrame, type TracePad, type TraceTick } from './trace.js';
import { Moonshine, ARENA_RESERVE, type Region } from './moonshine.js';

export interface GameAddrs {
    region: Region;
    app: number; procLoopHead: number; setupCall: number; directCall: number; directRet: number; setupObjectsCall: number;
    marioPerform: number; randRet: number; seed: number; npcPhase: number; flagMgr: number;
    gpMarDirector: number; gpMarioOriginal: number; gpMarioAddress: number; gpCamera: number; gpPollution: number; setupThread: number;
    PADRead: number; PADClamp: number; OSGetArenaLo: number; arenaLoVar: number;
    fbCamera: number; fbSilhouette: number; fbWater: number; fastTextCall: number;
    padStatus: number; padButton: number; padMStick: number; padSStick: number;
    /** after changeState's call to MSound::checkWaveOnAram (the stage's exit waits for it) */
    exitWaveRet: number;
    /** the goop's draws: TPollutionCounterLayer::countTexDegree (a layer's map, to be copied back), and
     *  TPollutionCounterObj::countObjDegree [address, size] (the objects' goop counted) */
    goopLayerDraw: number; goopObjDraw: [number, number];
    /** TMario::pulling, and the grab objects whose taking matrix their constructor leaves unset: [vtable, the matrix's offset] */
    marioPulling: number; unsetTakingMtx: [number, number][];
    /** the event scripts' interpreters: TEventWatcher::launchScript and where it has the new interpreter (r29); TSpcInterp::update,
     *  its step count (reached only while the lock word is 0) and the lock / unlock builtins */
    launchScript: number; launchScriptInterp: number; spcUpdate: number; spcCountStep: number; spcLock: number; spcUnlock: number;
    /** FLUDD's three calls of TModelWaterManager::emitRequest (TNozzleDeform::emit, TNozzleTrigger::emit, TNozzleBase::emit): the ones Moonshine records */
    waterCalls: number[];
    /** JKRExpHeap::alloc and JKRSolidHeap::alloc: each one's entry and its return */
    heapAllocs: [number, number][];
    /** TWaterGun's two copies of setEmitPt (in perform and init): the instruction after the three stores */
    emitPtDone: number[];
    /** TNerveTobiPukuGenerate's load of unk1D0.y (the Cheep Cheep in r30), and TNerveTobiPukuLand's compare of |dy| (f1) with 600 */
    pukuGenerateRead: number; pukuSinkTest: number;
    /** TMovieDirector's vtable, and the instruction after its direct() asks whether the setup thread has ended */
    movieVtable: number; movieThreadTest: number;
    /** TMarDirector::updateGameMode's test of the BGM handle a camera demo waits for (the handle in r3, the director in r31) */
    demoJingleTest: number;
    /** TJumpBase::control */
    jumpBaseControl: number; kuriTimer: number; kuriEndTest: number; cannonGoalRead: number;
    /** TBossMantaManager::TMantaBattleState::update, where it tests the all-Mantas-dead jingle's handle (in r0); gpMapObjManager */
    mantaJingleTest: number; gpMapObjManager: number;
    /** TShine's vtable and TShine::mUpSpeed (1 at boot; TShine::appearSimple leaves it 2 for the rest of the session) */
    shineVtable: number; shineUpSpeed: number;
}
/** GMSJ01 revision 0 */
export const JP10: GameAddrs = {
    region: 0,
    app: 0x803E6000, procLoopHead: 0x800FA1CC, setupCall: 0x800F9F70, directCall: 0x800F9B60, directRet: 0x800F9B74, setupObjectsCall: 0x800ECE3C,
    marioPerform: 0x8012C77C, randRet: 0x80085AE4, seed: 0x80408CF0, npcPhase: 0x8040A4A0, flagMgr: 0x8040A290,
    gpMarDirector: 0x8040A2A8, gpMarioOriginal: 0x8040A378, gpMarioAddress: 0x8040A398, gpCamera: 0x8040B370, gpPollution: 0x8040A5A8, setupThread: 0x803F2390,
    PADRead: 0x8009BF20, PADClamp: 0x8009B1A4, OSGetArenaLo: 0x8008DCBC, arenaLoVar: 0x80408D08,
    fbCamera: 0x80359CA4, fbSilhouette: 0x800C2D0C, fbWater: 0x801FABF0, fastTextCall: 0x8021530C,
    padStatus: 0x80400D50, padButton: 0x80400D80, padMStick: 0x80400E40, padSStick: 0x80400E80,
    exitWaveRet: 0x800ECAB4,
    goopLayerDraw: 0x801ECF38, goopObjDraw: [0x801EE5B0, 0x2D4],
    marioPulling: 0x8013DD68, unsetTakingMtx: [[0x803E083C, 0x80], [0x803D75E4, 0x74]],   // TBGTakeHit (a tentacle), TBGBeakHit
    launchScript: 0x800DC654, launchScriptInterp: 0x800DC6F0, spcUpdate: 0x80116F14, spcCountStep: 0x80116F88, spcLock: 0x8011C7CC, spcUnlock: 0x8011C6E8,
    waterCalls: [0x8014AC84, 0x8014B5AC, 0x8014C0D4], emitPtDone: [0x80148DD0, 0x80149F90],
    pukuGenerateRead: 0x802ADF70, pukuSinkTest: 0x802AD13C,
    movieVtable: 0x803B48D8, movieThreadTest: 0x8010ACF4, demoJingleTest: 0x800EB480, jumpBaseControl: 0x801D4E6C,
    kuriTimer: 0x802690B0, kuriEndTest: 0x80269118, cannonGoalRead: 0x802DF0A4,
    heapAllocs: [[0x8000A04C, 0x8000A18C], [0x8000D520, 0x8000D5CC]],
    mantaJingleTest: 0x80322E18, gpMapObjManager: 0x8040A4D0,
    shineVtable: 0x803C11E4, shineUpSpeed: 0x80409030,
};
const SPC = { stepsToDo: 4, stepsLeft: 0xC, locked: 0x14 };   // TSpcInterp
// offsets in the game's objects
const APP = { director: 4, state: 8, prev: 0xA, cur: 0xE, next: 0x12, movie: 0x18, pads: 0x20, heap: 0x40 };
const DIR = { demoFlags: 0x4E, pendingTime: 0x54, moveTicks: 0x58, ticks: 0x5C, state: 0x64, setupDone: 0x260 };
const STATE_STAGE_EXIT_2 = 12;
const CANNON_AIM = 0x248, SPINE_GOAL = 0xF8;   // TCannon::unk248; the point TSpineEnemy::setGoal writes (and again at +0x108)
// The bytes of Mario and of the camera that nothing has written when their first record is taken: padding, and
// what their constructors copy in from locals nobody set (the camera's three look-at records). Listed by
// tests/uninit.ts (STACK=1 OBJECTS=1), the same in every stage tried; a later stage's are the console's leftovers
// even where an earlier stage's happened to be equal.
const UNSET_AT_FIRST: Record<string, [number, number][]> = {
    mario: [[0xA, 0xB], [0xE, 0xF], [0x1E, 0x1F], [0x152, 0x153], [0x38A, 0x38B], [0x47E, 0x47F], [0x482, 0x483], [0x492, 0x493], [0x519, 0x51B], [0x521, 0x521], [0x525, 0x525], [0x52D, 0x52F]],
    camera: [[0xA, 0xB], [0xE, 0xF], [0x1E, 0x1F], [0x26, 0x27], [0x66, 0x67], [0xAC, 0xB3], [0xE0, 0xE7], [0x114, 0x11B], [0x25A, 0x25B], [0x2CD, 0x2CF]],
};
// THamuKuri: unk1A8 (the look-around timer), its parameters and mSLKyoroTimer's value in them; TLiveActor's current BCK and mAnmSoundPath;
// its turn (mRotation.y) and TSpineEnemy::unk128 (s16: the ticks walked toward the current node)
const KURI = { timer: 0x1A8, params: 0x1F4, kyoroTimer: 0x440, bck: 0x15C, walk: 14, look: 4, soundPath: 0x84, rotY: 0x34, walked: 0x128, mactor: 0x74 };
// MActor::mAnmBck; an MActorAnm's frame control: mEnd, mRate, mFrame
const MACTOR_BCK = 0x0C, ANM = { end: 0x0C, rate: 0x10, frame: 0x14 };
const RUN_ASSISTED = 1;   // a trace's run flags: Moonshine's practice session took part
// TMarioGamePad: the scalar spans Moonshine compares (buttons, the two sticks, the meanings and analog state)
const PAD_SPANS: [number, number][] = [[0x18, 0x30], [0x48, 0x10], [0x58, 0x10], [0xA8, 58]];
// ... and with its mode state (flags, the stick timer, the disabled frames): what a pad carries from before the recording
const PAD_STATE: [number, number][] = [[0x18, 0x50], [0xA8, 0x44]];
// the words Moonshine zeroes while its own interface owns the pad (suppressRetailPad)
const PAD_SUPPRESS = [0x18, 0x1C, 0x20, 0x30, 0xD0, 0xD4, 0xD8];
const MARIO_PAD = 0x4FC, MARIO_WORK = 0x108;   // TMario::mGamePad, its TMarioControllerWork
const TAKE_HELD = 0x6C, MARIO_STATUS = 0x7C, MARIO_FACE_ANGLE_Y = 0x96;   // TTakeActor::mHeldObject, TMario::mStatus, mFaceAngle.y
const STATUS_PULLING = 0x560, STATUS_OIL_PULLING = 0x40561;
const MARIO_SOUND = 0x4E4;   // TMario::mSound, the JAISound of his damage voice: only started and stopped
const MARIO_FLAGS = 0x118;   // TMario::mFlags; bit 0 is MARIO_FLAG_OCCLUDED, written from the GPU's draw-sync callback

export interface Issue { kind: string; frame: number; tick: number; text: string }
export interface ReplayOptions {
    log?: (s: string) => void;
    /** the game's console (OSReport) */
    report?: (s: string) => void;
    /** stop at the first issue of these kinds (default: rand, mario, flow) */
    stopOn?: string[];
    maxIssues?: number;
    /** bytes the console's file system table was bigger than this disc's (see `heapDelta`) */
    fstPad?: number;
    /** Moonshine's Shiny Shines setting (not recorded: see `layoutDelta`) */
    shinyShines?: boolean;
    /** the doubts to take the other way (not recorded: see `scriptDoubts`): event scripts (file names) whose interpreter starts with a lock word that isn't 0, a trampoline (`TJumpBase@address`) whose state timer isn't */
    scriptsLocked?: string[];
    /**
     * The doubts a driver has already taken the other way. With it, a replay stops a few frames after its first
     * difference when an untried doubt lies before it (`cutShort`): the driver boots again with that doubt the
     * other way instead of playing this one to its end first.
     */
    tried?: Set<string>;
    /** told of every block the heaps give out (a tool's: tests/uninit.ts) */
    onAlloc?: (ptr: number, size: number) => void;
}

const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0');

export class Replay {
    m = new Machine();
    moonshine: Moonshine;
    issues: Issue[] = [];
    phase: 'boot' | 'stage' | 'done' = 'boot';
    /** counts of what matched */
    stages = 1; frames = 0; ticks = 0; private stageTicks = 0; calls = 0; literals = 0; marioChecked = 0; extraLoadFrames = 0; shimCalls = 0;
    /** the stage's archive (bianco0, ...) and the Moonshine settings on in it that are not reproduced */
    stageName = ''; unsupported: string[] = [];
    /** frames and ticks at which the pad object had to be set to the recording's (Moonshine had changed it) */
    padCorrections = 0; exitAligned = 0;
    private session: Uint8Array = new Uint8Array(64);
    /**
     * Mario's address here minus the recording's, at his first record (0: the stage's heap is laid out as the
     * console's). Not 0: something the trace doesn't record loaded other models; Shiny Shines is the known one.
     */
    layoutDelta = 0;
    fstPadUsed = 0;
    scriptsLocked: string[] = [];
    /**
     * TSpcInterp's constructor never writes the lock word (+0x14), so an event script starts with whatever the
     * console's heap had there: 0 (each update runs 0x20 instructions) or not (each runs to the script's yield),
     * until the script calls lock or unlock. Listed here: the scripts for which that decided what an update did
     * (it ran out of its 0x20, or ran past them), with the frame it first did. The trace doesn't record the word.
     */
    scriptDoubts: { script: string; frame: number; locked: boolean }[] = [];
    /** stopped a few frames after its first difference, for a doubt before it to be tried the other way (see ReplayOptions.tried) */
    cutShort = false;
    private tried: Set<string> | undefined; private cutAt = 0;
    /** the stage heap's size here minus the recording's (0: the same arena) */
    heapDelta = 0;
    /** instructions at the stage's start and at its first frame after setup */
    countAtStage = 0; countAtPlay = 0;
    private iFlow = 0; private iCall = 0; private lastCall = -1;
    private strict = false;
    private curFrame: TraceFrame | null = null; private curFrameIndex = -1; private curTick = 0; private curTickIndex = -1; private between = 0;
    private observations = 0; private noWater = false;
    private padAdopted = false; private adopted = new Set<string>(); private otherHandle = false;
    /** the recording's actors as of the current frame (by Moonshine's id), and how the comparison went */
    private actors = new Map<number, { ptr: number; data: Uint8Array; dv: DataView }>();
    private actorScene = -1;
    actorsChecked = 0; actorWordsOff = 0; private actorsOff = new Set<string>();
    /** water requests compared with the recording's, and how many differed */
    waters = 0; watersOff = 0; private iWater = 0;
    private frozenState = -1; private suppressed: number[] | null = null; private suppressedPad = 0;
    private stopOn: Set<string>; private maxIssues: number;
    private log: (s: string) => void;
    private modLo = 0; private modHi = 0;

    constructor(dol: Uint8Array, disc: VirtualDisc, private T: Trace, private A: GameAddrs, sym: Sym, opt: ReplayOptions = {}) {
        const m = this.m, cpu = m.cpu;
        this.log = opt.log ?? (() => { });
        this.stopOn = new Set(opt.stopOn ?? ['heap', 'layout', 'rand', 'mario', 'camera', 'flow', 'stage', 'unrecorded']); this.maxIssues = opt.maxIssues ?? 50;
        this.fstPadUsed = opt.fstPad ?? 0;
        m.load(dol, disc, this.fstPadUsed);
        const missing = installHle(m, sym, { report: opt.report });
        if (missing.length) this.log('hle: not found: ' + missing.join(', '));
        this.moonshine = new Moonshine(m, A.region, A);
        this.moonshine.shinyShines = !!opt.shinyShines;
        this.moonshine.install();
        disc.onOpen = (path) => {
            const mm = /scene\/([A-Za-z0-9_]+)\.szs$/i.exec(path);
            if (!mm || this.phase !== 'stage' || this.stageName) return;
            this.stageName = mm[1];
            this.unsupported = this.moonshine.unsupported(this.session, this.stageName);
            this.log(`stage ${this.stageName}` + (this.unsupported.length ? `; Moonshine settings on that are not reproduced here: ${this.unsupported.join(', ')}` : ''));
        };
        cpu.hook(A.PADRead, (c) => this.padRead(c));
        cpu.hook(A.PADClamp, () => { });
        cpu.hook(A.procLoopHead, (c) => { this.atProcLoop(c.gpr[31]); return false; });
        cpu.hook(A.setupCall, () => { this.moonshine.beforeStageSetup(); this.atSetup(); return false; });
        cpu.hook(A.directCall, (c) => this.beforeDirect(c));
        cpu.hook(A.directRet, (c) => {
            this.afterDirect(c);
            const sent = this.moonshine.afterDirect(c, A.directRet);
            if (!sent) this.moonshine.practiceFrozen = false;
            if (sent && this.moonshine.regrabs === 1) this.log(`frame ${this.curFrame ? this.curFrame.frame : 0}: Moonshine's Regrab Last Held Object (the pad holds X and D-pad up): Mario's status set to TAKE and the object he held last sent the take message`);
            return sent;
        });
        cpu.hook(A.marioPerform, (c) => { if ((c.gpr[4] & 1) && this.phase === 'stage' && c.gpr[3] === m.mem.r32(A.gpMarioOriginal)) this.atTick(c.gpr[3], c.gpr[4]); return false; });
        cpu.hook(A.randRet, (c) => { if (this.phase === 'stage') this.atRand(c.lr); return false; });
        cpu.hook(A.marioPulling, (c) => { if (this.phase === 'stage') this.unsetTakingMtx(c.gpr[3]); return false; });
        // Each block the stage allocates is kept as the heap gives it out: what an object's constructor doesn't write stays so (see `unset`)
        const asked = new Map<number, number>(), THREAD = 0x800000E4;
        for (const [enter, leave] of A.heapAllocs) {
            cpu.hook(enter, (c) => { asked.set(mem.r32(THREAD), c.gpr[4]); return false; });
            cpu.hook(leave, (c) => {
                const t = mem.r32(THREAD), n = asked.get(t), p = c.gpr[3];
                asked.delete(t);
                if (!n || p < 0x80000000 || p + n > 0x81800000) return false;
                if (opt.onAlloc) opt.onAlloc(p, n);
                if (this.phase === 'stage' && n <= 0x8000) this.allocSnap.set(p, mem.bytes(p, n).slice());
                return false;
            });
        }
        // FLUDD's water requests: what a nozzle asks of the water manager (its place, direction, power) against the recording's
        for (const call of A.waterCalls) {
            cpu.hook(call, (c) => { if (this.phase === 'stage') this.atWater(c.gpr[4]); return false; });
            cpu.hook(call + 4, (c) => { if (this.phase === 'stage' && this.waterNow) { if ((c.gpr[3] & 0xFF) !== (this.waterNow.accepted & 0xFF)) this.waterOff(`the water manager's answer is ${c.gpr[3] & 0xFF}, the trace's ${this.waterNow.accepted & 0xFF}`); this.waterNow = null; } return false; });
        }
        // FLUDD's emit positions are copied out of its nozzle's joint matrices. A nozzle Mario isn't using is never
        // posed, so its matrices are still the heap's leftovers (zeros here): then the positions are the recording's.
        for (const at of A.emitPtDone) cpu.hook(at, (c) => { if (this.phase === 'stage' && c.gpr[3]) this.unsetEmitPos(c.gpr[3], c.gpr[4] + 0x1C90); return false; });
        // A Cheep Cheep's first dive. TTobiPuku's constructor never sets unk1D0 (+0x1D0). A new one runs its Generate
        // nerve once as it appears, which adds unk1D0.y to its height, before the launch pad's forceLaunch sets unk1D0;
        // forceLaunch's reset() keeps that height (unk1E0), and the dive after its first flight ends once it is more than
        // 600 from it. So the depth of each one's first dive is the heap's leftovers: where they are zeros here, the
        // recording says in which tick the dive ends (the actor's height at the recorder's next samples).
        cpu.hook(A.pukuGenerateRead, (c) => { const p = c.gpr[30]; if (this.phase === 'stage' && !mem.r32(p + 0x1DC) && !mem.r32(p + 0x1D0) && !mem.r32(p + 0x1D4) && !mem.r32(p + 0x1D8)) this.unsetPukus.add(p); return false; });
        cpu.hook(A.pukuSinkTest, (c) => { if (this.phase === 'stage' && this.unsetPukus.has(c.gpr[30])) this.pukuDives(c); return false; });
        // A Goomba's look-around timer (THamuKuri::unk1A8, +0x1A8) is never set by its constructor. While it wanders,
        // moveObject adds 1 to it each tick, and past mSLKyoroTimer (500) clears it and starts the look-around
        // animation (BCK 4), in which the Goomba doesn't walk; the animation's end starts the walk again. On the
        // console the timer starts at what the heap had there (the same Goomba's timer of an earlier attempt, as the
        // recordings show: 391, 455, 252 in one stage), so its first look-arounds come when the recording says:
        // - walking, it looks around in the tick from which the recorded Goomba no longer turns or counts its walk
        //   and has the look-around's animation (mAnmSoundPath, +0x84, is null); from then on the timer is the game's own;
        // - looking around already, a look-around starts the animation again. The animation advances once a frame, so
        //   that shows as the frame in which it ends (the recorded Goomba walks again), and in what the Goombas
        //   stacked on it do; which tick of the frame it was doesn't show, so the timer stays the recording's.
        cpu.hook(A.kuriTimer, (c) => {
            if (this.phase !== 'stage') return false;
            const p = c.gpr[31];
            let open = this.kuris.get(p);
            if (open === undefined) {
                open = true;
                for (let k = 0; k < 4; k++) if (!this.unset(p, KURI.timer + k, mem.r8(p + KURI.timer + k))) open = false;
                this.kuris.set(p, open);
                if (open && !this.kuriSaid) { this.kuriSaid = true; this.log(`tick ${this.curTick}: a Goomba's look-around timer is the heap's leftovers (THamuKuri::unk1A8 is never set): when it first looks around is taken from the recording`); }
            }
            if (!open) return false;
            const looks = this.kuriLooksAround(p);
            // (the game adds 1 and compares with mSLKyoroTimer)
            mem.w32(p + KURI.timer, looks ? mem.r32(mem.r32(p + KURI.params) + KURI.kyoroTimer) : 0);
            if (looks === 1) this.kuris.set(p, false);
            return false;
        });
        cpu.hook(A.kuriEndTest, (c) => {
            const p = c.gpr[31];
            if (this.phase === 'stage' && c.gpr[3] && this.kuris.get(p) && this.kuriStillLooks(p)) c.gpr[3] = 0;
            return false;
        });
        // Noki Bay's cannon aims a shot with setGoal(unk248) (TCannon::setKillerGoalPoint), and unk248 (+0x248) is only
        // set as a shot is fired: its first shot aims at what the heap had there (on the console the point an earlier
        // attempt's cannon left: the recorded goal stays the constructor's). The goal the recorded cannon has at the
        // next sample is that point.
        cpu.hook(A.cannonGoalRead, (c) => {
            const p = c.gpr[31];
            if (this.phase !== 'stage') return false;
            for (let k = 0; k < 12; k++) if (!this.unset(p, CANNON_AIM + k, mem.r8(p + CANNON_AIM + k))) return false;
            const id = this.actorIdAt(p), F = this.curFrameIndex;
            if (id < 0) return false;
            const goal = [0, 4, 8].map((k) => this.actorWordAhead(id, SPINE_GOAL + k, F + 1));
            if (goal.some((w) => w === null)) return false;
            goal.forEach((w, k) => mem.w32(p + CANNON_AIM + k * 4, w!));
            this.log(`frame ${this.curFrame ? this.curFrame.frame : 0}: the cannon at ${hex(p)} aims its first shot at a point nothing has set (TCannon::unk248, the heap's leftovers): taken from the recording's goal (${goal.map((w) => f32FromBits(w!)).join(', ')})`);
            return false;
        });
        // A camera demo ends when its frames are over and the jingle that plays with it has ended (BGM handle 2 is
        // null again), or after 720 ticks. No sound runs here, so the handle is null at once. A Shine's appear demo
        // stops the world (only the Shine moves, Mario has no ticks), so the recording shows the tick the demo ends in:
        // the one after which its movement ticks start again. (Sirena Beach 6: one tick after the camera's frames.)
        cpu.hook(A.demoJingleTest, (c) => {
            const d = c.gpr[31];
            if (this.phase !== 'stage' || !(mem.r16(d + DIR.demoFlags) & 1)) return false;
            const ends = this.worldMovesAgain(Math.floor((mem.r32(d + DIR.pendingTime) | 0) / 5));
            if (ends !== (c.gpr[3] === 0) && !this.demoSaid) { this.demoSaid = true; this.log(`tick ${this.curTick}: a Shine's appear demo ends with its jingle as in the recording (the sound doesn't run here)`); }
            c.gpr[3] = ends ? 0 : 1;
            return false;
        });
        // A movie between two stages (see planMovie): its loading is the disc's, so the setup thread counts as ended
        // from the frame that makes the movie end where the recording's does
        cpu.hook(A.movieThreadTest, (c) => { if (this.phase === 'stage' && this.movieFrame && this.movieFrame < this.movieLoaded && c.gpr[3]) c.gpr[3] = 0; return false; });
        // A sound the game waits for. Manta Storm's hotel rises when the all-Mantas-dead jingle has ended (its handle
        // is null again): no sound runs here, so the handle reads as the recording shows it: null in the tick
        // before the one in which the recording makes the hotel's particles (the event's watch runs a tick after
        // the Mantas' manager has seen the handle null, and the particles are the first thing the rising does).
        cpu.hook(A.mantaJingleTest, (c) => { if (this.phase === 'stage' && this.T.particles.length) { const now = this.hotelRisesNow(); if (now !== (c.gpr[0] === 0) && !this.jingleSaid) { this.jingleSaid = true; this.log(`tick ${this.curTick}: the hotel waits for the jingle's end as in the recording (the sound doesn't run here)`); } c.gpr[0] = now ? 0 : 1; } return false; });
        // the event scripts' lock words (see scriptDoubts)
        this.scriptsLocked = opt.scriptsLocked ?? []; this.tried = opt.tried;
        const unset = new Map<number, string>(), locked = new Set(opt.scriptsLocked ?? []), mem = m.mem;
        let script = '', steps = 0;
        const doubt = (it: number, isLocked: boolean) => {
            const name = unset.get(it)!; unset.delete(it);
            this.scriptDoubts.push({ script: name, frame: this.curFrame ? this.curFrame.frame : 0, locked: isLocked });
            this.log(`frame ${this.curFrame ? this.curFrame.frame : 0}: ${name}'s interpreter ${isLocked ? 'runs past' : 'stops at'} its 0x20 instructions on a lock word its constructor never set (taken as ${isLocked ? 'not 0' : '0'})`);
        };
        cpu.hook(A.launchScript, (c) => { script = ''; for (let a = c.gpr[4], b; (b = mem.r8(a)) && script.length < 64; a++) script += String.fromCharCode(b); return false; });
        cpu.hook(A.launchScriptInterp, (c) => { const it = c.gpr[29]; if (it) { unset.set(it, script); mem.w32(it + SPC.locked, locked.has(script) ? 1 : 0); } return false; });
        cpu.hook(A.spcLock, (c) => { unset.delete(c.gpr[3]); return false; });
        cpu.hook(A.spcUnlock, (c) => { unset.delete(c.gpr[3]); return false; });
        cpu.hook(A.spcUpdate, () => { steps = 0; return false; });
        cpu.hook(A.spcCountStep, (c) => { const it = c.gpr[30]; if (unset.size && unset.has(it) && mem.r32(it + SPC.stepsLeft) === 1) doubt(it, false); return false; });
        cpu.hook(A.spcCountStep - 12, (c) => { const it = c.gpr[30]; if (unset.size && unset.has(it) && mem.r32(it + SPC.locked) !== 0 && ++steps > mem.r32(it + SPC.stepsToDo)) doubt(it, true); return false; });
        // The trampoline's state timer, a doubt of the same kind. TJumpBase's constructor sets its state (2: being set
        // down) and not the state's timer (unk13C, +0x13C); a state's first control() starts its animation only if the
        // timer is 0, and afterwards the timer only counts. So what matters is whether the leftover was 0 (as here) or not.
        cpu.hook(A.jumpBaseControl, (c) => {
            const p = c.gpr[3];
            if (this.phase !== 'stage' || this.jumpBases.has(p)) return false;
            this.jumpBases.add(p);
            for (let k = 0; k < 4; k++) if (!this.unset(p, 0x13C + k, mem.r8(p + 0x13C + k))) return false;
            const key = `TJumpBase@${hex(p)}`, other = locked.has(key);
            if (other) mem.w32(p + 0x13C, 1);
            this.scriptDoubts.push({ script: key, frame: this.curFrame ? this.curFrame.frame : 0, locked: other });
            this.log(`frame ${this.curFrame ? this.curFrame.frame : 0}: the trampoline at ${hex(p)} starts on a state timer its constructor never set (taken as ${other ? 'not 0' : '0'})`);
            return false;
        });
        // A stage ends when the screen has faded out and the sound's wave data has come off the disc: how long the
        // disc takes is the console's, so the answer is the recording's (did it leave after this frame?).
        cpu.hook(A.exitWaveRet, (c) => {
            if (this.phase !== 'stage') return false;
            const leave = this.recordingLeavesNow() ? 1 : 0;
            if (((c.gpr[3] & 0xFF) ? 1 : 0) !== leave) { c.gpr[3] = leave; if (!this.exitAligned++) this.log(`frame ${this.curFrame ? this.curFrame.frame : 0}: the stage's exit aligned to the recording's (the sound's wave data ${leave ? 'had not' : 'had already'} loaded here)`); }
            return false;
        });
        // The goop maps are drawn on the GPU and read back (ppc/gx.ts): what the game draws in these two functions is
        // rasterised (a layer's pass ends with the frame buffer's copy into its map; the objects' count with the function).
        cpu.hook(A.goopLayerDraw, () => { m.hw.gx.mark(m.hw.streamPos(), true, true); return false; });
        cpu.hook(A.goopObjDraw[0], () => { m.hw.gx.mark(m.hw.streamPos(), true); return false; });
        for (let a = A.goopObjDraw[0]; a < A.goopObjDraw[0] + A.goopObjDraw[1]; a += 4) if (m.mem.r32(a) === 0x4E800020) cpu.hook(a, () => { m.hw.gx.mark(m.hw.streamPos(), false); return false; });
        m.hw.gxUnsupported = (what) => this.issue('gpu', `the goop's drawing needs ${what}, which the GPU model here doesn't do`);
        cpu.hook(A.fbCamera, (c) => { const v = this.literal(A.fbCamera + 4); if (v !== null) c.gpr[0] = v; return false; });
        cpu.hook(A.fbSilhouette, (c) => { const v = this.literal(A.fbSilhouette + 4); if (v !== null) c.gpr[0] = v; return false; });
        // (the bath water's height is recorded only by newer Moonshines: observation bit 2)
        cpu.hook(A.fbWater, (c) => {
            if (!(this.observations & 4)) { if (this.phase === 'stage' && !this.noWater) { this.noWater = true; this.issue('unrecorded', "the game reads the bath water's height from the GPU, and this trace doesn't record it"); } return false; }
            const v = this.literal(A.fbWater + 4); if (v !== null) { const f = f32FromBits(v); c.ps0[1] = f; c.ps1[1] = f; } return false;
        });
    }

    /** Runs until the trace ends, an issue stops it, or `budget` more instructions have run. */
    run(budget: number): 'done' | 'budget' {
        this.m.run(this.m.cpu.count + budget);
        return this.phase === 'done' ? 'done' : 'budget';
    }

    // ---------------------------------------------------------------- reporting
    private issue(kind: string, text: string) {
        const f = this.curFrame;
        if (this.issues.length < this.maxIssues) this.issues.push({ kind, frame: f ? f.frame : 0, tick: this.curTick, text });
        if (this.issues.length === 1 && this.tried && this.scriptDoubts.some((d) => d.frame <= (f ? f.frame : 0) && !this.tried!.has(d.script))) this.cutAt = this.frames + 8;
        this.log(`[${kind}] frame ${f ? f.frame : 0} tick ${this.curTick}: ${text}`);
        if (this.stopOn.has(kind) || this.issues.length >= this.maxIssues) this.stop();
    }
    private stop() { this.phase = 'done'; this.m.cpu.brk = true; }

    // ---------------------------------------------------------------- the trace's cursors
    private isCall(i: number) { const k = this.T.kind[i]; return k === Ev.RAND || k === Ev.LIT; }
    private nextCallFrom(i: number) { const T = this.T; while (i < T.n && !this.isCall(i)) i++; return i; }
    private nextFlowFrom(i: number) { const T = this.T; while (i < T.n && this.isCall(i)) i++; return i; }
    /** A frame or a tick is being consumed at event `ev`: every earlier rand call must have happened, and no later one. */
    private checkCalls(ev: number, what: string) {
        if (!this.strict) return;
        if (this.iCall < ev) {
            let missed = 0; for (let i = this.iCall; i < ev; i++) if (this.isCall(i)) missed++;
            const i = this.iCall;
            this.iCall = this.nextCallFrom(ev);
            this.issue('rand', `the game reached ${what} without ${missed} recorded call(s); the first is ${EV_NAMES[this.T.kind[i]]} from ${hex(this.T.a[i])}`);
        } else if (this.lastCall > ev) {
            this.issue('rand', `the game made a call the trace has after ${what}: ${hex(this.T.a[this.lastCall])}`);
        }
    }

    /** Does the trace start another stage before its next frame? */
    private recordingLeavesNow() {
        const T = this.T;
        // (it left if the next thing is a stage's start, or a frame without a stage director: a movie, a menu)
        for (let i = this.iFlow; i < T.n; i++) { const k = T.kind[i]; if (k === Ev.STAGE) return true; if (k === Ev.FRAME) return T.frames[T.a[i]].state === -1; if (k === Ev.PAD) return false; }
        return false;
    }

    // ---------------------------------------------------------------- the stage's start
    private atProcLoop(app: number) {
        const mem = this.m.mem, T = this.T;
        if (this.phase !== 'boot' || mem.r8(app + APP.state) !== 4) return;
        const st = T.stages[0], w = st.words;
        const seq = (o: number, v: number) => { mem.w8(app + o, v >>> 24); mem.w8(app + o + 1, (v >>> 16) & 0xFF); mem.w16(app + o + 2, v & 0xFFFF); };
        mem.w8(app + APP.state, 5);
        seq(APP.prev, w[3]); seq(APP.cur, w[4]); seq(APP.next, w[5]);
        mem.w32(app + APP.movie, w[15]);
        mem.ram.set(st.flags, mem.r32(this.A.flagMgr) & 0x01FFFFFF);
        this.session = st.session ?? new Uint8Array(64);
        this.moonshine.apply(this.session);
        this.modLo = this.moonshine.base; this.modHi = this.modLo + ARENA_RESERVE;
        this.log(`the logos ended at ${(this.m.cpu.count / 486e6).toFixed(2)} s: starting scene ${hex(w[4])} (from ${hex(w[3])})`);
    }
    private atSetup() {
        const mem = this.m.mem, A = this.A, T = this.T;
        const heap = mem.r32(A.app + APP.heap), start = mem.r32(heap + 0x30), end = mem.r32(heap + 0x34), head = mem.r32(heap + 0x6C), tail = mem.r32(heap + 0x70);
        if (this.phase === 'boot') {
            if (mem.r8(A.app + APP.state) !== 5) return;
            const st = T.stages[0], w = st.words;
            // (the NPC phase is a function's static: its guard byte, right after it, says it was initialised.
            // On a console that has run a stage with NPCs it is set; here it isn't yet, and the first NPC would zero the phase.)
            mem.w32(A.seed, w[6]); mem.w32(A.npcPhase, st.npcPhase); mem.w8(A.npcPhase + 4, 1);
            this.adoptShineSpeed();
            // the stage heap as the recording had it: the same size means the same arena
            if ((w[1] & 2) && (end - start !== w[11] || head - start !== w[9] || end - tail !== w[10])) {
                // the arena's top depends on the disc's file table, and the recording console's disc had other files:
                // the difference is what `fstPad` must be for the heap to be the recording's
                this.heapDelta = (end - start) - w[11];
                this.issue('heap', `the stage heap is ${hex(end - start)} bytes (used ${hex(head - start)} / ${hex(end - tail)}), the trace's ${hex(w[11])} (${hex(w[9])} / ${hex(w[10])})`);
                if (this.phase === 'done') return;
            }
            // The stage heap is not cleared between stages: on the console it holds the previous stage's leftovers,
            // here the logos'. Neither is knowable, so it starts as zeros, and what the recording shows of
            // uninitialised memory is taken from it (compareBlob).
            mem.ram.fill(0, head & 0x01FFFFFF, tail & 0x01FFFFFF);
            this.phase = 'stage'; this.countAtStage = this.m.cpu.count;
            this.observations = st.observations;
            this.iFlow = this.nextFlowFrom(st.ev + 1); this.iCall = this.nextCallFrom(st.ev + 1);
            return;
        }
        if (this.phase !== 'stage') return;
        // a later stage of the same recording: the game got here by itself, so its state should be the recorded one
        const i = this.iFlow;
        if (i >= T.n || T.kind[i] !== Ev.STAGE) { this.issue('flow', `the game starts a stage where the trace has ${i >= T.n ? 'ended' : EV_NAMES[T.kind[i]]}`); return; }
        const st = T.stages[T.a[i]], w = st.words;
        this.iFlow = this.nextFlowFrom(i + 1);
        this.stages++; this.stageTicks = 0; this.strict = false; this.stageName = ''; this.adopted.clear(); this.unsetPukus.clear(); this.jumpBases.clear(); this.kuris.clear(); this.kuriAgain.clear();
        // the new stage's heap holds the last stage's leftovers (and the movie's between them): a byte of a recorded
        // object that still holds its leftover at the object's first record was never written, as a zero is in the first stage
        this.heapBase = mem.ram.slice(head & 0x01FFFFFF, tail & 0x01FFFFFF); this.heapBaseAt = head; this.allocSnap.clear();
        const seq = (o: number) => ((mem.r8(A.app + o) << 24) | (mem.r8(A.app + o + 1) << 16) | mem.r16(A.app + o + 2)) >>> 0;
        if (seq(APP.cur) !== w[4]) this.issue('stage', `the game goes to scene ${hex(seq(APP.cur))}, the trace to ${hex(w[4])}`);
        if (mem.r32(A.seed) !== w[6]) this.issue('stage', `the RNG seed at the stage's start is ${hex(mem.r32(A.seed))}, the trace's ${hex(w[6])}`);
        if (mem.r32(A.npcPhase) !== st.npcPhase) this.issue('stage', `the NPC pollution phase is ${mem.r32(A.npcPhase)}, the trace's ${st.npcPhase}`);
        const fm = mem.bytes(mem.r32(A.flagMgr), 0x380), diff: string[] = [];
        for (let k = 0; k < 0x380; k++) if (fm[k] !== st.flags[k]) diff.push(`+0x${k.toString(16)} ${fm[k].toString(16)}/${st.flags[k].toString(16)}`);
        if (diff.length) this.issue('stage', `the flag manager differs from the trace's image in ${diff.length} byte(s) (game/trace): ${diff.slice(0, 12).join(', ')}`);
        if ((w[1] & 2) && (end - start !== w[11] || head - start !== w[9] || end - tail !== w[10])) this.issue('stage', `the stage heap is ${hex(end - start)} (used ${hex(head - start)} / ${hex(end - tail)}), the trace's ${hex(w[11])} (${hex(w[9])} / ${hex(w[10])})`);
        this.log(`stage ${this.stages}: scene ${hex(w[4])} at frame ${this.curFrame ? this.curFrame.frame : 0}`);
    }

    // ---------------------------------------------------------------- the pad
    private nextPad(): TracePad | null {
        const T = this.T;
        for (let i = this.iFlow; i < T.n; i++) { if (T.kind[i] === Ev.PAD) return T.pads[T.a[i]]; if (T.kind[i] === Ev.TICK) break; }
        return null;
    }
    private padRead(c: { gpr: Uint32Array }) {
        const mem = this.m.mem, p = c.gpr[3];
        for (let i = 0; i < 48; i++) mem.w8(p + i, 0);
        for (let ch = 1; ch < 4; ch++) mem.w8(p + ch * 12 + 10, 0xFF);   // PAD_ERR_NO_CONTROLLER
        const pad = this.phase === 'stage' ? this.nextPad() : null;
        if (pad) for (let i = 0; i < 11; i++) mem.w8(p + i, pad.input[IN.raw + i]);
        c.gpr[3] = 0;
    }
    /**
     * The pad's state as the recording began depends on what was pressed before it (the last stick angle, the
     * previous buttons, the repeat timers): take it from the first record, the port's statics included.
     */
    private adoptPad(obj: number, p: TracePad) {
        const mem = this.m.mem, A = this.A, changed: string[] = [];
        const put = (addr: number, src: Uint8Array, at: number, n: number, name: string) => {
            for (let i = 0; i < n; i += 4) {
                const v = ((src[at + i] << 24) | (src[at + i + 1] << 16) | (src[at + i + 2] << 8) | src[at + i + 3]) >>> 0, old = mem.r32(addr + i);
                if (old !== v) { changed.push(`${name}+0x${i.toString(16)} ${hex(old)} -> ${hex(v)}`); mem.w32(addr + i, v); }
            }
        };
        for (const [o, n] of PAD_STATE) put(obj + o, p.input, IN.pad + o, n, `pad+0x${o.toString(16)}`);
        if (p.mirrors) { put(A.padButton, p.mirrors, 0, 48, 'mPadButton'); put(A.padMStick, p.mirrors, 48, 16, 'mPadMStick'); put(A.padSStick, p.mirrors, 64, 16, 'mPadSStick'); }
        if (changed.length) this.log(`the pad's state from before the recording, taken from its first record: ${changed.join(', ')}`);
    }
    /**
     * The pad object as the recording has it. The game computes it from the raw pad, but Moonshine takes
     * buttons away from the game for its own binds, so where they differ the recording's is written.
     */
    private setPad(obj: number, rec: Uint8Array, what: string) {
        const mem = this.m.mem;
        let diff = -1;
        for (const [o, n] of PAD_SPANS) for (let i = 0; i < n; i++) if (mem.r8(obj + o + i) !== rec[IN.pad + o + i]) { if (diff < 0) diff = (o + i) & ~3; mem.w8(obj + o + i, rec[IN.pad + o + i]); }
        if (diff < 0) return;
        if (this.padCorrections++ < 3) this.log(`${what}: the pad object set to the recording's (first at +0x${diff.toString(16)}: the trace has ${hex(new DataView(rec.buffer, rec.byteOffset).getUint32(IN.pad + diff))})`);
    }

    // ---------------------------------------------------------------- frames
    private beforeDirect(c: { gpr: Uint32Array; pc: number }): boolean {
        if (this.phase !== 'stage') return false;
        if (this.cutAt && this.frames >= this.cutAt) { this.cutShort = true; this.log('(stopped here: a doubt before this difference is tried the other way first)'); this.stop(); return false; }
        const T = this.T, mem = this.m.mem, A = this.A;
        const skip = () => { c.gpr[3] = 0; c.pc = A.directRet; return true; };
        let i = this.iFlow;
        if (i < T.n && T.kind[i] === Ev.TICK) {
            let n = 0; while (i < T.n && T.kind[i] !== Ev.FRAME) { if (T.kind[i] === Ev.TICK) n++; i = this.nextFlowFrom(i + 1); }
            this.iFlow = i;
            this.issue('flow', `the game's frame ended ${n} movement tick(s) before the trace's`);
            if (this.phase !== 'stage') return false;
        }
        if (i >= T.n || T.kind[i] !== Ev.FRAME) { this.log(i >= T.n ? 'the trace ended' : `the trace has ${EV_NAMES[T.kind[i]]} where a frame was expected`); this.stop(); return false; }
        const f = T.frames[T.a[i]];
        if (f.state === -1) {
            // a frame of another director (a movie, a menu) between two stages: it gets the recorded pad, nothing is compared
            if (!this.moviePlanned) { this.moviePlanned = true; this.planMovie(i); }
            // (a movie whose loading had ended on the console by this frame, and hasn't here yet: this frame waits, as a stage's loading does)
            if (this.movieLoaded && this.movieFrame + 1 >= this.movieLoaded) {
                const ts = mem.r16(A.setupThread + 0x2C8);
                if (ts !== 8 && ts !== 0) { this.extraLoadFrames++; return skip(); }
            }
            this.movieFrame++;
            this.curFrame = f; this.curFrameIndex = T.a[i]; this.frames++;
            if (!this.between++) this.log(`frame ${f.frame}: the recording has frames without a stage director here (the game's director: ${hex(mem.r32(mem.r32(A.app + APP.director)))})`);
            this.alignClock(f, T.a[i]);
            i = this.nextFlowFrom(i + 1);
            if (i < T.n && T.kind[i] === Ev.PAD) { this.setPad(mem.r32(A.app + APP.pads), T.pads[T.a[i]].input, `frame ${f.frame}`); i = this.nextFlowFrom(i + 1); }
            this.iFlow = i;
            return false;
        }
        const dir = mem.r32(A.app + APP.director), setupDone = mem.r8(dir + DIR.setupDone) !== 0;
        const ts = mem.r16(A.setupThread + 0x2C8), threadDone = ts === 8 || ts === 0;
        let hold = false;
        if (!setupDone) {
            // loading: the recording's disc was slower or faster than this one. Give direct() the answer the
            // recording's frame had (still loading, or loaded), whatever this machine's loader has done by now.
            if (f.setupThreadDone && !threadDone) { this.extraLoadFrames++; return skip(); }
            if (!f.setupThreadDone && threadDone) hold = true;
            if (f.setupThreadDone) { this.strict = true; this.countAtPlay = this.m.cpu.count; }
        }
        this.curFrame = f; this.curFrameIndex = T.a[i]; this.frames++; this.movieFrame = 0; this.moviePlanned = false;
        this.alignClock(f, T.a[i]);
        this.checkCalls(f.ev, `frame ${f.frame}`);
        if (this.phase !== 'stage') return false;
        if (f.session) { this.session = f.session; this.moonshine.apply(f.session); }
        // (the recorder samples the actors, FLUDD and Yoshi only in a frame whose stage is set up, and forgets its actors when the scene changes)
        if (f.scene !== this.actorScene) { this.actors.clear(); this.actorScene = f.scene; }
        if (f.setupDone) { this.compareActors(f); this.compareObject('fludd', 'FLUDD', f.fludd); this.compareObject('yoshi', 'Yoshi', f.yoshi); }
        if (this.phase !== 'stage') return false;
        if (this.strict) {
            const seed = mem.r32(A.seed);
            if (seed !== f.seed) this.issue('frame', `the RNG seed is ${hex(seed)}, the trace's ${hex(f.seed)}`);
            if (f.tick !== this.ticks) this.issue('frame', `${this.ticks} movement ticks so far, the trace has ${f.tick}`);
            if (setupDone && f.state !== mem.r8(dir + DIR.state)) this.issue('frame', `the director's state is ${mem.r8(dir + DIR.state)}, the trace's ${f.state}`);
        }
        i = this.nextFlowFrom(i + 1);
        if (i < T.n && T.kind[i] === Ev.PAD) {
            const p = T.pads[T.a[i]], pad = mem.r32(A.app + APP.pads);
            i = this.nextFlowFrom(i + 1);
            if (!this.padAdopted) { this.padAdopted = true; this.adoptPad(pad, p); }
            if (p.suppressed) {
                // Moonshine's interface owns the pad: the game sees none for this direct()
                this.suppressed = PAD_SUPPRESS.map((o) => mem.r32(pad + o)); this.suppressedPad = pad;
                for (const o of PAD_SUPPRESS) mem.w32(pad + o, 0);
            }
            this.setPad(pad, p.input, `frame ${f.frame}`);
            if (p.frozen && setupDone) {
                // Moonshine froze the stage: it lends the director a state that runs nothing for this call
                const d = mem.r32(A.gpMarDirector);
                this.frozenState = mem.r8(d + DIR.state); mem.w8(d + DIR.state, STATE_STAGE_EXIT_2);
                // (the menu, the warp wheel and a state's disc work also take the pad away; a freeze that leaves the pad,
                // in a run the practice session assisted, is the practice session's: it runs no hit check)
                this.moonshine.practiceFrozen = !p.suppressed && (T.runFlags & RUN_ASSISTED) !== 0;
            }
        }
        this.iFlow = i;
        return hold ? skip() : false;
    }
    private afterDirect(c: { gpr: Uint32Array }) {
        const mem = this.m.mem;
        if (this.suppressed) { PAD_SUPPRESS.forEach((o, k) => mem.w32(this.suppressedPad + o, this.suppressed![k])); this.suppressed = null; }
        if (this.frozenState >= 0) { mem.w8(mem.r32(this.A.gpMarDirector) + DIR.state, this.frozenState); this.frozenState = -1; c.gpr[3] = 0; }
    }

    // ---------------------------------------------------------------- movement ticks
    private atTick(mario: number, cue: number) {
        const T = this.T, mem = this.m.mem;
        const i = this.iFlow;
        if (i >= T.n || T.kind[i] !== Ev.TICK) { this.issue('flow', `the game runs a movement tick where the trace has ${i >= T.n ? 'ended' : EV_NAMES[T.kind[i]]}`); return; }
        const t: TraceTick = T.ticks[T.a[i]];
        this.iFlow = this.nextFlowFrom(i + 1);
        this.ticks++; this.stageTicks++; this.curTick = t.tick; this.curTickIndex = T.a[i];
        this.checkCalls(t.ev, `tick ${t.tick}`);
        if (this.phase !== 'stage') return;
        const dv = new DataView(t.input.buffer, t.input.byteOffset, IN.size);
        if (dv.getUint32(IN.cue) !== cue) this.issue('tick', `the perform cue is ${hex(cue)}, the trace's ${hex(dv.getUint32(IN.cue))}`);
        const valid = dv.getUint32(IN.valid);
        if (valid & 1) this.setPad(mem.r32(mario + MARIO_PAD), t.input, `tick ${t.tick}`);
        if (valid & 2) {
            // TMarioControllerWork: its scalars (bytes 14 and 15 are padding). It is filled in by his first perform:
            // before that it holds whatever the heap had.
            const work = mem.r32(mario + MARIO_WORK), first = !this.adopted.has('work');
            this.adopted.add('work');
            for (let k = 4; k < 0x24; k++) {
                if (k === 14 || k === 15) continue;
                const rec = t.input[IN.work + k];
                if (first && this.takes('work', work, k, mem.r8(work + k))) mem.w8(work + k, rec);
                if (mem.r8(work + k) !== rec) {
                    const w = k & ~3;
                    this.issue('pad', `Mario's controller work differs at +0x${w.toString(16)}: game ${hex(mem.r32(work + w))}, trace ${hex(dv.getUint32(IN.work + w))}`);
                    break;
                }
            }
        }
        if (t.mario && this.stageTicks === 1 && !this.layoutDelta && mario !== t.marioPtr) {
            this.layoutDelta = mario - t.marioPtr;
            this.issue('layout', `Mario is at ${hex(mario)}, the recording's at ${hex(t.marioPtr)}: the stage's heap is laid out differently`);
            if (this.phase !== 'stage') return;
        }
        if (t.mario) {
            // the occlusion bit comes from the GPU (the draw-sync callback, at a time of its own): take the
            // recording's, in mFlag and in mPrevFlag (the copy each tick makes of it)
            for (const o of [MARIO_FLAGS + 3, MARIO_FLAGS + 7]) mem.w8(mario + o, (mem.r8(mario + o) & ~1) | (t.mario[o] & 1));
            this.marioChecked++;
            this.compareBlob('mario', 'Mario', mario, t.marioPtr, t.mario, MARIO_SOUND);
        }
        if (t.camera && this.phase === 'stage') this.compareBlob('camera', 'the camera', mem.r32(this.A.gpCamera), t.cameraPtr, t.camera);
    }
    /**
     * Uninitialised memory outside the recorded objects. The Blooper's grab objects (a tentacle's TBGTakeHit, the
     * beak's TBGBeakHit) write their taking matrix in their own perform and their constructors don't set it, but
     * TMario::pulling reads it in the tick Mario grabs, before that perform: his face angle is matan(-m[2][2],
     * -m[0][2]) of whatever the heap had. Here the heap had zeros (angle 0); the console's leftovers show in the
     * next record's face angle, so the two numbers that pulling reads are set to give that angle.
     */
    private unsetTakingMtx(mario: number) {
        const mem = this.m.mem, held = mem.r32(mario + TAKE_HELD);
        if (!held) return;
        const vt = mem.r32(held), known = this.A.unsetTakingMtx.find((k) => k[0] === vt);
        if (!known) return;
        const mtx = held + known[1];
        for (let k = 0; k < 48; k += 4) if (mem.r32(mtx + k) !== 0) return;
        const next = this.T.ticks[this.curTickIndex + 1];
        if (!next || !next.mario) return;
        const rec = new DataView(next.mario.buffer, next.mario.byteOffset, next.mario.byteLength);
        const status = rec.getUint32(MARIO_STATUS);
        if (status !== STATUS_PULLING && status !== STATUS_OIL_PULLING) return;
        const angle = rec.getInt16(MARIO_FACE_ANGLE_Y);
        // matan(z, x) is the angle of (x, z) from +z: x = -m[0][2], z = -m[2][2]
        const q = angle & 0x3FFF ? null : [[0, -1], [-1, 0], [0, 1], [1, 0]][(angle >> 14) & 3];
        const th = angle * Math.PI / 32768, m02 = q ? q[0] : -Math.sin(th), m22 = q ? q[1] : -Math.cos(th);
        const f = new DataView(new ArrayBuffer(4));
        f.setFloat32(0, m02); mem.w32(mtx + 0x08, f.getUint32(0));
        f.setFloat32(0, m22); mem.w32(mtx + 0x28, f.getUint32(0));
        this.log(`tick ${this.curTick}: Mario grabs an object whose taking matrix is uninitialised memory (zeros here); its direction is taken from the next record's face angle (0x${(angle & 0xFFFF).toString(16)})`);
    }
    /**
     * What the console carried from before the recording, outside the recorded objects: TShine::mUpSpeed. It is 1
     * at boot and TShine::appearSimple leaves it 2 for the rest of the session, so a console that showed a Shine
     * that way earlier raises its later Shines twice as fast. The recording's own Shine says which: the first run
     * of three equal rises a frame (four ticks each) is its moving up.
     */
    private adoptShineSpeed() {
        const T = this.T, A = this.A, y = new Map<number, { shine: boolean; y: number; rises: number[] }>();
        const f = new DataView(new ArrayBuffer(4)), flt = (bits: number) => { f.setUint32(0, bits); return f.getFloat32(0); };
        let speed = 0;
        scan: for (const fr of T.frames) {
            if (!fr.actors) continue;
            for (const r of fr.actors) {
                let a = y.get(r.id);
                if (!a || r.created) { a = { shine: false, y: NaN, rises: [] }; y.set(r.id, a); }
                for (let k = 0; k < r.word.length; k++) {
                    if (r.word[k] === 0) a.shine = r.value[k] === A.shineVtable;
                    if (r.word[k] === 5) { const now = flt(r.value[k]); if (a.shine && !r.created) { a.rises.push(now - a.y); const n = a.rises.length; if (n >= 3 && a.rises[n - 1] > 0 && a.rises[n - 1] === a.rises[n - 2] && a.rises[n - 2] === a.rises[n - 3]) { speed = a.rises[n - 1] / 4; break scan; } } a.y = now; }
                }
            }
        }
        if (!speed) return;
        f.setUint32(0, this.m.mem.r32(A.shineUpSpeed));
        if (f.getFloat32(0) === speed) return;
        this.log(`TShine::mUpSpeed is ${f.getFloat32(0)} here; the recording's Shine rises ${speed} a tick (an earlier Shine of the console's session left it so): taken from the recording`);
        f.setFloat32(0, speed); this.m.mem.w32(A.shineUpSpeed, f.getUint32(0));
    }
    private jingleSaid = false; private iHotel = 0;
    /** does the recording make the hotel's particles (at gpMapObjManager's place, +0x44) in its next movement tick? */
    private hotelRisesNow(): boolean {
        const T = this.T, at = this.m.mem.r32(this.A.gpMapObjManager) + 0x44;
        const from = this.curTickIndex >= 0 ? T.ticks[this.curTickIndex].ev : 0;
        while (this.iHotel < T.particles.length && !(T.particles[this.iHotel].ev >= from && T.particles[this.iHotel].type === 2 && T.particles[this.iHotel].args[1] === at)) this.iHotel++;
        const mark = T.particles[this.iHotel];
        if (!mark) return false;
        // (the events up to the tick after next's start: the rest of this tick and all of the next)
        let n = this.iFlow; while (n < T.n && T.kind[n] !== Ev.TICK) n++;
        n++; while (n < T.n && T.kind[n] !== Ev.TICK) n++;
        return mark.ev < n;
    }
    private clockScale = 0; private lastClock: { osTick: number; tb: number; index: number } | null = null;
    /**
     * The OS clock is kept on the recording's. The game times some things by the clock, not by frames (the red-coin
     * timer is an OSStopwatch), and how long a frame really took is the console's: the recorder notes OSGetTick() at
     * every frame, so the time base is moved to have advanced as much since the last frame as the recording's did.
     * (A Wii's time base ticks 1.5 times as fast as a GameCube's; the recording's ticks a video field say which it was.)
     */
    private alignClock(f: TraceFrame, index: number) {
        const cpu = this.m.cpu, T = this.T, fieldTicks = this.m.hw.field / TB_DIV;
        if (!this.clockScale) {
            const per: number[] = [];
            for (let k = 1; k < T.frames.length && per.length < 4000; k++) {
                const dr = T.frames[k].retrace - T.frames[k - 1].retrace, dt = (T.frames[k].osTick - T.frames[k - 1].osTick) >>> 0;
                if (dr > 0 && dr <= 8) per.push(dt / dr);
            }
            per.sort((a, b) => a - b);
            const mid = per.length ? per[per.length >> 1] : fieldTicks, scale = fieldTicks / mid;
            this.clockScale = scale > 0.4 && scale < 1.6 ? scale : 1;
            this.log(`the OS clock follows the recording's (its time base ticks ${Math.round(mid)} a video field, a GameCube's ${Math.round(fieldTicks)})`);
        }
        const last = this.lastClock;
        if (last && index === last.index + 1) {
            const want = Math.round(((f.osTick - last.osTick) >>> 0) * this.clockScale), have = cpu.tb() - last.tb;
            // (not back by more than a second: an OS alarm set meanwhile would wait that much longer)
            if (want !== have && want < fieldTicks * 3600 && want - have > -fieldTicks * 60) cpu.warpTb(want - have);
        }
        this.lastClock = { osTick: f.osTick, tb: cpu.tb(), index };
    }
    private demoSaid = false;
    /**
     * Whether the recording's movement ticks start again right after this game tick, of whose frame `left` game ticks are
     * still to run: its frame then has exactly that many ticks, or (after a frame's last tick) its next frame has all of its own.
     */
    private worldMovesAgain(left: number): boolean {
        const T = this.T;
        let i = this.iFlow, n = 0;
        const count = () => { n = 0; while (i < T.n && T.kind[i] === Ev.TICK) { n++; i = this.nextFlowFrom(i + 1); } };
        count();
        if (left > 0) return n === left;
        if (n || i >= T.n || T.kind[i] !== Ev.FRAME) return false;
        const from = T.frames[T.a[i]].tick;
        i = this.nextFlowFrom(i + 1);
        if (i < T.n && T.kind[i] === Ev.PAD) i = this.nextFlowFrom(i + 1);
        count();
        // (a whole frame of ticks: as many as the recording's frames usually have)
        return n > 0 && n >= this.usualTicks(from);
    }
    private usualTicksN = 0;
    /** how many movement ticks a frame of this recording usually has */
    private usualTicks(_from: number): number {
        if (!this.usualTicksN) {
            const T = this.T, seen = new Map<number, number>();
            for (let k = 1; k < T.frames.length; k++) { const dt = T.frames[k].tick - T.frames[k - 1].tick; if (dt > 0) seen.set(dt, (seen.get(dt) || 0) + 1); }
            let best = 4, most = 0;
            for (const [dt, c] of seen) if (c > most) { most = c; best = dt; }
            this.usualTicksN = best;
        }
        return this.usualTicksN;
    }
    /** the frames of the movie being played so far, and the first of them in which its setup thread counts as ended */
    private movieFrame = 0; private movieLoaded = 0; private moviePlanned = false;
    /**
     * A movie between two stages (TMovieDirector), from the first of the recording's frames without a stage director.
     * Moonshine's FMV Skips lets a button end it; how many frames it then lasts depends on the frame its setup thread
     * (the disc) ended in: from that frame `j` the screen fades in a step a frame; the first frame `p` with Start, A
     * or B fades it back out over as many steps, and the director leaves once it is black: after frame 2p - j + 1
     * (j + 1 when the button comes in frame j itself: the fade never started). The recording says how many frames
     * the movie had and what the pad meant in each, so `j` is the one that gives that many.
     */
    private planMovie(i0: number) {
        const T = this.T, mem = this.m.mem, A = this.A;
        this.movieLoaded = 0;
        if (mem.r32(mem.r32(A.app + APP.director)) !== A.movieVtable) return;
        const meaning: number[] = [];
        let i = i0;
        while (i < T.n && T.kind[i] === Ev.FRAME && T.frames[T.a[i]].state === -1) {
            let k = this.nextFlowFrom(i + 1), m = 0;
            if (k < T.n && T.kind[k] === Ev.PAD) { const inp = T.pads[T.a[k]].input; m = new DataView(inp.buffer, inp.byteOffset, inp.length).getUint32(IN.pad + 0xD4); k = this.nextFlowFrom(k + 1); }
            meaning.push(m); i = k;
        }
        const n = meaning.length;
        if (i >= T.n || T.kind[i] !== Ev.STAGE) return;   // (the recording ends inside the movie)
        const ends = (j: number) => {
            let p = j; while (p <= n && !(meaning[p - 1] & 0x61)) p++;
            return p > n || p - j > 30 ? -1 : p === j ? j + 1 : 2 * p - j + 1;
        };
        for (let j = 1; j <= n; j++) if (ends(j) === n) { this.movieLoaded = j; break; }
        this.log(this.movieLoaded ? `frame ${T.frames[T.a[i0]].frame}: a movie of ${n} frames: its loading counts as done in its frame ${this.movieLoaded}, which ends it where the recording's ends` : `frame ${T.frames[T.a[i0]].frame}: a movie of ${n} frames: no loading time makes it end there with the recorded buttons`);
    }
    private unsetPukus = new Set<number>(); private pukuSaid = false; private jumpBases = new Set<number>();
    /** the Goombas whose look-around timer has been read: true while it is still the heap's leftovers (see the hooks) */
    private kuris = new Map<number, boolean>(); private kuriSaid = false;
    private actorIdAt(ptr: number) { for (const [k, a] of this.actors) if (a.ptr === ptr) return k; return -1; }
    /**
     * Whether the Goomba at `p`, whose timer is leftovers, starts looking around in this tick, by the recording:
     * 1 from its walk (the tick shows), 2 again while it looks around (only the frame shows), 0 not.
     */
    private kuriLooksAround(p: number): number {
        const mem = this.m.mem, T = this.T, F = this.curFrameIndex, bck = mem.r32(p + KURI.bck);
        if (bck !== KURI.look) this.kuriAgain.delete(p);
        if (F + 1 >= T.frames.length) return 0;
        const id = this.actorIdAt(p);
        if (id < 0) return 0;
        if (bck === KURI.look) {
            let at = this.kuriAgain.get(p);
            if (at === undefined) this.kuriAgain.set(p, at = this.kuriAgainFrame(p, id));
            if (at !== F) return 0;
            this.kuriAgain.set(p, -1);
            return 2;
        }
        if (bck !== KURI.walk) return 0;
        // (a tick's moveObject, where the timer is, comes before its nerve, where a walking Goomba turns and counts
        // the tick in unk128: one that looks around from this tick has, at the next sample, the look-around's
        // animation, and its turn and its count as they are now. Where it stands doesn't say: the ground may carry it)
        const path = this.actorWordAhead(id, KURI.soundPath, F + 1), turn = this.actorWordAhead(id, KURI.rotY, F + 1), count = this.actorWordAhead(id, KURI.walked, F + 1);
        return path === 0 && turn === mem.r32(p + KURI.rotY) && count !== null && (count >>> 16) === mem.r16(p + KURI.walked) ? 1 : 0;
    }
    /** the Goombas now looking around on a leftover timer: the frame in which the recording starts the animation again (-1: it doesn't) */
    private kuriAgain = new Map<number, number>();
    /**
     * The look-around animation of the Goomba at `p` (recorded actor `id`) ends when its frame control says so, after
     * a number of the once-a-frame steps. If the recorded Goomba's ends later than this one's will, it was started
     * again on the way: in the frame that many steps before the recorded end.
     */
    private kuriAgainFrame(p: number, id: number): number {
        const mem = this.m.mem, T = this.T, F = this.curFrameIndex, a = this.actors.get(id)!;
        const ticking = (i: number) => i + 1 < T.frames.length && T.frames[i + 1].tick > T.frames[i].tick;
        // the frame control of the actor's BCK: how many steps a fresh animation takes, and this one still does
        const anm = mem.r32(mem.r32(p + KURI.mactor) + MACTOR_BCK), end = (mem.r16(anm + ANM.end) << 16) >> 16, rate = f32FromBits(mem.r32(anm + ANM.rate));
        if (!(rate > 0)) return -1;
        const steps = (frame: number) => { let n = 0; while (!(Math.fround(Math.fround(frame + rate) + Math.fround(0.1)) >= end) && n < 10000) { frame = Math.fround(frame + rate); n++; } return n; };
        const whole = steps(0), left = steps(f32FromBits(mem.r32(anm + ANM.frame)));
        // here it ends in the first tick of the frame after `left` more frames with ticks
        let mine = F, n = left;
        while (mine < T.frames.length && (n > 0 || !ticking(mine))) { if (ticking(mine)) n--; mine++; }
        // the recording's: the last frame with ticks before the first sample that has the walk's sound path again
        let v = a.dv.getUint32(KURI.soundPath), j = F + 1;
        for (; j < T.frames.length && j < F + 2000; j++) {
            const f = T.frames[j];
            if (f.scene !== this.actorScene || (f.actorsGone && f.actorsGone.includes(id))) return -1;
            if (f.actors) for (const r of f.actors) if (r.id === id) { if (r.created) return -1; for (let k = 0; k < r.word.length; k++) if (r.word[k] * 4 === KURI.soundPath) v = r.value[k]; }
            if (v !== 0) break;
        }
        if (v === 0) return -1;
        let theirs = j - 1; while (theirs > F && !ticking(theirs)) theirs--;
        if (theirs <= mine) return -1;
        let again = theirs; n = whole;
        while (again > F && n > 0) { again--; if (ticking(again)) n--; }
        return n === 0 ? again : -1;
    }
    /** whether the recorded Goomba at `p` goes on looking around through this tick (its animation here has ended) */
    private kuriStillLooks(p: number): boolean {
        const id = this.actorIdAt(p), F = this.curFrameIndex;
        return id >= 0 && F + 1 < this.T.frames.length && this.actorWordAhead(id, KURI.soundPath, F + 1) === 0;
    }
    /** the stage heap's free memory as the stage's setup began (null: zeros) */
    private heapBase: Uint8Array | null = null; private heapBaseAt = 0;
    /** each block the stage has allocated (up to 0x8000 bytes), as it was when the heap gave it out */
    private allocSnap = new Map<number, Uint8Array>();
    /**
     * Whether byte `k` of the object at `ptr`, which reads `v`, is still as it was before the object existed: then the
     * game hasn't written it, and what the console has there is the heap's leftovers. Known exactly for an object that
     * is a block of its own (the block's bytes are kept as the heap gives it out); otherwise it is a byte that still
     * holds what the stage heap had as the stage's setup began (zero in the first stage).
     */
    /** the bytes of each kind of recorded object (Mario, the camera, an actor's class) that were found unset at a first record */
    private unsetSeen = new Map<string, Uint8Array>(Object.entries(UNSET_AT_FIRST).map(([kind, ranges]) => {
        const seen = new Uint8Array(0x600);
        for (const [a, b] of ranges) seen.fill(1, a, b + 1);
        return [kind, seen] as [string, Uint8Array];
    }));
    /**
     * Whether byte `k` of a recorded object, which differs from its first record, is the heap's leftovers and so the
     * recording's to say: it is unset (see `unset`), or it was unset in an earlier object of the same kind. The second
     * matters where a constructor copies an unset value in (the camera's three look-at records are copied from a
     * local nobody set): then the byte is written, with what the stack happened to hold.
     */
    private takes(kind: string, ptr: number, k: number, v: number): boolean {
        let seen = this.unsetSeen.get(kind);
        if (seen && k < seen.length && seen[k]) return true;
        if (!this.unset(ptr, k, v)) return false;
        if (!seen || k >= seen.length) { const grown = new Uint8Array(Math.max(0x600, (k + 0x100) & ~0xFF)); if (seen) grown.set(seen); this.unsetSeen.set(kind, seen = grown); }
        seen[k] = 1;
        return true;
    }
    private unset(ptr: number, k: number, v: number): boolean {
        const snap = this.allocSnap.get(ptr);
        if (snap && k < snap.length) return v === snap[k];
        const b = this.heapBase, o = ptr + k - this.heapBaseAt;
        return v === (b && o >= 0 && o < b.length ? b[o] : 0);
    }
    /** word `o` of a recorded actor as the recorder samples it at the later frame `g` (null: gone or another object by then) */
    private actorWordAhead(id: number, o: number, g: number): number | null {
        const a = this.actors.get(id), T = this.T;
        if (!a || g >= T.frames.length) return null;
        let v = a.dv.getUint32(o);
        for (let i = this.curFrameIndex + 1; i <= g; i++) {
            const f = T.frames[i];
            if (f.scene !== this.actorScene || (f.actorsGone && f.actorsGone.includes(id))) return null;
            if (f.actors) for (const r of f.actors) if (r.id === id) { if (r.created) return null; for (let k = 0; k < r.word.length; k++) if (r.word[k] * 4 === o) v = r.value[k]; }
        }
        return v;
    }
    /** TNerveTobiPukuLand is about to compare how far the Cheep Cheep in r30 has dived (f1) with 600: the recording's answer for one whose reference height is leftovers */
    private pukuDives(c: { gpr: Uint32Array; ps0: Float64Array }) {
        const mem = this.m.mem, T = this.T, p = c.gpr[30], bits = mem.r32(p + 0x14), y = f32FromBits(bits), F = this.curFrameIndex;
        let id = -1;
        for (const [k, a] of this.actors) if (a.ptr === p) { id = k; break; }
        const s1 = id < 0 ? null : this.actorWordAhead(id, 0x14, F + 1);
        if (s1 === null) return;
        let ends: boolean;
        if (s1 !== bits) ends = f32FromBits(s1) > y;   // (lower at the next sample: still diving)
        else {
            // the same height at the next sample: the dive ended, unless this is the frame's last tick; then the first sample after another tick says
            let g = F + 2;
            while (g < T.frames.length && T.frames[g].tick === T.frames[F + 1].tick) g++;
            const s2 = this.actorWordAhead(id, 0x14, g);
            if (s2 === null) return;
            ends = f32FromBits(s2) >= y;
        }
        c.ps0[1] = ends ? 601 : 0;
        if (ends) this.unsetPukus.delete(p);
        if (!this.pukuSaid) { this.pukuSaid = true; this.log(`tick ${this.curTick}: a Cheep Cheep's first dive ends 600 from a height that is the heap's leftovers (TTobiPuku::unk1D0 is unset when its Generate nerve first adds it): when the dive ends is taken from the recording`); }
    }
    private emitPosSaid = false;
    /** FLUDD's emit position at `pos` was just copied from the joint matrix at `mtx`: if that matrix was never computed, the position is the recording's */
    private unsetEmitPos(mtx: number, pos: number) {
        const mem = this.m.mem, T = this.T;
        for (let k = 0; k < 48; k += 4) if (mem.r32(mtx + k) !== 0) return;
        // (the recorder's next sample of FLUDD, as the next frame begins, has what the console's copy left there)
        const next = T.frames[this.curFrameIndex + 1], rec = next && next.setupDone ? next.fludd : null;
        if (!rec) return;
        const off = pos - rec.ptr;
        if (off < 0x1C90 || off > 0x1CA8 || (off - 0x1C90) % 12 || off + 12 > rec.data.length) return;
        const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.length);
        for (let k = 0; k < 12; k += 4) mem.w32(pos + k, dv.getUint32(off + k));
        if (!this.emitPosSaid) { this.emitPosSaid = true; this.log(`tick ${this.curTick}: FLUDD's emit position comes from a nozzle's joint matrix the game never computed (the heap's leftovers, zeros here): taken from the recording`); }
    }
    private waterNow: { accepted: number } | null = null;
    private waterOff(text: string) { if (this.watersOff++ < 12) this.issue('water', text); }
    /** a water request against the recording's next one */
    private atWater(info: number) {
        const T = this.T, mem = this.m.mem;
        if (!T.waters.length) return;
        // (requests the recording made before this stage's start are not the game's here)
        const st = T.stages[this.stages - 1];
        while (this.iWater < T.waters.length && st && T.waters[this.iWater].ev < st.ev) this.iWater++;
        const w = T.waters[this.iWater++];
        if (!w) { this.waterOff('the game asks for water after the trace\'s last request'); return; }
        this.waters++; this.waterNow = w;
        const mine = mem.bytes(info, w.info.length), d = new DataView(w.info.buffer, w.info.byteOffset, w.info.length), out: string[] = [];
        // (a TWaterEmitInfo's parameters have padding its constructor never writes: at a request object's first use
        // the bytes still zero here are the console's leftovers, as in the recorded objects)
        if (!this.adopted.has('water' + hex(info))) {
            this.adopted.add('water' + hex(info));
            let took = 0;
            for (let k = 0; k < w.info.length; k++) if (mine[k] !== w.info[k] && this.takes('water', info, k, mine[k])) { mine[k] = w.info[k]; took++; }
            if (took) this.log(`a water request object at ${hex(info)}: ${took} uninitialised byte(s) taken from its first record`);
        }
        for (let o = 0; o + 4 <= w.info.length; o += 4) { const g = mem.r32(info + o), t = d.getUint32(o); if (g !== t) out.push(`+0x${o.toString(16)}: ${hex(g)} / ${hex(t)} (${f32FromBits(g).toPrecision(8)} / ${f32FromBits(t).toPrecision(8)})`); }
        if (info !== w.source) out.unshift(`the request is at ${hex(info)}, the trace's at ${hex(w.source)}`);
        if (out.length) this.waterOff(`water request ${this.iWater} differs (game / trace):\n    ` + out.slice(0, 12).join('\n    '));
    }
    /** FLUDD or Yoshi against the frame's sample: as the actors, each differing word reported once */
    private compareObject(kind: string, name: string, o: { ptr: number; data: Uint8Array } | null) {
        if (!o || o.ptr < 0x80000000 || o.ptr + o.data.length > 0x81800000) return;
        const mem = this.m.mem, mine = mem.bytes(o.ptr, o.data.length), rec = o.data;
        if (!this.adopted.has(kind + hex(o.ptr))) {
            this.adopted.add(kind + hex(o.ptr));
            let took = 0;
            for (let k = 0; k < rec.length; k++) if (mine[k] !== rec[k] && this.takes(kind, o.ptr, k, mine[k])) { mine[k] = rec[k]; took++; }
            if (took) this.log(`${name}: ${took} uninitialised byte(s) taken from its first record`);
        }
        let same = true;
        for (let k = 0; k < rec.length; k++) if (mine[k] !== rec[k]) { same = false; break; }
        if (same) return;
        const d = new DataView(rec.buffer, rec.byteOffset, rec.length);
        for (let off = 0; off + 4 <= rec.length; off += 4) {
            const g = mem.r32(o.ptr + off), t = d.getUint32(off);
            if (g === t) continue;
            const key = `${kind}+${off.toString(16)}`;
            if (this.actorsOff.has(key)) continue;
            this.actorsOff.add(key);
            if (this.actorsOff.size <= 60) this.issue(kind, `${name} differs at +0x${off.toString(16)}: ${hex(g)} / ${hex(t)} (${f32FromBits(g).toPrecision(8)} / ${f32FromBits(t).toPrecision(8)}) (game / trace)`);
        }
    }
    /**
     * The actors against the recording's samples of this frame (every actor of the conductor's managers, as the
     * frame began). A new actor's bytes that are still zero here and not in the recording are the console's
     * leftovers, taken from it as Mario's are. A word that differs is reported once (per class and offset) and
     * then follows the recording's value in the comparison only: the game's memory is left as the game made it.
     */
    private compareActors(f: TraceFrame) {
        const mem = this.m.mem;
        if (f.actorsGone) for (const id of f.actorsGone) this.actors.delete(id);
        if (f.actors) for (const r of f.actors) {
            let a = this.actors.get(r.id);
            if (!a || r.created) { const data = new Uint8Array(r.bytes); a = { ptr: r.ptr, data, dv: new DataView(data.buffer) }; this.actors.set(r.id, a); }
            for (let k = 0; k < r.word.length; k++) a.dv.setUint32(r.word[k] * 4, r.value[k]);
            if (r.created && r.ptr >= 0x80000000 && r.ptr + r.bytes <= 0x81800000) {
                const mine = mem.bytes(r.ptr, r.bytes);
                let took = 0;
                if (mem.r32(r.ptr) === a.dv.getUint32(0)) for (let k = 0; k < r.bytes; k++) if (mine[k] !== a.data[k] && this.takes('actor' + a.dv.getUint32(0), r.ptr, k, mine[k])) { mine[k] = a.data[k]; took++; }
                if (took && this.actorsOff.size < 40 && !this.actorsOff.has('new' + hex(a.dv.getUint32(0)))) { this.actorsOff.add('new' + hex(a.dv.getUint32(0))); this.log(`frame ${f.frame}: an actor of class ${hex(a.dv.getUint32(0))} at ${hex(r.ptr)}: ${took} uninitialised byte(s) taken from its first record`); }
            }
        }
        for (const [id, a] of this.actors) {
            if (a.ptr < 0x80000000 || a.ptr + a.data.length > 0x81800000) continue;
            const mine = mem.bytes(a.ptr, a.data.length), rec = a.data;
            this.actorsChecked++;
            let same = true;
            for (let k = 0; k < rec.length; k++) if (mine[k] !== rec[k]) { same = false; break; }
            if (same) continue;
            for (let o = 0; o + 4 <= rec.length; o += 4) {
                const g = mem.r32(a.ptr + o), t = a.dv.getUint32(o);
                if (g === t) continue;
                this.actorWordsOff++;
                const key = `${hex(a.dv.getUint32(0))}+${o.toString(16)}`;
                if (this.actorsOff.has(key)) continue;
                this.actorsOff.add(key);
                if (this.actorsOff.size <= 40) this.issue('actor', `actor ${id} (class ${hex(a.dv.getUint32(0))}, at ${hex(a.ptr)}) differs at +0x${o.toString(16)}: ${hex(g)} / ${hex(t)} (${f32FromBits(g).toPrecision(8)} / ${f32FromBits(t).toPrecision(8)}) (game / trace)`);
            }
        }
    }
    /**
     * An object of the game against its record. At its first record, memory the game hasn't written yet (zero
     * on this freshly booted machine) holds whatever the console's heap had there: uninitialised memory is the
     * recording's to say, so those bytes are taken from it.
     * `handle`: the offset of a sound handle. Which of the sound system's slots a new sound gets, and when the
     * sound ends and its handle goes back to null, is the sound hardware's doing, and no sound runs here (ppc/hle.ts):
     * the word is not compared (said once in the log, at the first difference).
     */
    private compareBlob(kind: string, name: string, addr: number, recAddr: number, rec: Uint8Array, handle = -1) {
        const n = rec.length, mem = this.m.mem;
        let mine = mem.bytes(addr, n);
        if (handle >= 0 && handle + 4 <= n) {
            const h = mem.r32(addr + handle), hr = ((rec[handle] << 24) | (rec[handle + 1] << 16) | (rec[handle + 2] << 8) | rec[handle + 3]) >>> 0;
            if (h !== hr) {
                if (!this.otherHandle) { this.otherHandle = true; this.log(`frame ${this.curFrame ? this.curFrame.frame : 0} tick ${this.curTick}: ${name}'s sound handle is ${hex(h)}, the recording's ${hex(hr)}: which slot a sound gets and when it ends is the sound hardware's, which doesn't run here; not compared`); }
                mine = mine.slice(); mine.set(rec.subarray(handle, handle + 4), handle);
            }
        }
        if (!this.adopted.has(kind)) {
            this.adopted.add(kind);
            const took: string[] = [];
            for (let k = 0; k < n; k++) if (mine[k] !== rec[k] && this.takes(kind, addr, k, mine[k])) { const w = (k & ~3).toString(16); if (took[took.length - 1] !== w) took.push(w); mine[k] = rec[k]; }
            if (took.length) this.log(`${name}: uninitialised bytes taken from the first record: words at +0x${took.join(', +0x')}`);
        }
        let same = true;
        for (let k = 0; k < n; k++) if (mine[k] !== rec[k]) { same = false; break; }
        if (same) return;
        const md = new DataView(mine.buffer, mine.byteOffset, n), rd = new DataView(rec.buffer, rec.byteOffset, n), out: string[] = [];
        let words = 0;
        for (let o = 0; o + 4 <= n; o += 4) if (md.getUint32(o) !== rd.getUint32(o)) {
            words++;
            if (out.length < 12) out.push(`+0x${o.toString(16)}: ${hex(md.getUint32(o))} / ${hex(rd.getUint32(o))} (${md.getFloat32(o).toPrecision(8)} / ${rd.getFloat32(o).toPrecision(8)})`);
        }
        this.issue(kind, `${name} differs in ${words} word(s) (game / trace)${addr !== recAddr ? `; it is at ${hex(addr)}, the trace's at ${hex(recAddr)}` : ''}:\n    ` + out.join('\n    '));
    }

    // ---------------------------------------------------------------- rand and the GPU's results
    private atRand(lr: number) {
        const T = this.T, i = this.iCall, seed = this.m.mem.r32(this.A.seed);
        if (i < T.n && T.kind[i] === Ev.RAND && T.b[i] === seed) {
            const caller = T.a[i];
            if (caller === lr || (caller >= this.modLo && caller < this.modHi && ++this.shimCalls)) { this.lastCall = i; this.iCall = this.nextCallFrom(i + 1); this.calls++; return; }
        }
        if (i >= T.n) { this.issue('rand', `rand called from ${hex(lr)} after the trace's last call`); return; }
        if (this.stageTicks === 0 && this.stages === 1 && !this.layoutDelta) {
            // the first stage is still being set up: a heap laid out differently (see `layoutDelta`) explains a different call
            const mario = this.m.mem.r32(this.A.gpMarioOriginal), rec = T.ticks.length ? T.ticks[0].marioPtr : 0;
            if (mario && rec && mario !== rec) {
                this.layoutDelta = mario - rec;
                this.issue('layout', `Mario is at ${hex(mario)}, the recording's at ${hex(rec)}: the stage's heap is laid out differently`);
                if (this.phase !== 'stage') return;
            }
        }
        const k = T.kind[i];
        this.issue('rand', `rand called from ${hex(lr)} (seed ${hex(seed)}); the trace's next is ${k === Ev.RAND ? `rand from ${hex(T.a[i])} (seed ${hex(T.b[i])})` : `a literal at ${hex(T.a[i])}`} (call ${this.calls + this.literals})`);
        // carry on in step where that is possible: the same number of calls gives the same seed
        if (k === Ev.RAND && T.b[i] === seed) { this.lastCall = i; this.iCall = this.nextCallFrom(i + 1); this.calls++; }
    }
    private literal(caller: number): number | null {
        if (this.phase !== 'stage') return null;
        const T = this.T, i = this.iCall;
        if (i < T.n && T.kind[i] === Ev.LIT && T.a[i] === caller) {
            if (T.c[i] !== this.m.mem.r32(this.A.seed)) this.issue('literal', `the seed at the read at ${hex(caller)} is ${hex(this.m.mem.r32(this.A.seed))}, the trace's ${hex(T.c[i])}`);
            this.lastCall = i; this.iCall = this.nextCallFrom(i + 1); this.literals++;
            return T.b[i];
        }
        this.issue('literal', `the game reads a GPU result at ${hex(caller)}; the trace's next is ${i >= T.n ? 'nothing' : `${EV_NAMES[T.kind[i]]} from ${hex(T.a[i])}`}`);
        return null;
    }
}

/**
 * The next thing to try for a replay that parted from its recording: the same with the lock word of one event
 * script the other way (the last script before the parting whose unset lock word decided something, see
 * Replay.scriptDoubts). null: nothing left to try. The caller keeps the new replay only if it follows further.
 */
/** Whether replay `a` follows the recording further than `b`: more frames, or as many with less that differs. */
export function followsFurther(a: Replay, b: Replay): boolean {
    if (a.frames !== b.frames) return a.frames > b.frames;
    if (a.issues.length !== b.issues.length) return a.issues.length < b.issues.length;
    return a.actorWordsOff < b.actorWordsOff;
}
export function nextScriptLocks(R: Replay, tried: Set<string>): string[] | null {
    if (!R.issues.length) return null;
    const stop = R.issues[0].frame;
    for (let i = R.scriptDoubts.length - 1; i >= 0; i--) {
        const d = R.scriptDoubts[i];
        if (d.frame > stop || tried.has(d.script)) continue;
        tried.add(d.script);
        return d.locked ? R.scriptsLocked.filter((n) => n !== d.script) : [...R.scriptsLocked, d.script];
    }
    return null;
}
