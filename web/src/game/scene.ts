// A stage as TMarDirector::setupObjects builds it: scenecmn.bin's characters, the conductor's
// graphs (scene.ral), tables.bin, then scene.bin, every object made by its class name
// (TMarNameRefGen) and loaded from its bytes, loadAfter on everything, the graphs put on the
// ground, and the conductor's init (the enemy managers make their enemies). Then the frame:
// TMarDirector::direct's four movement ticks, the hit checks every fourth, the animations on the
// frame's last, and the goop's stamps after it.

import { MSF } from './msflags.js';
import { DEMO_FLAG } from './talk.js';
import { V3, srand } from './math.js';
import { traceFollowCtx } from './feedback.js';
import {
    World, Files, NameRef, Stream, parseSceneBin, SceneNode, ObjChara, HitActor, IDX, GROUP_NAMES, parseRails, GraphWeb, CUE_MOVE, CUE_CALC_ANIM,
    LiveActor, shineIDofExStage, calcKeyCode,
} from './engine.js';
import { MapCollision, mapGridFromPayload, mapWarpFromPayload } from './collision.js';
import { MarioProxy, MarioTrack } from './mario.js';
import { PlayerMario, PlayerDirector, IntroTiming, NO_MOVE_STATES } from './player/player.js';
import type { PadStatus } from './player/pad.js';
import { Water, Fludd } from './water.js';
import { Pollution } from './pollution.js';
import { CHARAS } from './charas.js';
import { installMapWires, thinkCubeArea } from './mapwire.js';
import { installEventWatchers } from './eventwatcher.js';
import { installTalk, TalkCursor } from './talk.js';
import { cameraBck } from './camera/bck.js';
import { TimeRec, SnapTimeObj, makeMeasurementGroup } from './timerec.js';

/** A class the game makes from scene.bin (TMarNameRefGen::getNameRef_*), by its name there. */
export type Maker = (w: World, name: string) => NameRef;
export const CLASSES = new Map<string, Maker>();
export function register(type: string, make: Maker) { CLASSES.set(type, make); }
/** Classes whose scene.bin children are their own entries (TNameRefPtrAryT), not a group's members. */
const PTR_ARY = new Set(['StageEnemyInfoHeader', 'EventTable']);

export interface StageFiles extends Files {
    /** common.szs (/common/...) */
    common(path: string): Uint8Array | null;
    /** data/scenecmn.bin */
    scenecmn: Uint8Array | null;
}

/** The game camera of a frame (the ghost's camera record): for clipping, as the game's camera does it. */
export interface GameCamera { pos: [number, number, number]; /** a trace's look-at point (gpCamera->unk148; pos is unk124) */ at?: [number, number, number]; /** world-from-view rotation (x, y, z, w) */ quat: [number, number, number, number]; fovy: number; aspect: number; near: number; }

export class Stage {
    world = new World();
    /** Every object made, in scene.bin's order. */
    objects: NameRef[] = [];
    /** Each object's scene.bin node. */
    nodeOf = new Map<NameRef, SceneNode>();
    camera: GameCamera | null = null;
    /** live play: with no recorded camera, the sim camera clips (a replay's frames without one clip nothing) */
    liveClip = false;
    /** QF of the movement tick last run (0: the stage's first). */
    qf = 0;
    /**
     * "Play recording": called after the player's movement each tick (before the camera's) with that
     * tick's QF, to put Mario where the recording has him (SimRunner.pinToRecording). null: the game
     * code alone moves him ("Simulate").
     */
    pinMario: ((qf: number) => void) | null = null;
    /** "Play recording": called at the end of each tick's movement (before the frame's CalcAnim) to put the stage's actors where the recording has them */
    pinWorld: ((qf: number) => void) | null = null;
    frame = 0;
    seed = 0;
    /** 計測グループ: the TSnapTimeObjs (inert: unk14 0) */
    measurementGroup: SnapTimeObj[] = [];

