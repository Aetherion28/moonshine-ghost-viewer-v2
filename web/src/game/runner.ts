// Runs the stage's game code alongside a ghost: the stage from the disc (its archive, params.szs,
// common.szs, scenecmn.bin), Mario from the ghost's samples, the game camera from its camera
// record, run up to the viewer's time; scrubbing back starts the stage over. The enemies' own
// classes register themselves (import them below).

import * as RARC from '../../noclip/Common/JSYSTEM/JKRArchive.js';
import * as Yaz0 from '../../noclip/Common/Compression/Yaz0.js';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import type { GameFS } from '../disc.js';
import { Stage, StageFiles, GameCamera } from './scene.js';
import { MarioSample, MarioTrack } from './mario.js';
import { LiveActor, NameRef, World, calcKeyCode } from './engine.js';
import { rngCtx } from './math.js';
import './npc/manager.js';
import './enemies/pakkun.js';
import './enemies/sambo.js';
import './enemies/bosspakkun.js';
import './enemies/amenbo.js';
import './enemies/telesa.js';
import './enemies/effectEnemy.js';
import './enemies/yumbo.js';
import './enemies/kukku.js';
import './enemies/kazekun.js';
import './enemies/generator.js';
import './enemies/launcher.js';
import './enemies/popo.js';
import './enemies/namekuri.js';
import './enemies/igaiga.js';
import './enemies/gatekeeper.js';
import './enemies/animal.js';
import './enemies/boid.js';
import './enemies/bird.js';
import './enemies/beehive.js';
import './enemies/hamukuri.js';
import './enemies/wiretrap.js';
import './enemies/seal.js';
import './enemies/effectObj.js';
import './enemies/aminoko.js';
import './enemies/kumokun.js';
import './enemies/firewanwan.js';
import './enemies/bosswanwan.js';
import './enemies/egggen.js';
import './enemies/gesso.js';
import './enemies/mamegesso.js';
import './enemies/tobipuku.js';
import './enemies/riccohook.js';
import './enemies/bossgesso.js';
import { mapObjWorldHooks } from './mapobj/index.js';
import './player/emario.js';
import { setMarioArchive } from './player/base.js';
import { PlayerMario, introTiming } from './player/player.js';
import type { PadStatus } from './player/pad.js';
import { NO_PAD } from './player/pad.js';
import type { StickCamera } from './camera/types.js';
import { matan, s16 } from './math.js';

// enemies' coins come out of the item manager's pool (gpItemManager)
Object.assign(World.prototype, mapObjWorldHooks);

export interface FileMap { files: Map<string, Uint8Array>; dirs: Map<string, string[]>; }
export function fileMap(arc: RARC.JKRArchive): FileMap {
    const files = new Map<string, Uint8Array>(), dirs = new Map<string, string[]>();
    const walk = (d: RARC.RARCDir, prefix: string) => {
        const list: string[] = [];
        for (const f of d.files) { files.set((prefix + f.name).toLowerCase(), f.buffer.createTypedArray(Uint8Array)); list.push(f.name.toLowerCase()); }
        dirs.set(prefix.replace(/\/$/, '').toLowerCase(), list);
        for (const s of d.subdirs) if (s.name !== '.' && s.name !== '..') walk(s, prefix + s.name + '/');
    };
    walk(arc.root, '');
    return { files, dirs };
}
const parse = (buf: ArrayBuffer) => {
    let b = new ArrayBufferSlice(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === 'Yaz0') b = Yaz0.decompressSW(b);
    return fileMap(RARC.parse(b));
};

/** The disc's files every stage uses (read once). */
export class DiscCommon {
    params: FileMap | null = null; common: FileMap | null = null; scenecmn: Uint8Array | null = null;
    static async load(fs: GameFS) {
        const c = new DiscCommon();
        try { c.params = parse(await fs.read('data/params.szs')); } catch (e) { console.warn('[game] params.szs', e); }
        try { c.common = parse(await fs.read('data/common.szs')); } catch (e) { console.warn('[game] common.szs', e); }
        try { if (fs.has('data/scenecmn.bin')) c.scenecmn = new Uint8Array(await fs.read('data/scenecmn.bin')); } catch { }
        // Mario's archive (the simulated Marios' animations and params: Shadow Mario)
        try { const m = parse(await fs.read('data/mario.szs')); setMarioArchive((p) => m.files.get(p.toLowerCase()) || null); } catch (e) { console.warn('[game] mario.szs', e); }
        return c;
    }
    stageFiles(scene: FileMap): StageFiles {
        return {
            scene: (p) => scene.files.get(p.toLowerCase()) || null,
            folder: (p) => scene.dirs.get(p.toLowerCase()) || [],
            params: (p) => (this.params && this.params.files.get(p.toLowerCase())) || null,
            common: (p) => (this.common && this.common.files.get(p.toLowerCase())) || null,
            scenecmn: this.scenecmn,
        };
    }
}

