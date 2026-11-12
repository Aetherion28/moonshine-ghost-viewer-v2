// Runs the stage's game code alongside a ghost: the stage from the disc (its archive, params.szs,
// common.szs, scenecmn.bin), Mario from the ghost's samples, the game camera from its camera
// record, run up to the viewer's time; scrubbing back starts the stage over. The enemies' own
// classes register themselves (import them below).

import { useGhostVersion, useDiscVersion } from './version.js';
import * as RARC from '../../noclip/Common/JSYSTEM/JKRArchive.js';
import * as Yaz0 from '../../noclip/Common/Compression/Yaz0.js';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import type { GameFS } from '../disc.js';
import { Stage, StageFiles, GameCamera } from './scene.js';
import { MarioSample, MarioTrack } from './mario.js';
import { LiveActor, NameRef, World, calcKeyCode, LF, shineIDofExStage } from './engine.js';
import { rngCtx, srand, fr } from './math.js';
import { CraneRotY } from './mapobj/ricco.js';
import { TraceFeeds, traceSessionAtStart, SessionField, traceGarbageCtx, traceGarbageOf } from './feedback.js';
import { npcSinkSetup, npcSinkCounterOf } from './npc/base.js';
import type { MarioView } from '../ghost/mstr.js';
import type { TraceActors } from '../ghost/mstrghost.js';
import './npc/manager.js';
import './stageevent.js';
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
import './enemies/enemytable.js';
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
import './enemies/hauntleg.js';
import './enemies/hinokuri2.js';
import './enemies/chuuhana.js';
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
import './enemies/koopa.js';
import './enemies/koopajr.js';
import './enemies/bathtub.js';
import './enemies/bosseel.js';
import './enemies/tabepuku.js';
import './enemies/bombhei.js';
import './enemies/cannon.js';
import './enemies/debutelesa.js';
import './enemies/bossmanta.js';
import './enemies/bosstelesa.js';
import './enemies/killer.js';
import './enemies/tamanoko.js';
import './enemies/elecnokonoko.js';
import './enemies/tinkoopa.js';
import './enemies/rocket.js';
import './enemies/coasterkiller.js';
import './enemies/limitkoopa.js';
import './enemies/poihana.js';
import './enemies/fruitsboat.js';
import './enemies/typical.js';
import './enemies/bosshanachan.js';
import { mapObjWorldHooks } from './mapobj/index.js';
import './player/emario.js';
import { setMarioArchive } from './player/base.js';
import { setYoshiArchive } from './player/yoshi.js';
import { PlayerMario, introTiming, introDemoEndInFrame } from './player/player.js';
import type { PadStatus } from './player/pad.js';
import { NO_PAD } from './player/pad.js';
import type { StickCamera } from './camera/types.js';
import { matan, s16 } from './math.js';
import './bathwater.js';
import './splash.js';
import { writeSmsGhost, type GhostFrame, type GhostSegment } from './ghostwrite.js';
import { LiveDirector, LiveTiming, decideMarioPosIdx, entranceStart, gotShineFromSamples, moveStage, decideNextStageOfMiss, plazaDemoOnStart, stageDemoName, liveRunCarry, loadGapQf, Area, selectMenuInput } from './stagechange.js';
import { FlagManager, MSF, flagsFromTraceImage } from './flags.js';
import { loadSlot, storeSlot, eraseSlot, readSave, writeSave, startArea, SAVE_SIZE, storeOption, loadOptionBlock } from './savefile.js';
import { DIR } from './player/player.js';
import { parseStageArc, sceneForRoute } from '../stagearc.js';
import './mapevent.js';

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
    /** data/stageArc.bin: each area's scenes by episode (live play's stage changes) */
    stageArc: string[][] | null = null;
    static async load(fs: GameFS) {
        const c = new DiscCommon();
        try { c.stageArc = parseStageArc(await fs.read('data/stageArc.bin')); } catch (e) { console.warn('[game] stageArc.bin', e); }
        try { c.params = parse(await fs.read('data/params.szs')); } catch (e) { console.warn('[game] params.szs', e); }
        try { c.common = parse(await fs.read('data/common.szs')); } catch (e) { console.warn('[game] common.szs', e); }
        // PAL keeps common.szs's 2d folder (sys_message.bmg, the talks' system messages: Fast text's
        // fallback among them) in a per-language archive, data/cmn2d_<lang>.szs, mounted as /common/2d.
        // The language is the console's; English here (the system messages' entries are laid out alike).
        try {
            for (const lang of ['en', 'fr', 'ge', 'it', 'sp']) {
                const path = `data/cmn2d_${lang}.szs`;
                if (!c.common || !fs.has(path)) continue;
                const d = parse(await fs.read(path));
                for (const [k, v] of d.files) if (!c.common.files.has('2d/' + k)) c.common.files.set('2d/' + k, v);
                break;
            }
        } catch (e) { console.warn('[game] cmn2d', e); }
        try { if (fs.has('data/scenecmn.bin')) c.scenecmn = new Uint8Array(await fs.read('data/scenecmn.bin')); } catch { }
        // Mario's archive (the simulated Marios' animations and params: Shadow Mario)
        try { const m = parse(await fs.read('data/mario.szs')); setMarioArchive((p) => m.files.get(p.toLowerCase()) || null); } catch (e) { console.warn('[game] mario.szs', e); }
        // Yoshi's (TYoshi: his model's joints and animations)
        try { if (fs.has('data/yoshi.szs')) setYoshiArchive(parse(await fs.read('data/yoshi.szs'))); } catch (e) { console.warn('[game] yoshi.szs', e); }
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
    /** times the replay was put back on the ghost (PlayerMario.correctDrift) */
    corrections?: number;
    /** the stick's camera: 'recorded' (v8 SGCA), 'hybrid' (the sim's, kept in the recorded one's yaw bucket), 'sim' (the game camera port), 'approx' (behind Mario) */
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
 * A v8 ghost's recorded camera keys of one pose segment by ghost QF (the frame they end): each the
 * rendered view's forward (eye to look-at) yaw, s16 units unrounded, and its eye. The keys are the
 * exact view of their frame (every 4th frame, sooner at a cut); ghostCameraAt's in-betweens are not.
 */
export function recordedCameraKeys(g: any, seg: number): Map<number, { fwd: number; pos: { x: number; y: number; z: number } }> {
    const out = new Map<number, { fwd: number; pos: { x: number; y: number; z: number } }>();
    const c = g && g.camera;
    if (!c) return out;
    for (let i = 0; i < c.count; i++) {
        if ((c.tag[i] & 63) !== seg) continue;
        const x = c.quat[i * 4], y = c.quat[i * 4 + 1], z = c.quat[i * 4 + 2], w = c.quat[i * 4 + 3];
        // the view's -Z in the world: the conjugate rotation of (0, 0, -1)
        const fx = -2 * (x * z - w * y), fz = -(1 - 2 * (x * x + y * y));
        out.set(c.qf[i], { fwd: Math.atan2(fx, fz) * (32768 / Math.PI), pos: { x: c.pos[i * 3], y: c.pos[i * 3 + 1], z: c.pos[i * 3 + 2] } });
    }
    return out;
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
    /** frontSlipEffect's emitters this frame: 0 none, 1 watslide a/b/c, 2 slip smoke, 3 slide sand */
    slip: number[] = [];
    /** the drops FLUDD's water manager made this frame (what the nozzle mist and spray follow) */
    emit: number[] = [];
    private emitted = -1;
    /** the voice lines the simulated Mario asked for (TMario::startVoice), at their tick's ghost QF, in order */
    voices: { qf: number; id: number; ifNoVoice?: boolean; unlessId?: number; stop?: boolean }[] = [];
    /**
     * The sim's Yoshi each frame (player/yoshi.ts viewState): his TYoshi state (-1: an egg, not drawn),
     * place, facing (s16), BCK (yoshi.szs's index) and frame, the walk blend's weight and his juice
     * (mType: the body colour, bodyColor[mType]).
     */
    yState: number[] = []; yPos: number[] = []; yYaw: number[] = []; yBck: number[] = []; yFrame: number[] = []; yBlend: number[] = []; yType: number[] = [];
    /** the upper body's own motion each frame (PlayerMario.upperAnim: the pump, a held object's, the damage flinch): its BCK (-1: none) and frame */
    upBck: number[] = []; upFrame: number[] = [];
    constructor(public ghost: any, public from: number) { }
    get last() { return this.qf.length ? this.qf[this.qf.length - 1] : -1; }
    push(qf: number, P: PlayerMario) {
        const dp = P.drawPos;   // (the drawn place: on a pole or tree his base matrix's, off its axis)
        this.qf.push(qf); this.pos.push(dp.x, dp.y, dp.z); this.yaw.push(P.mModelFaceAngle);
        const FA = P.followAnim;   // (following the ghost: its animation)
        this.anim.push(FA ? FA.anim : P.mAnimationId); this.phase.push(Math.round((FA ? FA.phase : P.phase) * 4096) & 4095);
        const f = P.fludd;
        this.fludd.push(f ? (f.nozzle & 7) | (f.spraying ? 0x10 : 0) : -1);
        this.slip.push(P.slipFx); P.slipFx = 0;
        const Y = P.mYoshi ? P.mYoshi.viewState() : null;
        this.yState.push(Y ? Y.state : -1); this.yPos.push(Y ? Y.x : 0, Y ? Y.y : 0, Y ? Y.z : 0); this.yYaw.push(Y ? Y.yaw : 0);
        this.yBck.push(Y ? Y.bck : -1); this.yFrame.push(Y ? Y.frame : 0); this.yBlend.push(Y ? Y.blend : 0); this.yType.push(Y ? Y.type : 0);
        const U = P.upperAnim; this.upBck.push(U ? U.bck : -1); this.upFrame.push(U ? U.frame : 0);
        const W = P.world.water, tot = W ? W.emitted : 0;
        const made = this.emitted < 0 || tot < this.emitted ? 0 : tot - this.emitted;
        this.emitted = tot; this.emit.push(made);
        if (!made && this.fludd[this.fludd.length - 1] > 0) this.fludd[this.fludd.length - 1] &= ~0x10;   // (no water came out: not spraying, whatever the trigger)
        // the frame's voice lines: tick k of the world's count was QF qf - (now - k)
        const now = P.world.tickCount;
        for (const v of P.voiceLog) this.voices.push({ qf: qf - (now - v.tick), id: v.id, ifNoVoice: v.ifNoVoice, unlessId: v.unlessId, stop: v.stop });
        P.voiceLog.length = 0;
    }
    /** the voice lines from just after t0 to t */
    voicesIn(t0: number, t: number) {
        const V = this.voices, out: typeof V = [];
        let lo = 0, hi = V.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (V[mid].qf <= t0) lo = mid + 1; else hi = mid; }
        for (let i = lo; i < V.length && V[i].qf <= t; i++) out.push(V[i]);
        return out;
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
        // on Yoshi his animation is a BCK index (TMario::setAnimation's yo_*): the ghost's yoshi field (colour 1-4)
        const yoshi = this.yState.length > i && this.yState[i] === 8 ? this.yType[i] + 1 : 0;
        return { id: this.anim[i], yoshi, phase };
    }
    /** the sim's upper-body motion at t ({ bck, frame }; null: none, or outside what the replay ran) */
    upperAt(t: number) {
        const i = this.index(t);
        if (i < 0 || i >= this.upBck.length || this.upBck[i] < 0) return null;
        const j = Math.min(i + 1, this.qf.length - 1);
        let frame = this.upFrame[i];
        if (j > i && this.upBck[j] === this.upBck[i] && this.upFrame[j] >= frame) frame += (this.upFrame[j] - frame) * ((t - this.qf[i]) / (this.qf[j] - this.qf[i]));
        return { bck: this.upBck[i], frame };
    }
    /** the sim's Yoshi at t (null: an egg / not hatched; undefined: outside what the replay ran) */
    yoshiAt(t: number) {
        const i = this.index(t);
        if (i < 0) return undefined;
        if (this.yState[i] < 0) return null;
        const j = Math.min(i + 1, this.qf.length - 1), f = j > i && this.yState[j] >= 0 ? (t - this.qf[i]) / (this.qf[j] - this.qf[i]) : 0;
        const P = this.yPos, dy = (((this.yYaw[j] - this.yYaw[i]) + 32768) & 0xffff) - 32768;
        let frame = this.yFrame[i];
        if (j > i && this.yBck[j] === this.yBck[i] && this.yFrame[j] >= frame) frame += (this.yFrame[j] - frame) * f;
        return { state: this.yState[i], mounted: this.yState[i] === 8, x: P[i * 3] + (P[j * 3] - P[i * 3]) * f, y: P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * f, z: P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * f,
            yaw: this.yYaw[i] + dy * f, anim: this.yBck[i], frame, blend: this.yBlend[i], type: this.yType[i] };
    }
    emitAt(t: number) {
        const i = this.index(t);
        return i < 0 ? undefined : this.emit[i];
    }
    slipAt(t: number) {
        const i = this.index(t);
        return i < 0 ? undefined : this.slip[i];
    }
    fluddAt(t: number) {
        const i = this.index(t);
        return i < 0 ? undefined : this.fludd[i];
    }
}