    /** the input-driven player and the director's opening, when the stage runs from a ghost's inputs */
    player: PlayerMario | null = null;
    director: PlayerDirector | null = null;

    constructor(public files: StageFiles, public sceneName: string, map: number, stage: number, intro: IntroTiming | null = null) {
        const w = this.world;
        w.sceneName = sceneName;
        w.files = files;
        w.map = map; w.stage = stage;
        // (live play's later stages: the save's flags carried over from the stage before, stagechange.ts)
        const carried = intro ? (intro as any).flags : null;
        if (carried) w.flags = carried;
        w.exShineGot = carried ? shineIDofExStage(map) !== 0xFF && w.flags.getShineFlag(shineIDofExStage(map)) : !!(intro && intro.exShineGot);
        w.flags.setupStage(map, stage, w.exShineGot, shineIDofExStage(map), !carried);
        // a trace's save as recorded: exactly its Shines and its count, in place of the ones flags.ts inferred
        if (intro && intro.traceShines) {
            for (let i = 0; i < 120; i++) w.flags.setFlag(MSF.SHINE_BASE + i, intro.traceShines.includes(i) ? 1 : 0);
            w.flags.setFlag(MSF.SHINE_COUNT, intro.traceShines.length);
        }
        w.respawnShines = !!(intro && intro.respawnShines);
        w.marioPosIdx = intro && intro.marioPosIdx ? intro.marioPosIdx : 0;
        w.traceAlive = intro && intro.traceAlive ? intro.traceAlive : null;
        w.traceHitFilter = intro && intro.traceHitFilter ? intro.traceHitFilter : null;
        if (intro && intro.shadowMarioEvent !== undefined) w.flags.setFlag(MSF.SHADOW_MARIO_EVENT, intro.shadowMarioEvent);
        w.groups = GROUP_NAMES.map(() => []);
        // the map's collision (TMap: the grid size from the scene's Map object, filled from map.col)
        const sb = files.scene('map/scene.bin');
        if (!sb) throw new Error('no scene.bin');
        const root = parseSceneBin(sb);
        let grid: [number, number] | null = null;
        const findMap = (n: SceneNode) => { if (n.type === 'Map' && !grid) { const dv = new DataView(n.data.buffer, n.data.byteOffset, n.data.byteLength); grid = mapGridFromPayload(dv); (w as any).mapWarp = mapWarpFromPayload(dv); } for (const c of n.children || []) findMap(c); };
        findMap(root);
        const g = grid || [16, 16];
        w.col = new MapCollision(g[0], g[1]);
        const col = files.scene('map/map.col');
        if (col) for (const t of MapCollision.readCol(col.slice().buffer)) w.col.add(t, 'static');
        // the conductor's graphs
        const ral = files.scene('map/scene.ral');
        if (ral) for (const [name, nodes] of parseRails(ral)) w.graphs.set(name, new GraphWeb(nodes, name));
        // characters (scenecmn.bin's ObjChara: a manager's folder)
        if (files.scenecmn) this.walk(parseSceneBin(files.scenecmn), true);
        else for (const [n, folder] of Object.entries(CHARAS)) { const c = new ObjChara(n); c.folder = folder; w.register(c); }
        // (TApplication: TTimeRec::start(0xDFC0), its flag 1) the game objects' 計測グループ, after scenecmn.bin (MarDirectorSetupObjects.cpp)
        TimeRec.start(0xDFC0).mFlags |= 1;
        this.measurementGroup = makeMeasurementGroup();
        for (const o of this.measurementGroup) w.register(o);
        // goop, water, Mario
        w.pollution = new Pollution(files, map, stage, files.common);
        w.water = new Water(w, files);
        w.fludd = new Fludd(w.water, files);
        if (intro) { this.player = new PlayerMario(w); w.mario = this.player; }
        else w.mario = new MarioProxy(w);
        // scene.bin
        installMapWires(w);
        // tables.bin (before scene.bin, its object in the game objects): of it, the stage's enemy table
        const tb = files.scene('map/tables.bin');
        if (tb) {
            let troot: SceneNode | null = null;
            try { troot = parseSceneBin(tb); } catch { }
            const find = (n: SceneNode) => { if (PTR_ARY.has(n.type)) this.walk(n, false); else for (const c of n.children || []) find(c); };
            if (troot) find(troot);
        }
        this.walk(root, false);
        // the event group: a TEventWatcher per .sb of /common/sp and map/sp (eventwatcher.ts)
        installEventWatchers(w, files);
        for (const o of this.objects) o.loadAfter();
        // TMarDirector::setup2: the event table's map objects get their event ids
        const evt = w.search('イベントテーブル') as any;
        if (evt && evt.list) evt.list.forEach((it: any, i: number) => { const obj = w.search(it.unk14) as any; if (obj) { obj.eventId = i & 0xFFFF; it.unk28 = obj; } });
        // TMarDirector's talk mode and the message window (talk.ts): the NPCs entryNPC'd at their loadAfter
        if (this.player) installTalk(w, this.objects, files.scene('map/message.bmg'), files.common('2d/sys_message.bmg'));
        // (the camera's loadAfter fireStartDemoCamera, held until the director is up: the coaster's stage 1 demo)
        if (this.player && this.player.simCamera && (this.player.simCamera as any).fireDeferredDemo) (this.player.simCamera as any).fireDeferredDemo();
        // the camera's demos (TCameraBck: the stage intro's and the director's demo queue's, with their views)
        if (this.player && this.player.simCamera) (this.player.simCamera as any).bckSource = (name: string) => cameraBck(w, name);
        for (const gw of w.graphs.values()) { gw.initGoalIndex(new V3()); gw.attachToGround(w); }
        w.conductor.init();
        if (this.player && intro && !intro.fromLoad) this.leadFrame();
        if (this.player && intro) {
            const make = (intro as any).makeDirector as ((p: PlayerMario, map: number, start: boolean, t: IntroTiming) => PlayerDirector) | undefined;   // (live play's: stagechange.ts LiveDirector)
            this.director = make ? make(this.player, map, !!files.scene('map/camera/startcamera.bck'), intro) : new PlayerDirector(this.player, map, !!files.scene('map/camera/startcamera.bck'), intro); this.player.driftFrom = Math.max(intro.demoEndTick, (intro.firstSample ?? 0) - 1); w.director = this.director; }
    }