/** What the viewer hands over each frame: the ghost (its parsed data) and the time. */
export interface SimInput {
    /** the viewer's time (QF from the ghost's start) */
    t: number;
    /** parseSmsGhost's result */
    ghost: any;
    /** the page's ghost.js accessors */
    api: { ghostSampleAt(g: any, t: number): any; ghostAnimAt(g: any, t: number): any; ghostFluddAt(g: any, t: number): any; ghostCameraAt?(g: any, t: number, seg?: number): any };
}

/**
 * A ghost's RNG tape (SGRN, ghost.js's parseRngTape) replayed: each object's rand() calls get the
 * rolls the game gave that object (the tape's actor: its scene-name key code, in the order objects
 * first rolled), in order, around the same QF; graph choices a Moonshine RNG control made are
 * taken too. Calls the tape has nothing for fall back to the sim's own LCG.
 */
export class RngReplay {
    private byActor = new Map<number, number[]>();
    private ptr = new Map<number, number>();
    private assigned = new Map<object, number>();
    private taken = new Set<number>();
    private nodes = new Map<number, { qf: number; node: number; used: boolean }[]>();
    constructor(private tape: any, private seg: number, private q0: number, private qfNow: () => number) {
        for (let i = 0; i < tape.count; i++) {
            if (tape.segment[i] !== seg || tape.actor[i] < 0) continue;
            const a = tape.actor[i];
            (this.byActor.get(a) || this.byActor.set(a, []).get(a)!).push(i);
        }
        for (const o of tape.nodeOverrides) if (o.actor >= 0) (this.nodes.get(o.actor) || this.nodes.set(o.actor, []).get(o.actor)!).push({ qf: o.qf, node: o.node, used: false });
    }
    private actorOf(who: object | null): number {
        if (!who) return -1;
        const got = this.assigned.get(who);
        if (got !== undefined) return got;
        const name = (who as NameRef).name;
        if (typeof name !== 'string') return -1;
        const key = calcKeyCode(name);
        let found = -1;
        for (let a = 0; a < this.tape.actors.length; a++) if (!this.taken.has(a) && this.tape.actors[a].keyCode === key && this.byActor.has(a)) { found = a; break; }
        if (found >= 0) this.taken.add(found);
        this.assigned.set(who, found);
        return found;
    }
    roll = (who: object | null): number | null => {
        const a = this.actorOf(who);
        if (a < 0) return null;
        const L = this.byActor.get(a)!, T = this.tape;
        let p = this.ptr.get(a) || 0;
        const Q = this.qfNow();
        // rolls the sim never asked for (it fell behind) are passed over
        while (p < L.length && T.qf[L[p]] === T.qf[L[p]] && T.qf[L[p]] < Q - 8) p++;
        if (p >= L.length || (T.qf[L[p]] === T.qf[L[p]] && T.qf[L[p]] > Q + 4)) { this.ptr.set(a, p); return null; }
        this.ptr.set(a, p + 1);
        return T.used[L[p]];
    };
    node = (who: object | null): number | null => {
        const a = this.actorOf(who);
        const L = a >= 0 ? this.nodes.get(a) : undefined;
        if (!L) return null;
        const Q = this.qfNow();
        for (const o of L) if (!o.used && (o.qf !== o.qf || Math.abs(o.qf - Q) <= 8)) { o.used = true; return o.node; }
        return null;
    };
}

/** How the sim's input replay is going for a stage (segment): where it first drifted from the ghost. */
export interface ReplaySync {
    /** the player is simulated from the inputs (else the ghost's samples move Mario) */
    replay: boolean;
    /** ghost QF of the first frame the sim's Mario was more than 1 unit off the ghost (-1: in sync so far) */
    firstDriftQf: number;
    /** that frame's error, and the most since (units) */
    driftErr: number; maxErr: number;
    /** frames compared, and frames bit-exact (to the ghost's 1/8 unit) before the first drift */
    frames: number; exactFrames: number;
    /** the stick's camera: 'recorded' (v8 SGCA), 'sim' (the game camera port), 'approx' (behind Mario) */
    camera: string;
    /** QF Mario lost a life (the run continues) */
    lostLives: number[];
    /**
     * Ghost QF of the segment's first input record when it came after the first frame Mario had
     * control (controlQf: Moonshine before 2026-10 began the records a frame late), else -1; the
     * unrecorded frames are replayed neutral, so a stick held then (the C-stick, say) is lost.
     */
    lateInputsQf: number; controlQf: number;
}

