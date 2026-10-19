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
import { mapObjWorldHooks } from './mapobj/index.js';
import './player/emario.js';
import { setMarioArchive } from './player/base.js';

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

export class SimRunner {
    private rng: RngReplay | null = null;
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
        const key = `${sceneName}|${segI}|${q0}`;
        const want = inp.t - q0;
        if (this.key !== key || !this.stage || this.stage.qf > want + 4) {
            this.key = key; this.q0 = q0; this.error = null;
            try { this.stage = Stage.fresh(this.disc.stageFiles(scene), sceneName, seg.route.area, seg.route.episode); }
            catch (e) { this.error = e; this.stage = null; console.warn('[game] stage', e); return false; }
            const st0 = this.stage;
            this.rng = g.rng ? new RngReplay(g.rng, segI, q0, () => q0 + st0.qf) : null;
        }
        const st = this.stage!;
        const track = this.track(inp);
        const t0 = performance.now();
        while (st.qf + 4 <= want) {
            st.camera = this.camera(inp, q0 + st.qf + 4, segI);
            rngCtx.roll = this.rng ? this.rng.roll : null; rngCtx.node = this.rng ? this.rng.node : null;
            try { st.runFrame(track); } catch (e) { this.error = e; console.warn('[game] frame', e); this.stage = null; return false; }
            finally { rngCtx.roll = null; rngCtx.node = null; }
            if (performance.now() - t0 > budgetMs) return false;
        }
        return true;
    }
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