    private walk(n: SceneNode, common: boolean, group = -1) {
        const w = this.world;
        let o: NameRef | null = null;
        if (n.children && PTR_ARY.has(n.type) && !common) {
            // a TNameRefPtrAryT made by its class (the stage's enemy table): its children are its entries
            const make = CLASSES.get(n.type);
            if (make) {
                o = make(w, n.name); o.name = n.name; w.register(o); this.objects.push(o); this.nodeOf.set(o, n);
                const list = (o as any).list as NameRef[];
                for (const c of n.children) {
                    const mk = CLASSES.get(c.type); if (!mk) continue;
                    const e = mk(w, c.name); e.name = c.name; list.push(e);
                    try { e.load(new Stream(c.data)); } catch (err) { console.warn('[game] load', c.type, c.name, err); }
                }
                return;
            }
        }
        if (n.children) {
            // groups: an IdxGroup's children are its group's members
            const gi = n.type === 'IdxGroup' && n.groupIndex !== undefined ? n.groupIndex : group;
            for (const c of n.children) this.walk(c, common, gi);
            return;
        }
        if (common) {
            if (n.type === 'ObjChara' || n.type === 'SmplChara') { o = new ObjChara(n.name); (o as ObjChara).load(new Stream(n.data)); w.register(o); }
            return;
        }
        if (n.type === 'Mario') { o = w.mario; w.mario.name = n.name; }
        else {
            const make = CLASSES.get(n.type);
            if (!make) return;
            o = make(w, n.name);
        }
        o.name = n.name;
        w.register(o);
        this.objects.push(o);
        this.nodeOf.set(o, n);
        // TViewObjPtrListT::load pushes a child before its load: what the load adds (a Fire Chomp's tail) comes after it
        if (group >= 0 && o instanceof HitActor) (w.groups[group] = w.groups[group] || []).push(o);
        try { o.load(new Stream(n.data)); }
        catch (e) { console.warn('[game] load', n.type, n.name, e); }
    }