/** Delfino Plaza's start for a trace (see the caller): the recorded previous scene's entrance or the plain start, whichever lands nearer the first recorded position. */
export function plazaTraceStart(m: PlayerMario, c: { flags: FlagManager; prevArea: number }, got: boolean | undefined, pos: ArrayLike<number>) {
    const d = () => Math.hypot(m.pos.x - pos[0], m.pos.y - pos[1], m.pos.z - pos[2]);
    // (the entrance reads the save's flags as the world's: the recorded ones for it, the stage's own after)
    const own = m.world.flags;
    m.world.flags = c.flags;
    try { entranceStart(m.world, decideMarioPosIdx(c.flags, 1, c.prevArea), c.prevArea, got)(m); } finally { m.world.flags = own; }
    if (d() < 1) return;
    // the entrance isn't where the recording has him: the plain start, unless that's further still
    const x = m.pos.x, y = m.pos.y, z = m.pos.z, entrance = d();
    m.waitingStart(null, 0);
    if (d() > entrance) { m.world.flags = c.flags; try { entranceStart(m.world, decideMarioPosIdx(c.flags, 1, c.prevArea), c.prevArea, got)(m); } finally { m.world.flags = own; } }
}

/**
 * A trace's first stage as the game set it up: TFlagManager's values (the stage-start record's initial
 * flags, flagsFromTraceImage) and the area the run came from. null for a later segment or without them.
 */
/**
 * A trace's actors alive (LIVE_FLAG_DEAD, 1, clear) at their first record, by position (x,y,z as f32).
 * Moonshine can change the save's flags after the stage-start record's flag image (a Yoshi egg recorded
 * alive where the image's flags would have it dead), so a load that decides by those flags takes the
 * recorded outcome instead (EggYoshi.load). null without actor records.
 */
/** a trace's actors' hit filters at their first record, by exact position (World.traceHitFilterAt) */
export function traceActorsHitFilter(g: any): Map<string, number> | null {
    const A = g && g.trace && g.trace.actors as TraceActors | undefined;
    if (!A || !A.count || !A.hitFilter) return null;
    const seen = new Set<number>(), out = new Map<string, number>();
    for (let i = 0; i < A.count; i++) {
        if (seen.has(A.id[i])) continue;
        seen.add(A.id[i]);
        out.set(A.pos[i * 3] + ',' + A.pos[i * 3 + 1] + ',' + A.pos[i * 3 + 2], A.hitFilter[i] >>> 0);
    }
    return out;
}

export function traceActorsAlive(g: any): Map<string, boolean> | null {
    const A = g && g.trace && g.trace.actors as TraceActors | undefined;
    if (!A || !A.count) return null;
    const seen = new Set<number>(), out = new Map<string, boolean>();
    for (let i = 0; i < A.count; i++) {
        if (seen.has(A.id[i])) continue;
        seen.add(A.id[i]);
        out.set(A.pos[i * 3] + ',' + A.pos[i * 3 + 1] + ',' + A.pos[i * 3 + 2], (A.liveFlag[i] & 1) === 0);
    }
    return out;
}

/**
 * A trace's MSF_SHADOW_MARIO_EVENT as the stage's setup makes it (FlagManager.setupStage: setupObjects'
 * 1, Delfino Plaza's scenario 8 pick from shine 33, MSF_YOSHI_UNLOCKED, the nozzles and the Shine
 * count) from the stage-start record's flags. undefined without them.
 */
export function traceShadowMarioEvent(g: any, segment: number, area: number, episode: number): number | undefined {
    const c = traceStageCarry(g, segment);
    if (!c) return undefined;
    const f = c.flags.clone(), ex = shineIDofExStage(area);
    f.setupStage(area, episode, ex !== 0xFF && f.getShineFlag(ex), ex, false);
    return f.getFlag(MSF.SHADOW_MARIO_EVENT);
}

/** the Shine IDs (0..119) a recorded flag image has got */
/** the stage's blue coins the recorded save has (TFlagManager::getBlueCoinFlag(area, 0..49)) */
export function traceBlueCoinIds(f: FlagManager, area: number): number[] { const out: number[] = []; for (let i = 0; i < 50; i++) if (f.getBlueCoinFlag(area, i)) out.push(i); return out; }
export function traceShineIds(f: FlagManager): number[] { const out: number[] = []; for (let i = 0; i < 120; i++) if (f.getShineFlag(i)) out.push(i); return out; }

export function traceStageCarry(g: any, segment: number): { flags: FlagManager; prevArea: number } | null {
    const ss = segment === 0 && g && g.trace && g.trace.stageStart;
    if (!ss || !ss.flagImage) return null;
    const flags = flagsFromTraceImage(ss.flagImage);
    return flags ? { flags, prevArea: ss.previous.area } : null;
}

/**
 * The stage tick after which TMarDirector's camera demo (STATE_UNK1) ended, from a trace's frame records
 * (the frame's director state; mstrghost.ts trace.director): the first change from it in the segment.
 * null without a trace, or when the segment has no demo.
 */
export function traceDemoEnd(g: any, segment: number, q0: number): number | null {
    const D = g && g.trace && g.trace.director, seg = g && g.segments && g.segments[segment];
    if (!D || !D.count || !seg) return null;
    const lo = segment === 0 ? -Infinity : seg.startQf - 240, hi = seg.endQf;
    for (let i = 1; i < D.count; i++) if (D.state[i - 1] === 1 && D.state[i] !== 1 && D.qf[i] >= lo && D.qf[i] <= hi) return D.qf[i] - q0;
    return null;
}

/**
 * A trace's last moving tick in a segment before the ticks written as the recording closed: when the
 * segment ends with a gap (the game frozen, or the recorder waiting) followed by no more than a few
 * ticks, the tick before that gap (as a stage tick); else the segment's last.
 */
/**
 * A trace's rotating cranes (TCraneRotY, Ricco Harbor) at the speeds the recorded game ran them at.
 * TCraneRotY::load rolls each one's speed (MsRandF() * 0.1 + 0.05 a move), but Moonshine can set
 * the cranes' speed itself, and its recordings then don't fit the roll (Ricco ep 2: every crane at a
 * multiple of 0.0015 a move, below the roll's 0.05 minimum). The trace records each crane's
 * mRotation once a frame, so each crane takes the f32 speed whose moves from its start yaw give
 * every recorded angle of its first swing exactly; a crane with no record, or none that fits, keeps
 * the game's roll. Returns the speeds it set (by name), for the log.
 */