/** The ghost's controller record of a frame (its QF is the frame's last tick), as the PADStatus the game read. */
export function ghostPad(I: any, i: number): PadStatus {
    return { button: I.buttons[i], stickX: I.stick[i * 2], stickY: I.stick[i * 2 + 1], substickX: I.cstick[i * 2], substickY: I.cstick[i * 2 + 1],
        triggerLeft: I.trig[i * 2], triggerRight: I.trig[i * 2 + 1], analogA: I.analogAB[i * 2], analogB: I.analogAB[i * 2 + 1] };
}

/**
 * gpCamera->unk258 from a v8 ghost's recorded camera: the yaw from the camera's target to the camera,
 * the view's backwards direction (its rotation is the view matrix's: world to view). Mario reads the
 * one of the tick before his (the camera moves after him), so the recorded view at that QF.
 */
export function recordedStickCamera(at: (qf: number) => { quat: [number, number, number, number] } | null, qfNow: () => number, fallback: () => number): StickCamera {
    return {
        yaw: () => {
            const c = at(qfNow() - 1);
            if (!c) return fallback();
            const [x, y, z, w] = c.quat;
            // the view's -Z in the world: the conjugate rotation of (0, 0, -1)
            const fx = -2 * (x * z - w * y), fz = -(1 - 2 * (x * x + y * y));
            return matan(-fz, -fx);
        },
    };
}

/**
 * The input replay's Mario, frame by frame (ghost QFs from the ghost's start): what the viewer draws,
 * voices and shows in place of the ghost's samples while the replay runs. Read like the ghost's
 * samples: position linear between frames, yaw the shortest way, animation phase (0..4096)
 * carried when the animation stays the same.
 */
export class ReplayHistory {
    qf: number[] = []; pos: number[] = []; yaw: number[] = []; anim: number[] = []; phase: number[] = [];
    /** FLUDD: -1 none, else its nozzle (| 0x10 while it sprays) */
    fludd: number[] = [];
    constructor(public ghost: any, public from: number) { }
    get last() { return this.qf.length ? this.qf[this.qf.length - 1] : -1; }
    push(qf: number, P: PlayerMario) {
        this.qf.push(qf); this.pos.push(P.pos.x, P.pos.y, P.pos.z); this.yaw.push(P.mModelFaceAngle);
        this.anim.push(P.mAnimationId); this.phase.push(Math.round(P.phase * 4096) & 4095);
        const f = P.fludd;
        this.fludd.push(f ? (f.nozzle & 7) | (f.spraying ? 0x10 : 0) : -1);
    }
    /** the frame at or before t (-1: t is outside what the replay has run) */
    index(t: number): number {
        const q = this.qf, n = q.length;
        if (!n || t < this.from || t < q[0] || t > q[n - 1] + 4) return -1;
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (q[mid] <= t) lo = mid; else hi = mid - 1; }
        return lo;
    }
    sampleAt(t: number) {
        const i = this.index(t);
        if (i < 0) return null;
        const P = this.pos, j = Math.min(i + 1, this.qf.length - 1), f = j > i ? (t - this.qf[i]) / (this.qf[j] - this.qf[i]) : 0;
        const dy = (((this.yaw[j] - this.yaw[i]) + 32768) & 0xffff) - 32768;
        return { x: P[i * 3] + (P[j * 3] - P[i * 3]) * f, y: P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * f, z: P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * f, yaw: this.yaw[i] + dy * f };
    }
    animAt(t: number) {
        const i = this.index(t);
        if (i < 0) return null;
        const j = i + 1;
        let phase = this.phase[i];
        if (j < this.qf.length && this.anim[j] === this.anim[i]) {
            const f = (t - this.qf[i]) / (this.qf[j] - this.qf[i]);
            const d = ((((this.phase[j] - phase) + 2048) % 4096) + 4096) % 4096 - 2048;
            phase = (((phase + d * f) % 4096) + 4096) % 4096;
        }
        return { id: this.anim[i], yoshi: 0, phase };
    }
    fluddAt(t: number) {
        const i = this.index(t);
        return i < 0 ? undefined : this.fludd[i];
    }
}