    /**
     * The frame the stage's objects run before the ghost's QF 0 (Mario not yet in it). Found from
     * the ghosts, not the decomp: with it the Ricco 4 secret's rolling sticks and the Sirena 4
     * secret's blocks line up with the recorded run (sync 232 -> 2428 and 260 -> 1240 QF), and the
     * main-stage ghosts are unchanged. Its source in the game (the director's first frame before
     * Moonshine starts counting, most likely) isn't pinned down.
     * TODO: the Noki Bay secret (NB6 ghost 5141834D80D3C, its second segment) needs its rolling
     * geta blocks about 21 frames further on than this gives (TRollBlock's roll: the landing at
     * stage tick 585 that the video's H 36.15 shows, and the one at 632, both need it), so the
     * objects' lead before a segment that starts on a stage change is longer, by an amount the
     * decomp doesn't say.
     */
    private leadFrame() {
        const w = this.world;
        for (let t = 0; t < 4; t++) { w.col.clearMove(); w.conductor.perform(CUE_MOVE); }
        w.conductor.perform(CUE_CALC_ANIM);
    }

    // ---------------------------------------------------------------- running
    /** Restart from the stage's start: the RNG seed (unknown in the game: 0 unless the ghost says). */
    /**
     * A stage from its start: seed srand's seed, moveTick0 the director's mMoveTickCount at the
     * ghost's first frame (it decides which ticks run the hit check: every 4th). Both are what the
     * ghost will record; until then 0.
     */
    static fresh(files: StageFiles, sceneName: string, map: number, stage: number, seed = 0, moveTick0 = 0, intro: IntroTiming | null = null) {
        srand(seed); const s = new Stage(files, sceneName, map, stage, intro); s.seed = seed; s.world.moveTickCount = moveTick0; return s;
    }