export function traceCraneSpeeds(g: any, q0: number, objects: Iterable<any>): Record<string, number> {
    const out: Record<string, number> = {};
    const A = g && g.trace && g.trace.actors as TraceActors | undefined;
    if (!A || !A.count) return out;
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    for (const o of objects) {
        if (!(o instanceof CraneRotY)) continue;
        const c = o as any, start: number = c.unk138, end = fr(c.unk138 + c.unk140);
        // its records: the actor at its place (cranes don't move), while it still turns to its max
        const recs: [number, number][] = [];
        let id = -1;
        for (let i = 0; i < A.count; i++) {
            if (id < 0) { if (Math.abs(A.pos[i * 3] - c.pos.x) > 1 || Math.abs(A.pos[i * 3 + 2] - c.pos.z) > 1 || Math.abs(A.pos[i * 3 + 1] - c.pos.y) > 1) continue; id = A.id[i]; }
            if (A.id[i] !== id) continue;
            const r = A.rot[i * 3 + 1];
            if (r <= start || r > end || (recs.length && r <= recs[recs.length - 1][1])) break;
            recs.push([A.qf[i] - q0 + 1, r]);
        }
        if (recs.length < 3) continue;
        // the moves made by each record (its stage QF, give or take the label's tick) and the speed
        const [n0, r0] = recs[0], [n1, r1] = recs[recs.length - 1];
        const est = (r1 - r0) / (n1 - n0);
        let found: number | null = null;
        for (const lead of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
            f32[0] = est; const base = u32[0];
            for (let d = 0; d <= 1024 && found === null; d++) for (const sgn of d ? [1, -1] : [1]) {
                u32[0] = base + sgn * d; const s = f32[0];
                let ok = true, rot = start, n = 0;
                for (const [m, r] of recs) { const want = m + lead; if (want < n) { ok = false; break; } for (; n < want; n++) rot = fr(rot + s); if (rot !== r) { ok = false; break; } }
                if (ok) { found = s; break; }
            }
            if (found !== null) break;
        }
        if (found === null) continue;
        c.unk144 = found; out[c.name] = found;
    }
    return out;
}

export function traceLastMove(g: any, segment: number, q0: number): number | undefined {
    const seg = g && g.segments && g.segments[segment];
    if (!g || !g.trace || !seg) return undefined;
    const q: number[] = [];
    for (const t of g.trace.ticks as { qf: number }[]) if (t.qf >= seg.startQf && t.qf <= seg.endQf) q.push(t.qf);
    if (!q.length) return undefined;
    for (let i = q.length - 2; i >= 0 && q.length - 1 - i <= 8; i--) if (q[i + 1] - q[i] > 4) return q[i] - q0;
    return q[q.length - 1] - q0;
}

/** a trace's first Mario record in the segment past the stage's load pose (0x133F): setMario's, as a stage tick; null without one */
export function traceFirstSet(g: any, segment: number, q0: number): number | null {
    const seg = g && g.segments && g.segments[segment];
    if (!g || !g.trace || !seg) return null;
    for (const t of g.trace.ticks as { qf: number; mario: MarioView | null }[]) {
        if (t.qf < seg.startQf || t.qf > seg.endQf) continue;
        if (t.mario && t.mario.status >>> 0 !== 0x133F) return t.qf - q0;
    }
    return null;
}

/**
 * When a trace's pause menu closed (TPauseMenu2::getNextState: the changeState that leaves
 * STATE_PAUSE_MENU), as stage ticks: tick t to the state the director went to. A frame record has the
 * director's state before that frame's direct; the frames that began paused moved Mario on none of
 * their ticks but the last few, the ones after the changeState that closed the menu (the frame's ticks
 * W + 1 .. W + 4 for a record labelled W: its Mario records W .. W + 3, the first of them filled).
 * null without a trace or a pause in the segment.
 */
