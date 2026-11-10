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
import { Ev, EV_NAMES, IN, MARIO_BYTES, type Trace, type TraceFrame, type TracePad, type TraceTick } from './trace.js';
import { Moonshine, ARENA_RESERVE, type Region } from './moonshine.js';

export interface GameAddrs {
    region: Region;
    app: number; procLoopHead: number; setupCall: number; directCall: number; directRet: number; setupObjectsCall: number;
    marioPerform: number; randRet: number; seed: number; npcPhase: number; flagMgr: number;
    gpMarDirector: number; gpMarioOriginal: number; gpCamera: number; gpPollution: number; setupThread: number;
    PADRead: number; PADClamp: number; OSGetArenaLo: number; arenaLoVar: number;
    fbCamera: number; fbSilhouette: number; fbWater: number; fastTextCall: number;
    padButton: number; padMStick: number; padSStick: number;
}
/** GMSJ01 revision 0 */
export const JP10: GameAddrs = {
    region: 0,
    app: 0x803E6000, procLoopHead: 0x800FA1CC, setupCall: 0x800F9F70, directCall: 0x800F9B60, directRet: 0x800F9B74, setupObjectsCall: 0x800ECE3C,
    marioPerform: 0x8012C77C, randRet: 0x80085AE4, seed: 0x80408CF0, npcPhase: 0x8040A4A0, flagMgr: 0x8040A290,
    gpMarDirector: 0x8040A2A8, gpMarioOriginal: 0x8040A378, gpCamera: 0x8040B370, gpPollution: 0x8040A5A8, setupThread: 0x803F2390,
    PADRead: 0x8009BF20, PADClamp: 0x8009B1A4, OSGetArenaLo: 0x8008DCBC, arenaLoVar: 0x80408D08,
    fbCamera: 0x80359CA4, fbSilhouette: 0x800C2D0C, fbWater: 0x801FABF0, fastTextCall: 0x8021530C,
    padButton: 0x80400D80, padMStick: 0x80400E40, padSStick: 0x80400E80,
};
// offsets in the game's objects
const APP = { director: 4, state: 8, prev: 0xA, cur: 0xE, next: 0x12, movie: 0x18, pads: 0x20, heap: 0x40 };
const DIR = { moveTicks: 0x58, ticks: 0x5C, state: 0x64, setupDone: 0x260 };
const STATE_STAGE_EXIT_2 = 12;
// TMarioGamePad: the scalar spans Moonshine compares (buttons, the two sticks, the meanings and analog state)
const PAD_SPANS: [number, number][] = [[0x18, 0x30], [0x48, 0x10], [0x58, 0x10], [0xA8, 58]];
// ... and with its mode state (flags, the stick timer, the disabled frames): what a pad carries from before the recording
const PAD_STATE: [number, number][] = [[0x18, 0x50], [0xA8, 0x44]];
// the words Moonshine zeroes while its own interface owns the pad (suppressRetailPad)
const PAD_SUPPRESS = [0x18, 0x1C, 0x20, 0x30, 0xD0, 0xD4, 0xD8];
const MARIO_PAD = 0x4FC, MARIO_WORK = 0x108;   // TMario::mGamePad, its TMarioControllerWork
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
}

const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0');

export class Replay {
    m = new Machine();
    moonshine: Moonshine;
    issues: Issue[] = [];
    phase: 'boot' | 'stage' | 'done' = 'boot';
    /** counts of what matched */
    frames = 0; ticks = 0; calls = 0; literals = 0; marioChecked = 0; extraLoadFrames = 0; shimCalls = 0;
    /** the stage heap's size here minus the recording's (0: the same arena) */
    heapDelta = 0;
    /** instructions at the stage's start and at its first frame after setup */
    countAtStage = 0; countAtPlay = 0;
    private iFlow = 0; private iCall = 0; private lastCall = -1;
    private strict = false;
    private curFrame: TraceFrame | null = null; private curTick = 0;
    private padAdopted = false; private adopted = new Set<string>();
    private frozenState = -1; private suppressed: number[] | null = null; private suppressedPad = 0;
    private stopOn: Set<string>; private maxIssues: number;
    private log: (s: string) => void;
    private modLo = 0; private modHi = 0;