    /**
     * One frame (TMarDirector::direct: four movement ticks of 5 units, 30 frames a second). With the
     * player, pad is the frame's PADStatus (TApplication::gameLoop reads it and updates its meaning
     * before direct; the other ticks resetButtons and updateMeaning), and the director's
     * changeState runs after every tick.
     */
    runFrame(track: MarioTrack | null, pad: PadStatus | null = null) {
        const w = this.world, P = this.player, D = this.director;
        if (P) { P.track = track; P.padRead(pad); }
        else (w.mario as MarioProxy).track = track;
        // (gpCamera exists from the stage's load: before the first CalcAnim's clip, a trace's movement sees the sim's camera, the game's there)
        if (!w.clipCamera && this.simClipFallback && P) w.clipCamera = simClipCamera(P.simCamera);
        if (traceFollowCtx.apply) traceFollowCtx.apply((function* () { for (const m of w.conductor.liveManagers) for (const a of (m.objs || [])) yield a; })(), (a) => a.keyCode || calcKeyCode(a.name));
        for (let tick = 0; tick < 4; tick++) {
            const last = tick === 3;
            // (the changeState after the last tick of the frame before runs here, after the pad's read)
            if (D && this.qf > 0 && tick === 0) D.changeState(this.qf);
            if (P && tick > 0) P.padTick();
            // STATE_PAUSE_MENU (and the guide, the card save, the reset): the tick runs without CUE_MOVE and
            // CUE_CALC_ANIM (mMoveTickCount stays), only the console and the director's movement
            const noMove = !!D && NO_MOVE_STATES.has(D.state);
            if (!noMove) w.moveTickCount++;
            w.tickCount++;
            this.qf++;
            if (!(w.moveTickCount & 3)) w.hitCheck.checkActorsHit();
            else w.hitCheck.clearHitNum();
            if (noMove) {
                if (P) P.mapWarpStreamAndDrift(false);
                if (w.talk) w.talk.tick(last, false);
                if (D && !last) D.changeState(this.qf);
                continue;
            }
            // DEMO_FLAG_SHINE_GET_STOP_THE_WORLD (a Shine's appear demo, TShine::appearWithTimeCallback): the
            // director runs Shine PfLst Mov / Anm (PerformLists.bin: シャインマネージャー, camera 1) instead
            const stw = !!(w.talk && w.talk.checkDemoFlag(DEMO_FLAG.SHINE_GET_STOP_THE_WORLD));
            if (stw) {
                if (P) P.mapWarpStreamAndDrift(false);
                const sm = w.conductor.getManagerByName('シャインマネージャー');
                if (sm) sm.testPerform(CUE_MOVE);
                if (P) P.cameraTick((tick === 0 ? 1 : 0) | (last ? 2 : 0));
                if (w.talk) w.talk.tick(last, !!D && D.state === 4);
                if (last && sm) sm.testPerform(CUE_CALC_ANIM);
                if (D && !last) D.changeState(this.qf);
                continue;
            }
            // PerformList Movement: map group, wave, graffiti group, conductor, manager group, player group, camera, water manager...
            // TMap::perform: the moving collision's grid starts the tick empty
            w.col.clearMove();
            // (then TMapWarp::watchToWarp: the stream cubes' push)
            if (P) P.mapWarpStreamAndDrift(true, false);
            if (w.pollution) w.pollution.move(w.mario.pos);
            // the wave (TMapObjWave::perform)
            { const wv: any = (w as any).mapObjWave; if (wv) wv.perform(CUE_MOVE); }
            // (PerformList.cpp: a movement entry takes CUE_MOVEMENT_GATE_A / _B too; the director clears gate A on
            // odd mMoveTickCount and gate B when bit 1 is set, so the cue is exactly CUE_MOVE one tick in four:
            // TCannon's sway steps then)
            w.conductor.perform(CUE_MOVE | (w.moveTickCount & 1 ? 0 : 0x1000) | (w.moveTickCount & 2 ? 0 : 0x2000));
            // the manager group: the wires
            if (w.mapWires) w.mapWires.perform(CUE_MOVE);
            // (the drift check of the tick before: a trace's record is Mario as his perform begins, so with the gates' pushes in)
            if (P) P.driftCheckPending();
            if (P) { P.testPerform(CUE_MOVE); if (this.pinMario) this.pinMario(this.qf); P.cameraTick((tick === 0 ? 1 : 0) | (last ? 2 : 0)); }
            else {
                const m = w.mario as MarioProxy;
                m.update(this.qf);
                m.perform(CUE_MOVE);
                thinkCubeArea(w, m.pos);
                this.emitWater(m);
            }
            if (w.water) w.water.move();
            // (sky, mirror model) the event group: the stage's scripts
            if (w.eventGroup) w.eventGroup.perform(CUE_MOVE);
            // (シルエット設定, then the インダイレクトシーン group: the bath water)
            for (const o of w.indirectScene) o.testPerform(CUE_MOVE);
            // PerformList Console (Group 2D: the talk window), then TMarDirector::movement (movement_game)
            if (w.talk) w.talk.tick(last, !!D && D.state === 4);
            if (this.pinWorld) this.pinWorld(this.qf);
            if (last) {
                // PerformList CalcAnim
                this.clip();
                w.conductor.perform(CUE_CALC_ANIM);
                // (TSplashManager's CUE_CALC_ANIM: move)
                if (w.splashManager) w.splashManager.testPerform(CUE_CALC_ANIM);
            }
            if (D && !last) D.changeState(this.qf);
        }
        if (P) P.checkMoved(w.tickCount);
        // the frame's drawing: the goop's stamps
        if (w.pollution) w.pollution.draw();
        // the console's timer (TGCConsole2: the scripts' getTime)
        if (w.eventGroup) w.eventGroup.frame();
        this.frame++;
    }
    private emitWater(m: MarioProxy) {
        const w = this.world;
        if (!w.fludd || !m.present || !m.fludd) return;
        w.fludd.emit(m.fludd, m.pos, m.vel, !!(m.fludd as any).burst);
    }
    /** The managers' and conductor's clipping, against the frame's game camera (else all in view). */
    /** a trace's frames without a recorded camera (the stage's first): the sim's camera, which is the game's there (gpCamera at its load) */
    simClipFallback = false;
    private clip() { this.world.clipCamera = this.camera ?? ((this.liveClip || this.simClipFallback) && this.player ? simClipCamera(this.player.simCamera) : null); }