export function tracePauseExits(g: any, segment: number, q0: number): Map<number, number> | null {
    const D = g && g.trace && g.trace.director, seg = g && g.segments && g.segments[segment];
    if (!D || !D.count || !seg) return null;
    const ticks = traceTickSet(g), lo = segment === 0 ? -Infinity : seg.startQf - 240, hi = seg.endQf;
    let out: Map<number, number> | null = null;
    for (let i = 0; i + 1 < D.count; i++) {
        if (D.state[i] !== 5 || D.qf[i] < lo || D.qf[i] > hi) continue;
        // the first frame that began paused (labelled W = the entry's QF + 1), then the frame Mario moved in again
        const end = D.qf[i + 1];
        for (let W = D.qf[i] + 1; W <= end + 4; W += 4) {
            let k = 0;
            for (let j = 0; j < 4; j++) if (ticks.has(W + j)) k++;
            if (!k) continue;
            (out ??= new Map()).set(W + 4 - k - q0, D.state[i + 1]);
            break;
        }
    }
    return out;
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

/**
 * The stage QF of a segment's final ghost sample when it is only a copy of the one before it
 * (position, animation and phase equal): the recorder writes it as the run closes (the timer
 * stopped), so the game was not sampled there. undefined otherwise.
 */
const TICK_SETS = new WeakMap<object, Set<number>>();
/** a trace's recorded world QFs (its ticks') */
export function traceTickSet(g: any): Set<number> {
    let s = TICK_SETS.get(g);
    if (!s) { s = new Set(g.trace.ticks.map((t: { qf: number }) => t.qf)); TICK_SETS.set(g, s); }
    return s;
}

export function closingCopyQf(g: any, segment: number, q0: number): number | undefined {
    const seg = g && g.segments && g.segments[segment];
    if (!seg || seg.sampleCount < 2) return undefined;
    const k = seg.firstSample + seg.sampleCount - 1;
    // a trace has a record every tick: none past its last (the ghost's sample there is the last one held)
    if (g.trace) return g.qf[k] - q0 + 1;
    for (let c = 0; c < 3; c++) if (g.pos[k * 3 + c] !== g.pos[(k - 1) * 3 + c]) return undefined;
    if (g.anim[k] !== g.anim[k - 1] || g.phase[k] !== g.phase[k - 1]) return undefined;
    return g.qf[k] - q0;
}

/**
 * Ticks the sim runs a later segment's stage before the segment's first QF (2 frames). How long the
 * game had really run is not recorded (a skipped opening camera, say); on NB6 (2026_10_21) every lead
 * from 8 to 4400 ticks gives the same replay, so the shortest whole-frame one that fits is used.
 */
export const LATER_SEGMENT_LEAD = 8;

/**
 * A later segment anchored at its stage's tick 0, as live play's recordings write them (ghostwrite.ts:
 * the first frame's pose copied back to the stage's start, a frame or more before it, as Moonshine
 * does for the first segment only): its stage then starts at the segment's first QF, and the run's
 * flags are carried into it (stagechange.ts liveRunCarry). Moonshine's later segments start at their
 * first frame.
 */
export function stageStartCopy(g: any, segI: number): boolean {
    const seg = g && g.segments && g.segments[segI];
    if (!segI || !seg || seg.sampleCount < 2) return false;
    const a = seg.firstSample, b = a + 1;
    if (g.qf[b] - g.qf[a] < 8 || g.anim[a] !== g.anim[b] || g.phase[a] !== g.phase[b] || g.yaw[a] !== g.yaw[b]) return false;
    for (let c = 0; c < 3; c++) if (g.pos[a * 3 + c] !== g.pos[b * 3 + c]) return false;
    return true;
}

/** The ghosts whose Mario the game code plays from the controller: the replays (MSTR, src/ghost/mstrghost.ts). A replay's controller observation is taken on its own movement tick, so it is read at that tick; an SGHF ghost's input leads by a tick (4 QF). */
export const isInputTrace = (g: any) => !!g && !!g.header && g.header.format === 'mstr';

export class SimRunner {
    /** steer Mario by a v8 ghost's recorded camera instead of the sim's camera (debug; see where it's read) */
    static steerByRecordedCamera = false;
    /**
     * The hybrid steering camera: with a v8 ghost's recorded camera, the sim's camera still runs every
     * tick, and at each recorded key (the end of every 4th frame) a sim camera that renders outside the
     * recorded 16-unit yaw bucket is turned back into it (PolarSubCamera.correctYawToRecorded). Off:
     * the sim's camera alone. No effect on ghosts without a recorded camera, nor with steerByRecordedCamera.
     */
    static correctByRecordedCamera = true;
    /** this stage's recorded camera keys (correctByRecordedCamera), null: none */
    private camKeys: Map<number, { fwd: number; pos: { x: number; y: number; z: number } }> | null = null;
    /** the corrections made this stage: ghost QF and turn (s16) */
    camCorrections: { qf: number; turn: number }[] = [];
    private rng: RngReplay | null = null;
    /** run Mario from the ghost's inputs where it has them (the viewer's "Input replay") */
    inputReplay = true;
    /**
     * The replay mode for a trace (.msgt), with the input replay on. true ("Play recording"): the game
     * code runs Mario from the inputs as in "Simulate", and after his movement each tick he is put in
     * the state the trace recorded for that tick (pinToRecording), so the world reacts to the Mario the
     * game had even where the simulation alone would drift. false ("Simulate"): the game code alone.
     */
    playRecording = true;
    /** the current stage's recorded values the sim reads (game/feedback.ts TraceFeeds; null: no trace) */
    feeds: TraceFeeds | null = null;
    /** where the last stage built left initSinkNpc_'s counter */
    private sinkCarry: { seg: number; n: number } | null = null;
    /** Play recording: the first ghost QF where the game code's Mario differed from the trace before he was put back (-1: none yet) */
    firstPinQf = -1;
    /** Play recording: the ticks where he was put back */
    pinCount = 0;
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
    private track(inp: SimInput, segI: number): MarioTrack {
        const g = inp.ghost, A = inp.api, q0 = this.q0;
        return {
            // (this segment's: a later stage starts before its first sample, where the sample at q0 is the stage before's)
            closingCopyQf: closingCopyQf(g, segI, q0),
            everyMove: !!g.trace,
            noPhase: !!g.trace,
            lastMove: g.trace ? traceLastMove(g, segI, q0) : undefined,
            at: (q: number): MarioSample | null => {
                const t = q0 + q;
                // a trace records every tick Mario moves: none while the world stops (a Shine's demo), nothing to hold there
                if (g.trace && !traceTickSet(g).has(t)) return null;
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
        // the build this ghost was played on (its game ID and disc revision), before any of its code runs
        useGhostVersion(g);
        // the segment the time is in: its stage starts at its first QF
        const s = inp.api.ghostSampleAt(g, inp.t);
        const segI = s ? g.segIndex[s.i] : 0;
        const seg = g.segments[segI];
        if (!seg) return false;
        // Moonshine anchors only the first segment at QF 0 (its first pose is held from there); a later
        // segment starts at the first QF its timer can be read, when the new stage has already run a while
        // (ghost.cpp startEpochSamples). The sim starts that stage LATER_SEGMENT_LEAD ticks early so the
        // intro's end (introDemoEnd: six ticks before the first sample) lands inside the run. A live
        // recording's later segment is anchored at its stage's tick 0 like the first (stageStartCopy).
        const live = stageStartCopy(g, segI);
        const q0 = seg.startQf - g.header.startQf - (segI > 0 && !live ? LATER_SEGMENT_LEAD : 0);
        const I = g.inputs;
        // Only an MSTR trace (.msgt) is replayed from its inputs; an SGHF ghost (.smsghost) moves Mario by
        // its recorded positions and animation.
        const replay = this.inputReplay && isInputTrace(g) && !!I && I.count > 0 && (() => { for (let i = 0; i < I.count; i++) { const q = I.qf[i]; if (q >= q0 && q <= seg.endQf - g.header.startQf) return true; } return false; })();
        const pin = replay && this.playRecording && !!(g.trace && g.trace.ticks);
        const key = `${sceneName}|${segI}|${q0}|${replay}|${pin}`;
        const want = inp.t - q0;
        // (before the stage's first tick (a replay from the stage load: the frames before Mario's), the
        // stage is made once and held at its start: not made again every frame, which ran the page out
        // of memory in under a minute at the start of a ghost, and on a phone in a few dozen frames)
        if (this.key !== key || !this.stage || this.stage.qf > Math.max(want, 0) + 4) {
            this.key = key; this.q0 = q0; this.error = null;
            let intro = null, demoName: ((f: FlagManager) => string) | null = null;
            if (replay) {
                const ss: { qf: number; anim: number; phase: number }[] = [];
                for (let i = seg.firstSample; i < seg.firstSample + seg.sampleCount; i++) { const q = g.qf[i] - q0; if (q > 0) ss.push({ qf: q, anim: g.anim[i], phase: g.phase[i] }); }
                intro = introTiming(ss, I, q0, seg.endQf - g.header.startQf);
                // a trace records TMarDirector's state every frame: the camera demo's end is there, not guessed from Mario's samples
                const td = traceDemoEnd(g, segI, q0);
                if (td !== null) intro.demoEndTick = introDemoEndInFrame(ss, td, traceFirstSet(g, segI, q0));
                // and when the pause menu closed (the menu isn't simulated: its getNextState from the trace)
                const pe = tracePauseExits(g, segI, q0);
                if (pe) intro.pauseExits = pe;
                // Moonshine's Fast text, as the trace's session record has it (none recorded: on, as the sim's default)
                if (typeof g.header.fastText === 'boolean') intro.fastText = g.header.fastText;
                // Moonshine's Respawn One-Time Shines as the stage loaded (features.cpp patches the bells' and the Shine gate's initMapObj)
                if (g.trace && traceSessionAtStart(g.trace.session, q0, SessionField.RESPAWN_SHINES) === 1) intro.respawnShines = true;
                // Delfino Plaza's own opening demo (DEMO_FLAG_CAMERA_DEMO_ON_START): Mario comes in late, the
                // first sample 7 ticks after setMario (stagechange.ts LiveDirector), as a live run records it
                if (seg.route.area === 1 && td !== null) intro.plazaDemo = true;   // (a trace: its director went through the demo, which ended at td)
                else if (seg.route.area === 1 && (segI === 0 || live) && (intro.firstSample ?? 0) > 12) { intro.plazaDemo = true; intro.demoEndTick = (intro.firstSample ?? 0) - 7; }
                if (live) {
                    // a live recording's later stage: the save's flags and the area the run carried in
                    // (stagechange.ts liveRunCarry), the entrance from them as LiveRunner.build has it
                    const area = seg.route.area, c = liveRunCarry(g, segI), got = gotShineFromSamples(ss);
                    (intro as LiveTiming).flags = c.flags;
                    intro.marioPosIdx = decideMarioPosIdx(c.flags.clone(), area, c.prevArea).posIdx;
                    intro.start = (m) => entranceStart(m.world, decideMarioPosIdx(m.world.flags, area, c.prevArea), c.prevArea, got)(m);
                    const plazaDemo = !!intro.plazaDemo;
                    demoName = (f: FlagManager) => stageDemoName(f, area, seg.route.episode, plazaDemo);
                } else if (traceStageCarry(g, segI)) {
                    // a trace's first stage: the save's flags as its setup began, and the scene it came from (its stage-start record)
                    // Delfino Plaza: the entrance decideMarioPosIdx gives for the scene the run came from (with the
                    // recorded flags), when it puts Mario where the trace's first update has him and the plain
                    // start doesn't. (The flags are not given to the stage itself: with them, Simulate went wrong
                    // sooner in as many ghosts as it held longer, so something else still reads them differently.)
                    const c = traceStageCarry(g, segI)!, area = seg.route.area, got = gotShineFromSamples(ss);
                    // a secret course's Shine already got (its red coin switch is out, he keeps FLUDD): the recorded flags say so
                    const exId = shineIDofExStage(area);
                    if (exId !== 0xFF) intro.exShineGot = c.flags.getShineFlag(exId);
                    intro.traceShines = traceShineIds(c.flags);
                    intro.traceBlueCoins = traceBlueCoinIds(c.flags, area);
                    const first = g.trace.ticks.find((t: any) => t.mario && t.mario.status >>> 0 !== 0x133F) as { mario: MarioView } | undefined;   // (past the stage's load pose: setMario's first)
                    if (area === 1 && first) {
                        intro.marioPosIdx = decideMarioPosIdx(traceStageCarry(g, segI)!.flags, area, c.prevArea).posIdx;
                        intro.start = (m) => plazaTraceStart(m, c, got, first.mario.pos);
                    }
                } else if (segI > 0 && g.segments[segI - 1] && seg.route.area === 1) {
                    // a later segment: the entrance the stage before leads to (decideMarioPosIdx: Delfino's door
                    // or pipe of the course left), the Shine got there as its APPEAR animation shows
                    const area = seg.route.area, prev = g.segments[segI - 1].route.area, got = gotShineFromSamples(ss);
                    intro.marioPosIdx = decideMarioPosIdx(new FlagManager(), area, prev).posIdx;
                    intro.start = (m) => entranceStart(m.world, decideMarioPosIdx(m.world.flags, area, prev), prev, got)(m);
                }
            }
            // MSL rand()'s state at the stage's start (srand(OSGetTick()) at boot, then everything before
            // it): the ghost's RNG tape SEED for this segment when it has one, else 0
            // (a replay that holds the stage's load: its first recorded seed is the load's)
            const fromLoad = segI === 0 && !!(g.header && g.header.fromLoad && g.header.initialRng !== undefined);
            if (intro && fromLoad) intro.fromLoad = true;
            const seed = fromLoad ? g.header.initialRng : stageSeed(g, segI);
            // TBaseNPC::initSinkNpc_'s counter as this stage's setup began: the trace's record for its first
            // stage (stage schema 2+), where the stage before left it for a later one built here, else 0
            const prevSink = segI > 0 && this.sinkCarry && this.sinkCarry.seg === segI - 1 ? this.sinkCarry.n : null;
            if (intro && segI === 0 && g.trace) { const ta = traceActorsAlive(g); if (ta) intro.traceAlive = ta; }
            if (intro && segI === 0 && g.trace) { const th = traceActorsHitFilter(g); if (th) intro.traceHitFilter = th; }
            if (intro && segI === 0 && g.trace) { const ev = traceShadowMarioEvent(g, segI, seg.route.area, seg.route.episode); if (ev !== undefined) intro.shadowMarioEvent = ev; }
            npcSinkSetup.start = segI === 0 ? (g.trace && g.trace.stageStart && g.trace.stageStart.npcSinkPhase !== null ? g.trace.stageStart.npcSinkPhase : 0) : (prevSink ?? 0);
            // (the heap's leftovers the stage's setup reads: feedback.ts traceGarbageCtx)
            traceGarbageCtx.mario = g && g.trace ? traceGarbageOf(g) : null;
            try { this.stage = Stage.fresh(this.disc.stageFiles(scene), sceneName, seg.route.area, seg.route.episode, seed ?? 0, 0, intro); }
            catch (e) { this.error = e; this.stage = null; console.warn('[game] stage', e); return false; }
            finally { npcSinkSetup.start = 0; traceGarbageCtx.mario = null; }
            { const n = npcSinkCounterOf(this.stage.world); this.sinkCarry = { seg: segI, n: n ?? npcSinkSetup.start }; }
            // V9: rand()'s state at the first recorded pose (the stage's QF 0, after its lead frames)
            if (segI === 0 && !fromLoad && g.header && g.header.initialRng !== undefined) srand(g.header.initialRng);
            const st0 = this.stage;
            const C0: any = st0.player && st0.player.simCamera;
            if (C0 && demoName) C0.stageDemoName = demoName(st0.world.flags);
            this.pads = null; this.sync = null; this.history = null; this.camKeys = null; this.camCorrections = [];
            this.firstPinQf = -1; this.pinCount = 0;
            if (pin && st0.player) { st0.pinMario = this.pinToRecording(g, q0, st0.player); if (g.trace.actors && g.trace.actors.count) st0.pinWorld = this.pinActorsToRecording(g, q0, st0); }
            if (st0.player) {
                const P = st0.player;
                this.pads = new Map();
                for (let i = 0; i < I.count; i++) this.pads.set(I.qf[i] - q0, i);
                // a trace's frames with no movement tick (the pause menu's): the pad the frame began with
                this.framePads = null;
                const FP = I.framePads;
                if (FP && FP.count) { this.framePads = new Map(); for (let i = 0; i < FP.count; i++) { const q = FP.qf[i] - q0; if (!this.pads.has(q)) this.framePads.set(q, i); } }
                let cam = P.cameraApprox ? 'approx' : 'sim';
                // Steering by a v8 ghost's recorded camera is off by default: it is sampled once a frame and
                // Mario reads the camera every tick, so the ticks in between are guessed. With the sim's own
                // camera, NB6 (2026_10_21) syncs to QF 1056 instead of 688 and PV6 to 1456 instead of 836.
                // What the recording does pin down (its keys' 16-unit yaw bucket and eye) corrects the
                // sim's camera instead: correctByRecordedCamera, the hybrid.
                if (g.camera && inp.api.ghostCameraAt && SimRunner.steerByRecordedCamera) {
                    const at = inp.api.ghostCameraAt;
                    P.setStickCamera(recordedStickCamera((q) => at(g, q0 + q, segI), () => st0.qf, () => s16(P.mFaceAngle.y + 0x8000)), false);
                    cam = 'recorded';
                } else if (g.camera && !isInputTrace(g) && SimRunner.correctByRecordedCamera && P.simCamera && (P.simCamera as any).correctYawToRecorded) {
                    // (not a trace: its camera is the game code's own, and its keys are the camera's orientation, not SGCA's view rotation)
                    this.camKeys = recordedCameraKeys(g, segI);
                    if (this.camKeys.size) cam = 'hybrid'; else this.camKeys = null;
                }
                this.history = new ReplayHistory(g, q0 + Math.max(0, P.driftFrom));
                this.sync = { replay: true, firstDriftQf: -1, driftErr: 0, maxErr: 0, frames: 0, exactFrames: 0, camera: cam, lostLives: P.lostLives, lateInputsQf: -1, controlQf: -1 };
            } else this.sync = { replay: false, firstDriftQf: -1, driftErr: 0, maxErr: 0, frames: 0, exactFrames: 0, camera: '', lostLives: [], lateInputsQf: -1, controlQf: -1 };
            this.rng = g.rng ? new RngReplay(g.rng, segI, q0, () => q0 + st0.qf) : null;
            this.feeds = g.trace ? new TraceFeeds(g, q0, () => st0.qf) : null;
        }
        const st = this.stage!;
        const track = this.track(inp, segI);
        const t0 = performance.now();
        st.simClipFallback = !!(g && g.trace);
        while (st.qf + 4 <= want) {
            st.camera = this.camera(inp, q0 + st.qf + 4, segI);
            rngCtx.roll = this.rng ? this.rng.roll : null; rngCtx.node = this.rng ? this.rng.node : null;
            if (this.feeds) this.feeds.install();
            try { st.runFrame(track, st.player ? this.padAt(inp.ghost, st.qf + (isInputTrace(inp.ghost) ? 0 : 4)) : null); } catch (e) { this.error = e; console.warn('[game] frame', e); this.stage = null; return false; }
            finally { rngCtx.roll = null; rngCtx.node = null; TraceFeeds.clear(); }
            if (st.player && this.camKeys) {
                const k = this.camKeys.get(q0 + st.qf);
                const turn = k ? (st.player.simCamera as any).correctYawToRecorded(k.fwd, k.pos) : 0;
                if (turn) this.camCorrections.push({ qf: q0 + st.qf, turn });
            }
            if (st.player && this.history) this.history.push(q0 + st.qf, st.player);
            if (st.player && this.sync) {
                const d = st.player.drift, S = this.sync;
                S.firstDriftQf = d.firstQf >= 0 ? q0 + d.firstQf : -1; S.driftErr = d.firstErr; S.maxErr = d.maxErr; S.frames = d.frames; S.exactFrames = d.synced; S.corrections = d.corrections;
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
    /**
     * Play recording: after Mario's movement at stage QF q, his state as the trace recorded it at that
     * tick (ghost QF q0 + q): position, velocities, angles, status, input, flags, health and animation.
     * Where the game code had him elsewhere, firstPinQf / pinCount note it.
     */
    private pinToRecording(g: any, q0: number, P: PlayerMario): (q: number) => void {
        const at = new Map<number, MarioView>();
        for (const t of g.trace.ticks as { qf: number; mario: MarioView | null }[]) if (t.mario) at.set(t.qf, t.mario);
        const f = Math.fround, M: any = P;
        return (q: number) => {
            const m = at.get(q0 + q);
            if (!m) return;
            const off = M.mStatus >>> 0 !== m.status >>> 0 || f(P.pos.x) !== f(m.pos[0]) || f(P.pos.y) !== f(m.pos[1]) || f(P.pos.z) !== f(m.pos[2])
                || (M.mFaceAngle.y << 16 >> 16) !== m.faceAngle[1] || f(M.mForwardVel) !== f(m.forwardVel);
            // (not counted while he's still in the stage's load pose (0x133F): the record is taken after the
            // tick's changeState, whose setMario the pin, right after his movement, comes before)
            if (off && M.mStatus >>> 0 !== 0x133F) { this.pinCount++; if (this.firstPinQf < 0) this.firstPinQf = q0 + q; }
            P.pos.x = f(m.pos[0]); P.pos.y = f(m.pos[1]); P.pos.z = f(m.pos[2]);
            M.mVel.x = f(m.vel[0]); M.mVel.y = f(m.vel[1]); M.mVel.z = f(m.vel[2]);
            M.mForwardVel = f(m.forwardVel); M.mSlideVelX = f(m.slideVel[0]); M.mSlideVelZ = f(m.slideVel[1]);
            M.mFaceAngle.x = m.faceAngle[0]; M.mFaceAngle.y = m.faceAngle[1]; M.mFaceAngle.z = m.faceAngle[2]; M.mModelFaceAngle = m.modelFaceAngle;
            M.mStatus = m.status >>> 0; M.mPrevStatus = m.prevStatus >>> 0; M.mStatusState = m.statusState; M.mStatusTimer = m.statusTimer;
            M.mInput = m.input >>> 0; M.mIntendedMag = f(m.intendedMag); M.mIntendedYaw = m.intendedYaw;
            M.mFlag = m.flag >>> 0; M.mHealth = m.health;
            if ((M.mAnimationId & 0xFFFF) !== m.animationId && typeof M.setAnimation === 'function') { try { M.setAnimation(m.animationId, 1); } catch { /* an id the model hasn't */ } }
        };
    }
    /**
     * Play recording: the stage's actors placed as the trace's actor records have them (position,
     * rotation, scaling and, for a live actor, velocity). A record is the object's state at the end of
     * the tick it was taken on: the one labelled ghost QF r is applied after the movement of stage tick r - q0 + 1 (where the game code's positions line up with it while it runs in step).
     * Each recorded object is paired with the simulated object of the same name (its JDrama key code)
     * and the same place among those (see below); one the sim doesn't make stays unpaired. An enemy
     * the game had dead is kept dead (see below). Animation frames, states and anything past
     * the copied bytes still come from the game code.
     */
    private pinActorsToRecording(g: any, q0: number, st: Stage): (q: number) => void {
        const A = g.trace.actors as TraceActors;
        const pair = new Map<number, LiveActor>(), held = new Map<LiveActor, number>(), lastPos = new Map<number, number[]>();
        // each enemy's DEAD bit through the recording: the labels where it was recorded, and the bit there
        const life = new Map<number, { qf: number[]; dead: number[] }>(), lifeAt = new Map<number, number>();
        for (let i = 0; i < A.count; i++) if (A.extent[i] >= 0x150) { const id = A.id[i]; const T = life.get(id) || life.set(id, { qf: [], dead: [] }).get(id)!; T.qf.push(A.qf[i]); T.dead.push(A.liveFlag[i] & LF.DEAD); }
        // the recorder's objects of each name in the order it first saw them, and the sim's in its
        // managers' order: the n-th of a name is paired with the sim's n-th (a manager's pool of the
        // same enemy is one array in both, so its members pair as the game numbers them)
        const ordinal = new Map<number, number>(), nextOf = new Map<number, number>();
        let k = 0;
        const byKey = (): Map<number, LiveActor[]> => {
            const out = new Map<number, LiveActor[]>(), P = st.player as any;
            const add = (o: any) => { if (!(o instanceof LiveActor) || o === P) return; const key = o.keyCode || (o.keyCode = calcKeyCode(o.name)); (out.get(key) || out.set(key, []).get(key)!).push(o); };
            for (const m of st.world.conductor.liveManagers) for (const o of m.objs) add(o);
            for (const o of st.world.conductor.aloneActors) add(o);
            return out;
        };
        let sim: Map<number, LiveActor[]> | null = null;
        return (q: number) => {
            const label = q0 + q - 1;
            if (k < A.count && A.qf[k] <= label) sim = null;
            for (; k < A.count && A.qf[k] <= label; k++) {
                const id = A.id[k], key = A.key[k];
                let o = pair.get(id);
                if (!o) {
                    let n = ordinal.get(id);
                    if (n === undefined) { n = nextOf.get(key) || 0; nextOf.set(key, n + 1); ordinal.set(id, n); }
                    const list = (sim || (sim = byKey())).get(key);
                    // (none yet: one the sim hasn't made, or never makes; tried again at its next record)
                    if (!list || n >= list.length) continue;
                    o = list[n]; pair.set(id, o);
                }
                // (the move since its last record, for an actor whose heading isn't in the copy)
                const last = lastPos.get(id), x = A.pos[k * 3], z = A.pos[k * 3 + 2];
                const moved = last ? { dx: x - last[0], dz: z - last[1] } : { dx: 0, dz: 0 };
                lastPos.set(id, [x, z]);
                // an actor whose state past the copied bytes the record still shows takes it from the
                // record (BossManta: brought in when the sim has it dead, its generation from its width,
                // its heading from its move)
                const pr = (o as any).pinRecorded;
                if (typeof pr === 'function') pr.call(o, { alive: !(A.liveFlag[k] & LF.DEAD), width: A.scale[k * 3], ...moved });
                o.pos.set(A.pos[k * 3], A.pos[k * 3 + 1], A.pos[k * 3 + 2]);
                o.rot.set(A.rot[k * 3], A.rot[k * 3 + 1], A.rot[k * 3 + 2]);
                o.scale.set(A.scale[k * 3], A.scale[k * 3 + 1], A.scale[k * 3 + 2]);
                if (A.extent[k] >= 0xF4) o.vel.set(A.vel[k * 3], A.vel[k * 3 + 1], A.vel[k * 3 + 2]);
                if (A.extent[k] >= 0x150) held.set(o, id);
            }
            // An enemy (an enemy manager's object: 0x150 copied) the game had dead stays dead: a record
            // comes only when an object changed, and the game code may revive a pool member the game
            // left dead (a manta the game's water killed would swim on). Not while the recording has it
            // alive again within the next two frames: the sim's own spawn comes before that record does.
            for (const [o, id] of held) {
                const T = life.get(id)!; let i = lifeAt.get(id) || 0;
                while (i + 1 < T.qf.length && T.qf[i + 1] <= label) i++;
                lifeAt.set(id, i);
                if (!T.dead[i] || T.qf[i] > label) continue;
                let soon = false;
                for (let j = i + 1; j < T.qf.length && T.qf[j] <= label + 8; j++) if (!T.dead[j]) { soon = true; break; }
                if (!soon) o.liveFlag |= LF.DEAD;
            }
        };
    }
    /** the frame's PADStatus (its record's QF is the frame's last tick); none recorded: a neutral pad */
    private framePads: Map<number, number> | null = null;
    private padAt(g: any, q: number): PadStatus {
        const i = this.pads ? this.pads.get(q) : undefined;
        if (i !== undefined) return ghostPad(g.inputs, i);
        const j = this.framePads ? this.framePads.get(q) : undefined;
        return j === undefined ? { ...NO_PAD } : ghostPad(g.inputs.framePads, j);
    }
    /**
     * The sim camera's view (eye, look-at, up, vertical FOV), as the game renders it: the demo
     * cameras' too (the stage intro, the director's demo queue: camera/bck.ts). Replays: the input
     * replay's camera at the last frame run.
     */
    view(): { pos: number[]; at: number[]; up: number[]; fov: number } | null {
        const C: any = this.player && this.player.simCamera;
        if (!C || !C.pos || !C.at) return null;
        const u = C.up || { x: 0, y: 1, z: 0 };
        return { pos: [C.pos.x, C.pos.y, C.pos.z], at: [C.at.x, C.at.y, C.at.z], up: [u.x, u.y, u.z], fov: C.fovy || 50 };
    }
    /** the simulated player, when this stage runs from the inputs */
    get player(): PlayerMario | null { return this.stage ? this.stage.player : null; }
    private camera(inp: SimInput, t: number, seg: number): GameCamera | null {
        const f = inp.api.ghostCameraAt;
        if (!f) return null;
        const c = f(inp.ghost, t, seg);
        if (!c) return null;
        return { pos: c.pos, at: c.at, quat: c.quat, fovy: c.fov, aspect: (640 * 0.9134614) / 448, near: 10 };
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

/**
 * Live play (the viewer's hidden gamepad mode): the shown stage run with the player Mario from a
 * pad read each frame, no ghost. inp.live: the route, the frames wanted since the start (the
 * viewer's real-time clock) and the pad reader (a post-PADClamp PADStatus); reset restarts it.
 *
 * The run goes on across stage changes the way the game does (stagechange.ts): the director's
 * intro (skippable), and when Mario leaves (a warp, a pipe, a painting, the Shine, a miss) the fade
 * out, then `pending` names the next area (and its scene): the viewer shows that stage, and once its
 * scene is the one handed in, the next stage starts with the save's flags carried over and Mario at
 * the entrance (decideMarioPosIdx). Recording keeps going: a segment a stage.
 */
export interface LiveInput {
    area: number; episode: number; frames: number; pad: () => PadStatus; reset: number; record?: boolean; sleepPhase?: number | null;
    /** the free-roam Shine get (LiveRunner.freeRoamShine) when given, else the runner's own setting */
    freeRoamShine?: boolean;
}
/**
 * The run QFs between a live stage's last tick and the next stage's tick 0 (the load; the game's
 * time isn't counted there). A frame, so the next segment's first sample (its pose copied back to
 * the stage's tick 0: ghostwrite.ts) comes after the stage before's last.
 */
const STAGE_LOAD_QF = 4;   // (the least: a recording's later segments need a gap; loadGapQf is the real one)
/**
 * The 2D screens live play shows (the page hands in the HUD's makers: hud/index.ts GameHud.screens):
 * each a menu run a game frame at a time with the pad (frame(pad)) and drawn by the HUD. A maker
 * gives null when the disc's files for it are missing (the run then goes on as without it), or
 * undefined while they load.
 */
export interface LiveScreens {
    pauseMenu(o: { area: number; episode: number }): any;
    gameOverMenu(): any;
    selectMenu(o: ReturnType<typeof selectMenuInput>): any;
    movie(id: number, flags: FlagManager): any;
}
export class LiveRunner extends SimRunner {
    /** the HUD's screen makers (null: none, the notices stand in) */
    screens: LiveScreens | null = null;
    /** the screen showing: the pause menu, the game over's choice, the episode select, a movie */
    screen: { kind: 'pause' | 'gameover' | 'select' | 'movie'; menu: any } | null = null;
    /** a stage change waiting on a screen (leave's later steps) */
    private leaving: { cur: Area; next: Area; note: string; movie?: number; n?: Area & { select: boolean }; step: number; flags?: FlagManager; prevArea?: number } | null = null;
    /** the file the run plays (0..2: A / B / C, its saves go there), -1 none (the run's flags aren't a file's) */
    saveSlot = -1;
    /** the run waits on the file select (once, when live play starts, not when recording) */
    private fileAsked = false;
    /** show the Shine select when entering a course (off: it doesn't draw or take the pad in the browser yet; the default episode is used) */
    shineSelect = false;
    private liveKey = '';
    /** the screens' clock: game frames (1/29.97 s) of real time (update runs more than once a page frame) */
    private menuT = -1;
    private menuFrames() {
        const now = performance.now();
        if (this.menuT < 0 || now - this.menuT > 500) { this.menuT = now; return 1; }
        let n = 0;
        while (now - this.menuT >= 1000 / 29.97 && n < 4) { this.menuT += 1000 / 29.97; n++; }
        if (n === 4) this.menuT = now;
        return n;
    }
    private resetSeen = NaN;
    /** the stages recorded since the run (re)started with record on (ghostwrite.ts), else null */
    recording: GhostSegment[] | null = null;
    /** the stage change the run waits on: the area to show (scene: its archive) and what happens on the way */
    pending: { area: number; episode: number; scene: string | null; key: string; note: string } | null = null;
    /** the shown stage's route, and the stage the run is in */
    area = -1; episode = -1; sceneName = '';
    /** what the run carries into the next stage: the save's flags and the area left */
    private carry: { flags: FlagManager; prevArea: number } | null = null;
    /** the run's QF at this stage's tick 0, and this stage's first recorded tick (the frame after setMario's) */
    private qfBase = 0; private recFrom = -1;
    /** the load before the pending stage (stagechange.ts loadGapQf): its QF, and what is left of it */
    loadQf = 0; loadLeft = 0;
    /** the run is in a stage change's load (black: the next stage's files can be read meanwhile) */
    get loading() { return !!this.pending && this.loadLeft > 0; }
    /** what the viewer shows about the run (a movie that would play, the end) */
    notice = '';
    /**
     * Live play's free-roam Shine get (talk.ts TalkDirector.freeRoamShine): a Shine got doesn't end
     * the stage; after its Shine-get demo the Shine flies off and Mario plays on. On by default; never
     * while recording (the recording would desync from its replay: the game, and the replay, leave the
     * stage at the Shine get), so a recorded run always has the game's stage change.
     */
    freeRoamShine = true;
    /** the frame the free-roam notice goes (-1: none showing) */
    private noticeUntil = -1;
    /** the recording as a .smsghost (null: nothing recorded); recording stops */
    takeRecording(o: { area: number; episode: number; region: number; name?: string; gameId?: string; discRevision?: number }): ArrayBuffer | null {
        const R = this.recording;
        this.recording = null;
        return R && R.some((g) => g.frames.length) ? writeSmsGhost(R, o) : null;
    }
    private build(sceneName: string, scene: FileMap, area: number, episode: number, L: LiveInput, sleepPhase: number | null) {
        const carry = this.carry;
        const f = carry ? carry.flags : null;
        // Delfino Plaza's opening demo (setupObjects: read before its flag writes; a fresh save: the first visit)
        const plazaDemo = area === 1 && plazaDemoOnStart(f || new FlagManager(), episode);
        const timing: LiveTiming = {
            ...introTiming([{ qf: 4, anim: 0, phase: 0 }], null, 0),
            live: true, area, scenario: episode, flags: f, plazaDemo,
            skippable: !(area === 1 && (episode === 1 || episode === 9)),
            sleepPhase, makeDirector: (p, map, st, t) => new LiveDirector(p, map, st, t as LiveTiming),
        };
        // decideMarioPosIdx (after setupObjects' flag writes: at the director's setMario)
        const prev = carry ? carry.prevArea : -1;
        if (sleepPhase == null) timing.start = (m) => entranceStart(m.world, decideMarioPosIdx(m.world.flags, area, prev), prev)(m);
        const st = Stage.fresh(this.disc.stageFiles(scene), sceneName, area, episode, 0, 0, timing);
        const C: any = st.player && st.player.simCamera;
        if (C) C.stageDemoName = stageDemoName(st.world.flags, area, episode, plazaDemo);
        this.stage = st; this.area = area; this.episode = episode; this.sceneName = sceneName;
        this.history = st.player ? new ReplayHistory(null, 0) : null;
        this.recFrom = -1;
        this.camPrev = this.camCur = null; this.camW = 0;
        if (this.recording) this.recording.push({ area, episode, frames: [], startQf: this.qfBase });
    }
    update(sceneName: string, scene: FileMap, inp: any, budgetMs = 20): boolean {
        const L: LiveInput | undefined = inp && inp.live;
        if (!L) return false;
        useDiscVersion();
        const P = this.pending;
        let fresh = false, next = false;
        if (L.reset !== this.resetSeen) fresh = true;
        else if (P) {
            // the load (loadGapQf): black, the stage before held at its last frame; its frame count goes
            // on (the viewer's clock is held to it) while the next stage's files are read
            const st0 = this.stage;
            while (st0 && this.loadLeft > 0 && st0.frame < L.frames) { st0.frame++; this.loadLeft -= 4; }
            if (this.loadLeft > 0) return false;
            if (L.area !== P.area || L.episode !== P.episode || (P.scene && sceneName !== P.scene)) return false;   // (the viewer is loading it)
            next = true;
        } else if (!this.stage || L.area !== this.area || L.episode !== this.episode || sceneName !== this.sceneName) fresh = true;
        if (fresh || next) {
            const key = `${sceneName}|${L.area}|${L.episode}|${L.reset}|${next ? this.qfBase : ''}`;
            if (this.liveKey === key && this.error) return false;   // (it failed: don't rebuild every frame)
            this.liveKey = key; this.error = null; this.sync = null; this.q0 = 0;
            if (fresh) {
                this.resetSeen = L.reset; this.qfBase = 0;
                // live play plays file A (its save carries over and the pause menu's Save writes it)
                if (!this.fileAsked && !L.record) { this.saveSlot = 0; this.fileAsked = true; }
                // (a restart of a run playing a file starts again from the file's save)
                const sv = this.saveSlot >= 0 && !L.record ? loadSlot(this.saveSlot) : null;
                this.carry = this.saveSlot >= 0 && !L.record ? { flags: (sv && readSave(sv)) || new FlagManager(), prevArea: -1 } : null;
                // (TApplication: the option block read in, loadOption)
                { const ob = this.carry && loadOptionBlock(); if (ob) this.carry!.flags.loadOption(ob); } this.notice = ''; this.loadQf = this.loadLeft = 0;
                this.recording = L.record ? [] : null;
            } else if (this.stage) this.qfBase += this.stage.qf + Math.max(STAGE_LOAD_QF, this.loadQf);
            this.pending = null; this.paused = false; this.screen = null; this.leaving = null;
            // (the sleeping Mario: only on a stage that starts without its intro, live play not recording)
            const sp = fresh && !L.record && L.sleepPhase != null ? L.sleepPhase : null;
            try { this.build(sceneName, scene, L.area, L.episode, L, sp); }
            catch (e) { this.error = e; this.stage = null; console.warn('[live] stage', e); return false; }
            const D = this.stage!.director;
            if (sp != null && D && (D.hasStartCamera || D.map === 1 && (D.timing as any).plazaDemo || [2, 3, 4, 5, 6, 8, 9, 0x34].includes(D.map))) {
                // (the stage has its intro: it starts from the stage's own start after it, not asleep)
                D.timing.sleepPhase = null;
                const prev = -1, area = L.area;
                D.timing.start = (m) => entranceStart(m.world, decideMarioPosIdx(m.world.flags, area, prev), prev)(m);
            }
            if (next) return false;   // (the new stage's first frame on the next call)
        }
        const st = this.stage!, t0 = performance.now();
        if (!st) return false;
        if (this.leaving) { this.leaveScreens(st, L); return true; }
        if (this.paused) { this.pauseMenu(st, L); if (this.paused) return true; }
        this.wantFrames = L.frames;
        while (st.frame < L.frames && !this.pending && !this.paused && !this.leaving) {
            st.camera = null; st.liveClip = true;   // (live play: clipped against the sim's own camera)
            const pad = st.player ? L.pad() : null;
            const T = st.world.talk;
            if (T) T.freeRoamShine = (L.freeRoamShine ?? this.freeRoamShine) && !this.recording;
            // (the game's own text in live play; Moonshine's Fast text while recording, as its replay reads the talks)
            if (T) T.fastText = !!this.recording;
            const roamed = T ? T.freeRoamTick : -1;
            const carded = T ? T.cardSaveTick : -1;
            try { st.runFrame(null, pad); } catch (e) { this.error = e; console.warn('[live] frame', e); this.stage = null; return false; }
            this.snapCamera(st);
            // (a Shine got: the game's card save after it (DIRECTOR_FLAG_CARD_SAVE_PENDING), here without its question)
            if (T && T.cardSaveTick !== carded) this.save(st, 'Shine got: saved');
            if (T && T.freeRoamTick !== roamed) { this.notice = 'Free-roam Shine get: the game would go back to Delfino Plaza here (off while recording)'; this.noticeUntil = st.frame + 150; }
            else if (this.noticeUntil >= 0 && st.frame >= this.noticeUntil) { this.noticeUntil = -1; if (this.notice.startsWith('Free-roam') || /saved|Saved|nothing saved|could not be written/.test(this.notice)) this.notice = ''; }
            const D = st.director as LiveDirector | null;
            if (D && D.setMarioTick >= 0 && this.recFrom < 0) {
                // Moonshine's first sample: the end of the frame after setMario's (changeState at a frame's
                // last tick runs at the start of the next frame: 4k is in the frame ending 4k + 4)
                const T = D.setMarioTick, F = (T & 3) === 0 ? T + 4 : (T + 3) & ~3;
                this.recFrom = F + 4;
            }
            const seg = this.recording && this.recording.length ? this.recording[this.recording.length - 1] : null;
            if (seg && st.player && pad && this.recFrom >= 0 && st.qf >= this.recFrom) seg.frames.push(liveFrame(this.qfBase + st.qf, pad, st.player));
            if (st.player && this.history) {
                if (this.history.qf.length > 9000 && !this.recording) this.history = new ReplayHistory(null, st.qf - 4);   // (bounded: only the latest frames are drawn)
                this.history.push(st.qf, st.player);
            }
            if (D && D.done && D.done(st.qf)) this.leave(st, D);
            else if (D && pad) this.checkPause(st, D, pad);
            if (performance.now() - t0 > budgetMs) return false;
        }
        return true;
    }
    /**
     * The pause menu (updateGameMode: Start in the game mode with nothing pending, Mario not jumping:
     * STATE_PAUSE_MENU, no movement or animation ticks; TPauseMenu2 isn't drawn): Start again goes on,
     * X picks "exit the area" (state 5: decideNextStage, back to Delfino, and moveStage's fade). The
     * paused frames are not run, so the recording (and its replay) leaves them out. The game pauses at
     * the frame's first tick's changeState; here the frame is finished first.
     */
    paused = false;
    private padWas = 0;
    private checkPause(st: Stage, D: LiveDirector, pad: PadStatus) {
        const was = this.padWas;
        this.padWas = pad.button;
        const T: any = st.world.talk, P: any = st.player;
        if (D.state !== DIR.GAME || !T || T.unk124 !== 0 || (T.dflags & ~0x8000) || st.world.stageTransitionPending || this.area === 0xF) return;
        if (!(pad.button & 0x1000) || (was & 0x1000)) return;
        if (!(P.checkFlag(0x1000) || !P.checkStatusType(0x800))) return;   // (checkActionThing3: not jumping)
        this.paused = true;
        const menu = this.screens ? this.screens.pauseMenu({ area: this.area, episode: st.world.flags.getFlag(MSF.EPISODE) }) : null;
        if (menu) { this.screen = { kind: 'pause', menu }; this.notice = ''; }
        else this.notice = 'Paused: Start continues' + (this.area !== 1 ? ', X exits the area' : '');
    }
    private pauseMenu(st: Stage, L: LiveInput) {
        const pad = L.pad(), was = this.padWas;
        this.padWas = pad.button;
        if (this.screen && this.screen.kind === 'pause') {
            // TPauseMenu2 (getNextState: 0 go on, 5 exit the area; the save isn't kept: go on)
            const M = this.screen.menu;
            for (let k = this.menuFrames(); k > 0; k--) M.frame(pad);
            const ns = M.nextState();
            if (ns === 2) return;
            this.screen = null; this.paused = false;
            if (M.savePicked) this.save(st, 'Saved');
            if (ns === 5) {
                const w = st.world, D = st.director as LiveDirector;
                w.nextArea = { stage: 1, scenario: 0xFF }; w.moviePending = false; w.stageTransitionPending = true;
                D.exitArea(st.qf);
            }
            return;
        }
        const press = (b: number) => (pad.button & b) && !(was & b);
        if (press(0x1000)) { this.paused = false; this.notice = ''; return; }
        if (press(0x400) && this.area !== 1) {
            this.paused = false; this.notice = '';
            const w = st.world, D = st.director as LiveDirector;
            w.nextArea = { stage: 1, scenario: 0xFF }; w.moviePending = false; w.stageTransitionPending = true;
            D.exitArea(st.qf);
        }
    }
    /** the stage's end (STATE_UNK9's fade or the miss's): the next area (moveStage), the flags carried */
    private leave(st: Stage, D: LiveDirector) {
        const w = st.world, f = w.flags, cur: Area = { stage: this.area, scenario: this.episode };
        let next: Area, step = 1;
        if (D.state === DIR.GAME_OVER) {
            if (f.getFlag(MSF.LIFE_COUNT) >= 0) {
                f.setBool(true, MSF.LOST_LIFE_IN_PREV_STAGE);
                next = decideNextStageOfMiss(cur);
            } else {
                // the game over: STATE_CARD_SAVE (7)'s choice first (leaveScreens' step 0)
                next = { stage: 1, scenario: 0xFF };
                step = 0;
            }
            w.moviePending = false;
            if (w.nextArea) w.nextArea.movie = undefined;
        } else next = w.nextArea ? { stage: w.nextArea.stage, scenario: w.nextArea.scenario } : { stage: 1, scenario: 0xFF };
        const movie = w.moviePending && w.nextArea ? w.nextArea.movie : undefined;
        // (a Shine got: the game's card save after it (DIRECTOR_FLAG_CARD_SAVE_PENDING): here without its question)
        this.leaving = { cur, next, note: '', movie, step };
        this.leaveScreens(st, null);
    }
    /** write the run's flags to its file (TFlagManager::save into the browser's slot) */
    private save(st: Stage, what: string) {
        if (this.saveSlot < 0) { this.notice = 'No file is being played: nothing saved'; this.noticeUntil = st.frame + 90; return; }
        const ok = storeSlot(this.saveSlot, writeSave(st.world.flags));
        // (TCardSave: saveSuccess once the card is written, else saveFail)
        if (ok) { st.world.flags.saveSuccess(); storeOption(st.world.flags.saveOption()); } else st.world.flags.saveFail();
        this.notice = ok ? `${what} to file ${'ABC'[this.saveSlot]} (${SAVE_SIZE} bytes, in this browser)` : 'The save could not be written (browser storage unavailable)';
        this.noticeUntil = st.frame + 120;
    }
    /**
     * leave's steps, each waiting on its screen when the HUD gives one (else as the notices had it):
     * the game over's choice (TCardSave 7: then the card's flags back, TFlagManager::restore — the save
     * isn't kept here, the lives come back as a fresh save's — and Delfino, or the airstrip without a
     * Shine), moveStage, the streaming movie (TMovieDirector), the episode select (TSelectDir: the
     * episode picked is mNextArea's scenario and MSF_EPISODE).
     */
    private leaveScreens(st: Stage, L: LiveInput | null) {
        const G = this.leaving!, w = st.world, S = this.screens;
        let f = G.flags || w.flags;
        const pad = L ? L.pad() : null;
        const add = (s: string) => { G.note = G.note ? G.note + '; ' + s : s; };
        const run = (kind: 'gameover' | 'select' | 'movie', make: () => any): any => {
            if (this.screen && this.screen.kind === kind) {
                if (pad) for (let k = this.menuFrames(); k > 0; k--) this.screen.menu.frame(pad);
                return this.screen.menu;
            }
            const m = S ? make() : null;
            if (m === undefined || m === null) return m;   // (undefined: its files are loading)
            this.screen = { kind, menu: m };
            return undefined;
        };
        if (G.step === 0) {
            const m = run('gameover', () => S!.gameOverMenu());
            if (m === undefined || (m && m.choice < 0)) return;
            this.screen = null;
            // (TFlagManager::restore: the file's save back, when the run plays a file)
            if (this.saveSlot >= 0) f.restore(); else { f.setFlag(MSF.LIFE_COUNT, 0); f.correctFlag(); }
            f.setBool(true, MSF.UNK30001);
            G.next = f.getFlag(MSF.SHINE_COUNT) ? { stage: 1, scenario: 0xFF } : { stage: 0, scenario: 0 };
            add(!m ? 'Game over' : m.choice === 1 ? 'Back to the title: the game goes to its title screen here (the run goes on from the save)' : '');
            G.step = 1;
        }
        if (G.step === 1) {
            const P: any = st.player, Gun = P && P.mWaterGun;
            const second = P && P.checkFlag && P.checkFlag(0x8000) && Gun ? (Gun.mSecondNozzle ?? -1) : -1;
            G.n = moveStage(f, G.cur, G.next, second);
            G.step = G.movie !== undefined ? 2 : 3;
        }
        if (G.step === 2) {
            const m = run('movie', () => S!.movie(G.movie!, f));
            if (m === undefined || (m && !m.done)) return;
            this.screen = null;
            if (!m) add(`Streaming movie ${G.movie} plays here (THP movies aren't shown)`);
            else { if (m.note) add(m.note); if (m.result === 'title') G.n = { stage: 0xF, scenario: 0, select: false }; }
            G.step = 3;
        }
        if (G.step === 3) {
            const n = G.n!;
            if (n.select && !this.shineSelect) add(`episode select: episode ${n.scenario + 1}`);
            else if (n.select) {
                const m = run('select', () => S!.selectMenu(selectMenuInput(f, n.stage)));
                if (m === undefined || (m && !m.closeMenu)) return;
                this.screen = null;
                if (m) { n.scenario = m.selected; f.setFlag(MSF.EPISODE, m.selected); }
                else add(`episode select: episode ${n.scenario + 1}`);
            }
            G.step = 4;
        }
        const n = G.n!;
        let note = G.note;
        if (n.stage === 0xF) note = 'The game goes to its title / file select here';
        this.leaving = null;
        this.carry = { flags: f, prevArea: G.prevArea ?? this.area };
        const scene = this.disc.stageArc ? sceneForRoute(this.disc.stageArc, n.stage, n.scenario) : null;
        this.notice = note;
        this.pending = { area: n.stage, episode: n.scenario, scene, key: `${n.stage}:${n.scenario}`, note };
        this.loadQf = this.loadLeft = loadGapQf(n.stage);
        if (!scene || n.stage === 0xF) console.warn('[live] no scene for the next area', n);
    }
    /** the camera's view at the end of the last two frames run (view's in-between), and the frames L.frames asked for */
    private camPrev: LiveCamSnap | null = null; private camCur: LiveCamSnap | null = null;
    private wantFrames = 0;
    /** how much of a frame the view is drawn behind (0..1: 1 in a cutscene; eased in and out over CAM_EASE_FRAMES frames) */
    private camW = 0;
    private snapCamera(st: Stage) {
        const v = super.view(), P = st.player, C: any = P && P.simCamera;
        if (!v || !C) { this.camPrev = this.camCur = null; return; }
        const T = st.world.talk, D = st.director;
        // the cutscene's camera: Mario not the player's (a talk, a demo: the director's unk124; the stage's intro)
        const cutscene = (!!T && T.unk124 !== 0) || (typeof C.isDemoCamera === 'function' && C.isDemoCamera()) || (!!D && D.state === DIR.DEMO);
        this.camW = Math.max(0, Math.min(1, this.camW + (cutscene ? 1 : -1) / CAM_EASE_FRAMES));
        this.camPrev = this.camCur;
        this.camCur = { ...v, w: this.camW, cuts: C.cuts | 0, frame: st.frame };
    }
    /**
     * The sim camera's view (SimRunner.view) drawn alpha (0..1) of the way from the frame before's to
     * the last frame's (the viewer's time since that frame was due, in frames), in a cutscene only.
     * The game draws 30 frames a second on a TV's even cadence; the page's frames come at its own
     * rate (60, 120, 144 Hz...), so a 30 Hz view stepped on them comes 1, 2 or 3 page frames apart:
     * a demo camera's sweep (a bck's 2 frames a game frame, moving up to ~250 units) judders where
     * the game's is even. In between frames the view is drawn as the replays draw a demo (they sample
     * the bck at the page's time). Not across a cut (a demo's start or end, a warp: the game cuts
     * there), and not while Mario is the player's (he is drawn at the last frame: the camera with him).
     * The view drawn is the last frame's at most: up to one frame behind while it is in between, that
     * lag eased in as a cutscene starts and out as it ends (camW: a talk's camera is still easing back
     * when Mario gets control again), so neither end is a jump.
     */
    view(alpha = 1): { pos: number[]; at: number[]; up: number[]; fov: number } | null {
        const v = super.view(), a = this.camPrev, b = this.camCur, st = this.stage;
        if (!v || !a || !b || !st || !(alpha < 1) || !(b.w > 0) || this.pending || st.frame < this.wantFrames || b.frame !== st.frame
            || a.frame !== b.frame - 1 || a.cuts !== b.cuts) return v;
        const t = 1 - b.w * (1 - Math.max(0, alpha)), L = (x: number[], y: number[]) => x.map((p, i) => p + (y[i] - p) * t);
        return { pos: L(a.pos, b.pos), at: L(a.at, b.at), up: L(a.up, b.up), fov: a.fov + (b.fov - a.fov) * t };
    }
    /** Mario isn't on the stage yet (before the director's setMario: the intro), or the run is between stages */
    marioHidden(): boolean {
        const st = this.stage, D = st && st.director;
        return !!this.pending || !!(D && !D.setMarioDone);
    }
    /** how dark the screen is (0..1): the director's fades and the console's wipes (black while the next stage loads) */
    wipe(): number {
        if (this.pending || this.leaving) return 1;
        const st = this.stage, D = st && st.director as LiveDirector | null;
        return D && D.wipe ? D.wipe(st!.qf) : 0;
    }
}

interface LiveCamSnap { pos: number[]; at: number[]; up: number[]; fov: number; w: number; cuts: number; frame: number; }
/** LiveRunner.view: the frames the in-between drawing eases in or out over (0.2 s) */
const CAM_EASE_FRAMES = 6;

/** A live frame as a ghost records it: the pad, Mario's pose and the FLUDD / Yoshi observation. */
function liveFrame(qf: number, pad: PadStatus, P: PlayerMario): GhostFrame {
    const obs = new Uint8Array(8);
    const Y = P.mYoshi ? P.mYoshi.viewState() : null;
    const onYoshi = !!Y && Y.state === 8;
    if (onYoshi) {
        obs[0] = 0x80; obs[1] = Y!.bck & 0xff;
        const fr16 = Math.max(0, Math.min(0xffff, Math.round(Y!.frame * 16))); obs[2] = fr16 >> 8; obs[3] = fr16 & 0xff;
        obs[4] = Math.max(0, Math.min(255, Math.round(Y!.blend * 255)));
    } else if (P.fludd) {
        const f: any = P.fludd;
        obs[0] = 0x08 | (f.nozzle & 7) | (f.spraying ? 0x10 : 0);
    }
    return { qf, pad: { ...pad }, x: P.pos.x, y: P.pos.y, z: P.pos.z, yaw: P.mModelFaceAngle, anim: P.mAnimationId, phase: Math.round(P.phase * 4096) & 4095,
        yoshi: onYoshi ? (Y!.type + 1) : 0, obs };
}
