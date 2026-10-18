// A stage as TMarDirector::setupObjects builds it: scenecmn.bin's characters, the conductor's
// graphs (scene.ral), tables.bin, then scene.bin, every object made by its class name
// (TMarNameRefGen) and loaded from its bytes, loadAfter on everything, the graphs put on the
// ground, and the conductor's init (the enemy managers make their enemies). Then the frame:
// TMarDirector::direct's four movement ticks, the hit checks every fourth, the animations on the
// frame's last, and the goop's stamps after it.

import { V3, srand } from './math.js';
import {
    World, Files, NameRef, Stream, parseSceneBin, SceneNode, ObjChara, HitActor, IDX, GROUP_NAMES, parseRails, GraphWeb, CUE_MOVE, CUE_CALC_ANIM,
    LiveActor,
} from './engine.js';
import { MapCollision, mapGridFromPayload } from './collision.js';
import { MarioProxy, MarioTrack } from './mario.js';
import { Water, Fludd } from './water.js';
import { Pollution } from './pollution.js';
import { CHARAS } from './charas.js';
import { installMapWires } from './mapwire.js';

/** A class the game makes from scene.bin (TMarNameRefGen::getNameRef_*), by its name there. */
export type Maker = (w: World, name: string) => NameRef;
export const CLASSES = new Map<string, Maker>();
export function register(type: string, make: Maker) { CLASSES.set(type, make); }

export interface StageFiles extends Files {
    /** common.szs (/common/...) */
    common(path: string): Uint8Array | null;
    /** data/scenecmn.bin */
    scenecmn: Uint8Array | null;
}

/** The game camera of a frame (the ghost's camera record): for clipping, as the game's camera does it. */
export interface GameCamera { pos: [number, number, number]; /** world-from-view rotation (x, y, z, w) */ quat: [number, number, number, number]; fovy: number; aspect: number; near: number; }

export class Stage {
    world = new World();
    /** Every object made, in scene.bin's order. */
    objects: NameRef[] = [];
    /** Each object's scene.bin node. */
    nodeOf = new Map<NameRef, SceneNode>();
    camera: GameCamera | null = null;
    /** QF of the movement tick last run (0: the stage's first). */
    qf = 0;
    frame = 0;
    seed = 0;

    constructor(public files: StageFiles, public sceneName: string, map: number, stage: number) {
        const w = this.world;
        w.files = files;
        w.map = map; w.stage = stage;
        w.groups = GROUP_NAMES.map(() => []);
        // the map's collision (TMap: the grid size from the scene's Map object, filled from map.col)
        const sb = files.scene('map/scene.bin');
        if (!sb) throw new Error('no scene.bin');
        const root = parseSceneBin(sb);
        let grid: [number, number] | null = null;
        const findMap = (n: SceneNode) => { if (n.type === 'Map' && !grid) grid = mapGridFromPayload(new DataView(n.data.buffer, n.data.byteOffset, n.data.byteLength)); for (const c of n.children || []) findMap(c); };
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
        // goop, water, Mario
        w.pollution = new Pollution(files, map, stage, files.common);
        w.water = new Water(w, files);
        w.fludd = new Fludd(w.water, files);
        w.mario = new MarioProxy(w);
        // scene.bin
        installMapWires(w);
        this.walk(root, false);
        for (const o of this.objects) o.loadAfter();
        for (const gw of w.graphs.values()) { gw.initGoalIndex(new V3()); gw.attachToGround(w); }
        w.conductor.init();
    }

    private walk(n: SceneNode, common: boolean, group = -1) {
        const w = this.world;
        let o: NameRef | null = null;
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
        try { o.load(new Stream(n.data)); }
        catch (e) { console.warn('[game] load', n.type, n.name, e); }
        if (group >= 0 && o instanceof HitActor) (w.groups[group] = w.groups[group] || []).push(o);
    }

    // ---------------------------------------------------------------- running
    /** Restart from the stage's start: the RNG seed (unknown in the game: 0 unless the ghost says). */
    static fresh(files: StageFiles, sceneName: string, map: number, stage: number, seed = 0) { srand(seed); const s = new Stage(files, sceneName, map, stage); s.seed = seed; return s; }

    /** One frame (TMarDirector::direct: four movement ticks of 5 units, 30 frames a second). */
    runFrame(track: MarioTrack | null) {
        const w = this.world;
        w.mario.track = track;
        for (let tick = 0; tick < 4; tick++) {
            const last = tick === 3;
            w.moveTickCount++; w.tickCount++;
            this.qf++;
            if (!(w.moveTickCount & 3)) w.hitCheck.checkActorsHit();
            else w.hitCheck.clearHitNum();
            // PerformList Movement: map group, wave, graffiti group, conductor, manager group, player group, camera, water manager...
            // TMap::perform: the moving collision's grid starts the tick empty
            w.col.clearMove();
            if (w.pollution) w.pollution.move(w.mario.pos);
            w.conductor.perform(CUE_MOVE);
            // the manager group: the wires
            if (w.mapWires) w.mapWires.perform(CUE_MOVE);
            w.mario.update(this.qf);
            w.mario.perform(CUE_MOVE);
            this.emitWater(w.mario);
            if (w.water) w.water.move();
            if (last) {
                // PerformList CalcAnim
                this.clip();
                w.conductor.perform(CUE_CALC_ANIM);
            }
        }
        // the frame's drawing: the goop's stamps
        if (w.pollution) w.pollution.draw();
        this.frame++;
    }
    private emitWater(m: MarioProxy) {
        const w = this.world;
        if (!w.fludd || !m.present || !m.fludd) return;
        w.fludd.emit(m.fludd, m.pos, m.vel, !!(m.fludd as any).burst);
    }
    /** The managers' and conductor's clipping, against the frame's game camera (else all in view). */
    private clip() { this.world.clipCamera = this.camera; }

    /** Run up to QF q (frames are whole: the frame holding q). */
    runTo(q: number, track: MarioTrack | null, budgetFrames = Infinity) {
        let n = 0;
        while (this.qf + 4 <= q && n < budgetFrames) { this.runFrame(track); n++; }
        return this.qf + 4 > q;
    }
    extraDrawables() { return this.world.extras; }
    /** Everything the viewer draws for the simulated objects. */
    liveActors(): LiveActor[] { return this.objects.filter((o) => o instanceof LiveActor) as LiveActor[]; }
}

declare module './engine.js' { interface World { clipCamera: GameCamera | null; } }
World.prototype.clipCamera = null;
export { IDX };