    /** Run up to QF q (frames are whole: the frame holding q). */
    runTo(q: number, track: MarioTrack | null, budgetFrames = Infinity, pad: ((qf: number) => PadStatus | null) | null = null) {
        let n = 0;
        while (this.qf + 4 <= q && n < budgetFrames) { this.runFrame(track, pad ? pad(this.qf + 4) : null); n++; }
        return this.qf + 4 > q;
    }
    extraDrawables() { return this.world.extras; }
    /** Everything the viewer draws for the simulated objects. */
    liveActors(): LiveActor[] { return this.objects.filter((o) => o instanceof LiveActor) as LiveActor[]; }
}

/** Live play (no recorded camera): the sim camera of the frame (its eye, look-at, up and FOV) as a GameCamera. */
function simClipCamera(C: any): GameCamera | null {
    if (!C || !C.pos || !C.at) return null;
    const p = C.pos, a = C.at, u = C.up || { x: 0, y: 1, z: 0 };
    // view space looks down -z: z the back (eye - at), x = up × z, y = z × x
    let zx = p.x - a.x, zy = p.y - a.y, zz = p.z - a.z;
    let l = Math.hypot(zx, zy, zz); if (!(l > 0)) return null; zx /= l; zy /= l; zz /= l;
    let xx = u.y * zz - u.z * zy, xy = u.z * zx - u.x * zz, xz = u.x * zy - u.y * zx;
    l = Math.hypot(xx, xy, xz); if (!(l > 0)) return null; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    // the rotation's columns x, y, z to a quaternion
    const m00 = xx, m11 = yy, m22 = zz, tr = m00 + m11 + m22;
    let qx: number, qy: number, qz: number, qw: number;
    if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; qw = 0.25 * S; qx = (yz - zy) / S; qy = (zx - xz) / S; qz = (xy - yx) / S; }
    else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (yz - zy) / S; qx = 0.25 * S; qy = (yx + xy) / S; qz = (zx + xz) / S; }
    else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (zx - xz) / S; qx = (yx + xy) / S; qy = 0.25 * S; qz = (zy + yz) / S; }
    else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (xy - yx) / S; qx = (zx + xz) / S; qy = (zy + yz) / S; qz = 0.25 * S; }
    return { pos: [p.x, p.y, p.z], at: [a.x, a.y, a.z], quat: [qx, qy, qz, qw], fovy: C.fovy || 50, aspect: (640 * 0.9134614) / 448, near: 10 };
}
declare module './engine.js' { interface World { clipCamera: GameCamera | null; } }
World.prototype.clipCamera = null;
export { IDX };
register('TalkCursor', (_w, n) => new TalkCursor(n));