/**
 * The RNG tape's SEED for a segment (MSL rand()'s next when that stage began): the first SEED in the
 * segment that comes before any of its rolls (ghost.js parseRngTape's tape.seeds); null without one.
 */
export function stageSeed(g: any, segment: number): number | null {
    const t = g && g.rng;
    if (!t || !t.seeds) return null;
    let first = t.count;
    for (let i = 0; i < t.count; i++) if (t.segment[i] === segment) { first = i; break; }
    for (const sd of t.seeds) if (sd.segment === segment && sd.roll <= first) return sd.state >>> 0;
    return null;
}

export class SimRunner {
    private rng: RngReplay | null = null;
    /** run Mario from the ghost's inputs where it has them (the viewer's "Input replay") */
    inputReplay = true;
    /** this stage's input replay (null: the ghost's samples move Mario) */
    sync: ReplaySync | null = null;
    /** the replay's Mario so far (null: the ghost's samples move Mario) */
    history: ReplayHistory | null = null;
    private pads: Map<number, number> | null = null;
    stage: Stage | null = null;
    private key = '';
    /** ghost QF of the stage's first tick */
    q0 = 0;
    error: any = null;
    constructor(public disc: DiscCommon) { }

    /** The ghost as Mario: its samples from the stage's start. */
    private track(inp: SimInput): MarioTrack {
        const g = inp.ghost, A = inp.api, q0 = this.q0;
        return {
            at: (q: number): MarioSample | null => {
                const t = q0 + q;
                const s = A.ghostSampleAt(g, t);
                if (!s || s.gap) return null;
                const a = A.ghostAnimAt(g, t), f = A.ghostFluddAt(g, t);
                const h = g.held ? g.held[s.i] : 0, att = h && h !== 15 && g.attachments ? g.attachments[h - 1] || null : null;
                return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, anim: a.id, phase: a.phase / 4096, yoshi: !!a.yoshi, fludd: f && f.present ? f : null, held: att };
            },
        };
    }

    /**
     * Bring the stage to the viewer's time: scene the stage archive drawn (its files), segment the
     * ghost's segment there. Runs at most budgetMs; true once it's caught up.
     */
    update(sceneName: string, scene: FileMap, inp: SimInput, budgetMs = 20): boolean {
        const g = inp.ghost;
        if (!g || !g.segments) return false;
        // the segment the time is in: its stage starts at its first QF
        const s = inp.api.ghostSampleAt(g, inp.t);
        const segI = s ? g.segIndex[s.i] : 0;
        const seg = g.segments[segI];
        if (!seg) return false;
        const q0 = seg.startQf - g.header.startQf;
        const I = g.inputs;
        const replay = this.inputReplay && !!I && I.count > 0 && (() => { for (let i = 0; i < I.count; i++) { const q = I.qf[i]; if (q >= q0 && q <= seg.endQf - g.header.startQf) return true; } return false; })();
        const key = `${sceneName}|${segI}|${q0}|${replay}`;
        const want = inp.t - q0;
        if (this.key !== key || !this.stage || this.stage.qf > want + 4) {
            this.key = key; this.q0 = q0; this.error = null;
            let intro = null;
            if (replay) {
                const ss: { qf: number; anim: number; phase: number }[] = [];
                for (let i = seg.firstSample; i < seg.firstSample + seg.sampleCount; i++) { const q = g.qf[i] - q0; if (q > 0) ss.push({ qf: q, anim: g.anim[i], phase: g.phase[i] }); }
                intro = introTiming(ss, I, q0, seg.endQf - g.header.startQf);
            }
            // MSL rand()'s state at the stage's start (srand(OSGetTick()) at boot, then everything before
            // it): the ghost's RNG tape SEED for this segment when it has one, else 0
            const seed = stageSeed(g, segI);
            try { this.stage = Stage.fresh(this.disc.stageFiles(scene), sceneName, seg.route.area, seg.route.episode, seed ?? 0, 0, intro); }
            catch (e) { this.error = e; this.stage = null; console.warn('[game] stage', e); return false; }
            const st0 = this.stage;
            this.pads = null; this.sync = null; this.history = null;
            if (st0.player) {
                const P = st0.player;
                this.pads = new Map();
                for (let i = 0; i < I.count; i++) this.pads.set(I.qf[i] - q0, i);
                let cam = P.cameraApprox ? 'approx' : 'sim';
                if (g.camera && inp.api.ghostCameraAt) {
                    const at = inp.api.ghostCameraAt;
                    P.setStickCamera(recordedStickCamera((q) => at(g, q0 + q, segI), () => st0.qf, () => s16(P.mFaceAngle.y + 0x8000)), false);
                    cam = 'recorded';
                }
                this.history = new ReplayHistory(g, q0 + Math.max(0, P.driftFrom));
                this.sync = { replay: true, firstDriftQf: -1, driftErr: 0, maxErr: 0, frames: 0, exactFrames: 0, camera: cam, lostLives: P.lostLives, lateInputsQf: -1, controlQf: -1 };
            } else this.sync = { replay: false, firstDriftQf: -1, driftErr: 0, maxErr: 0, frames: 0, exactFrames: 0, camera: '', lostLives: [], lateInputsQf: -1, controlQf: -1 };
            this.rng = g.rng ? new RngReplay(g.rng, segI, q0, () => q0 + st0.qf) : null;
        }
        const st = this.stage!;
        const track = this.track(inp);
        const t0 = performance.now();
        while (st.qf + 4 <= want) {
            st.camera = this.camera(inp, q0 + st.qf + 4, segI);
            rngCtx.roll = this.rng ? this.rng.roll : null; rngCtx.node = this.rng ? this.rng.node : null;
            try { st.runFrame(track, st.player ? this.padAt(inp.ghost, st.qf + 4) : null); } catch (e) { this.error = e; console.warn('[game] frame', e); this.stage = null; return false; }
            finally { rngCtx.roll = null; rngCtx.node = null; }
            if (st.player && this.history) this.history.push(q0 + st.qf, st.player);
            if (st.player && this.sync) {
                const d = st.player.drift, S = this.sync;
                S.firstDriftQf = d.firstQf >= 0 ? q0 + d.firstQf : -1; S.driftErr = d.firstErr; S.maxErr = d.maxErr; S.frames = d.frames; S.exactFrames = d.synced;
                // the first frame with a controllable tick (GAME_INPUT from the tick after gameTick) has
                // no record: the inputs were recorded from a later frame
                const D = st.director;
                if (D && D.gameTick >= 0 && S.controlQf < 0) {
                    const first = Math.ceil((D.gameTick + 1) / 4) * 4;
                    S.controlQf = q0 + first;
                    let rec = -1; for (let i = 0; i < I.count; i++) { const q = I.qf[i] - q0; if (q >= first && (rec < 0 || q < rec)) rec = q; }
                    if (rec > first) { S.lateInputsQf = q0 + rec; console.warn(`[player] the ghost's inputs start at stage QF ${rec}, ${(rec - first) / 4} frame(s) after Mario got control (QF ${first}): those frames replay neutral`); }
                }
            }
            if (performance.now() - t0 > budgetMs) return false;
        }
        return true;
    }
    /** the frame's PADStatus (its record's QF is the frame's last tick); none recorded: a neutral pad */
    private padAt(g: any, q: number): PadStatus {
        const i = this.pads ? this.pads.get(q) : undefined;
        return i === undefined ? { ...NO_PAD } : ghostPad(g.inputs, i);
    }
    /** the simulated player, when this stage runs from the inputs */
    get player(): PlayerMario | null { return this.stage ? this.stage.player : null; }
    private camera(inp: SimInput, t: number, seg: number): GameCamera | null {
        const f = inp.api.ghostCameraAt;
        if (!f) return null;
        const c = f(inp.ghost, t, seg);
        if (!c) return null;
        return { pos: c.pos, quat: c.quat, fovy: c.fov, aspect: (640 * 0.9134614) / 448, near: 10 };
    }

    /** The simulated objects the viewer draws, with their placement in scene.bin (type, position). */
    drawables(): { a: LiveActor; type: string; place: [number, number, number] }[] {
        const st = this.stage;
        if (!st) return [];
        const out: { a: LiveActor; type: string; place: [number, number, number] }[] = [];
        const add = (o: NameRef) => {
            if (!(o instanceof LiveActor) || !o.mactor) return;
            const n = st.nodeOf.get(o);
            out.push({ a: o, type: n ? n.type : '', place: o.loadPos ? [o.loadPos.x, o.loadPos.y, o.loadPos.z] : [o.pos.x, o.pos.y, o.pos.z] });
        };
        for (const m of st.world.conductor.liveManagers) for (const o of m.objs) add(o as any);
        for (const o of st.world.conductor.aloneActors) add(o);
        for (const x of st.extraDrawables()) add(x);
        return out;
    }
}
export { calcKeyCode };