    constructor(dol: Uint8Array, disc: VirtualDisc, private T: Trace, private A: GameAddrs, sym: Sym, opt: ReplayOptions = {}) {
        const m = this.m, cpu = m.cpu;
        this.log = opt.log ?? (() => { });
        this.stopOn = new Set(opt.stopOn ?? ['heap', 'rand', 'mario', 'camera', 'flow']); this.maxIssues = opt.maxIssues ?? 50;
        m.load(dol, disc, opt.fstPad ?? 0);
        const missing = installHle(m, sym, { report: opt.report });
        if (missing.length) this.log('hle: not found: ' + missing.join(', '));
        this.moonshine = new Moonshine(m, A.region, A);
        this.moonshine.install();
        cpu.hook(A.PADRead, (c) => this.padRead(c));
        cpu.hook(A.PADClamp, () => { });
        cpu.hook(A.procLoopHead, (c) => { this.atProcLoop(c.gpr[31]); return false; });
        cpu.hook(A.setupCall, () => { this.atSetup(); return false; });
        cpu.hook(A.directCall, (c) => this.beforeDirect(c));
        cpu.hook(A.directRet, (c) => { this.afterDirect(c); return false; });
        cpu.hook(A.marioPerform, (c) => { if ((c.gpr[4] & 1) && this.phase === 'stage' && c.gpr[3] === m.mem.r32(A.gpMarioOriginal)) this.atTick(c.gpr[3], c.gpr[4]); return false; });
        cpu.hook(A.randRet, (c) => { if (this.phase === 'stage') this.atRand(c.lr); return false; });
        cpu.hook(A.fbCamera, (c) => { const v = this.literal(A.fbCamera + 4); if (v !== null) c.gpr[0] = v; return false; });
        cpu.hook(A.fbSilhouette, (c) => { const v = this.literal(A.fbSilhouette + 4); if (v !== null) c.gpr[0] = v; return false; });
        cpu.hook(A.fbWater, (c) => { const v = this.literal(A.fbWater + 4); if (v !== null) { const f = f32FromBits(v); c.ps0[1] = f; c.ps1[1] = f; } return false; });
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
        const session = st.session ?? new Uint8Array(64);
        this.moonshine.apply(session);
        this.modLo = this.moonshine.base; this.modHi = this.modLo + ARENA_RESERVE;
        this.log(`the logos ended at ${(this.m.cpu.count / 486e6).toFixed(2)} s: starting scene ${hex(w[4])} (from ${hex(w[3])})`);
    }
    private atSetup() {
        if (this.phase !== 'boot' || this.m.mem.r8(this.A.app + APP.state) !== 5) return;
        const mem = this.m.mem, A = this.A, st = this.T.stages[0], w = st.words;
        mem.w32(A.seed, w[6]); mem.w32(A.npcPhase, st.npcPhase);
        // the stage heap as the recording had it: the same size means the same arena
        const heap = mem.r32(A.app + APP.heap), start = mem.r32(heap + 0x30), end = mem.r32(heap + 0x34), head = mem.r32(heap + 0x6C), tail = mem.r32(heap + 0x70);
        if ((w[1] & 2) && (end - start !== w[11] || head - start !== w[9] || end - tail !== w[10])) {
            // the arena's top depends on the disc's file table, and the recording console's disc had other files:
            // the difference is what `fstPad` must be for the heap to be the recording's
            this.heapDelta = (end - start) - w[11];
            this.issue('heap', `the stage heap is ${hex(end - start)} bytes (used ${hex(head - start)} / ${hex(end - tail)}), the trace's ${hex(w[11])} (${hex(w[9])} / ${hex(w[10])})`);
            if (this.phase === 'done') return;
        }
        this.phase = 'stage'; this.countAtStage = this.m.cpu.count;
        this.iFlow = this.nextFlowFrom(st.ev + 1); this.iCall = this.nextCallFrom(st.ev + 1);
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
    private comparePad(obj: number, rec: Uint8Array, what: string) {
        const mem = this.m.mem;
        for (const [o, n] of PAD_SPANS) for (let i = 0; i < n; i++) if (mem.r8(obj + o + i) !== rec[IN.pad + o + i]) {
            const w = (o + i) & ~3;
            this.issue('pad', `${what}: the pad differs at +0x${w.toString(16)}: game ${hex(mem.r32(obj + w))}, trace ${hex(new DataView(rec.buffer, rec.byteOffset).getUint32(IN.pad + w))}`);
            return;
        }
    }

    // ---------------------------------------------------------------- frames
    private beforeDirect(c: { gpr: Uint32Array; pc: number }): boolean {
        if (this.phase !== 'stage') return false;
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
        this.curFrame = f; this.frames++;
        this.checkCalls(f.ev, `frame ${f.frame}`);
        if (this.phase !== 'stage') return false;
        if (f.session) this.moonshine.apply(f.session);
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
            this.comparePad(pad, p.input, 'at the frame');
            if (p.frozen && setupDone) {
                // Moonshine froze the stage: it lends the director a state that runs nothing for this call
                const d = mem.r32(A.gpMarDirector);
                this.frozenState = mem.r8(d + DIR.state); mem.w8(d + DIR.state, STATE_STAGE_EXIT_2);
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
        this.ticks++; this.curTick = t.tick;
        this.checkCalls(t.ev, `tick ${t.tick}`);
        if (this.phase !== 'stage') return;
        const dv = new DataView(t.input.buffer, t.input.byteOffset, IN.size);
        if (dv.getUint32(IN.cue) !== cue) this.issue('tick', `the perform cue is ${hex(cue)}, the trace's ${hex(dv.getUint32(IN.cue))}`);
        const valid = dv.getUint32(IN.valid);
        if (valid & 1) this.comparePad(mem.r32(mario + MARIO_PAD), t.input, 'at the tick');
        if (valid & 2) {
            const work = mem.r32(mario + MARIO_WORK);
            for (let k = 4; k < 0x24; k++) if (mem.r8(work + k) !== t.input[IN.work + k]) {
                const w = k & ~3;
                this.issue('pad', `Mario's controller work differs at +0x${w.toString(16)}: game ${hex(mem.r32(work + w))}, trace ${hex(dv.getUint32(IN.work + w))}`);
                break;
            }
        }
        if (t.mario) {
            // the occlusion bit comes from the GPU (the draw-sync callback): take the recording's
            const fo = mario + MARIO_FLAGS + 3;
            mem.w8(fo, (mem.r8(fo) & ~1) | (t.mario[MARIO_FLAGS + 3] & 1));
            this.marioChecked++;
            this.compareBlob('mario', 'Mario', mario, t.marioPtr, t.mario);
        }
        if (t.camera && this.phase === 'stage') this.compareBlob('camera', 'the camera', mem.r32(this.A.gpCamera), t.cameraPtr, t.camera);
    }
    /**
     * An object of the game against its record. At its first record, memory the game hasn't written yet (zero
     * on this freshly booted machine) holds whatever the console's heap had there: uninitialised memory is the
     * recording's to say, so those bytes are taken from it.
     */
    private compareBlob(kind: string, name: string, addr: number, recAddr: number, rec: Uint8Array) {
        const n = rec.length, mine = this.m.mem.bytes(addr, n);
        if (!this.adopted.has(kind)) {
            this.adopted.add(kind);
            const took: string[] = [];
            for (let k = 0; k < n; k++) if (mine[k] !== rec[k] && mine[k] === 0) { const w = (k & ~3).toString(16); if (took[took.length - 1] !== w) took.push(w); mine[k] = rec[k]; }
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
