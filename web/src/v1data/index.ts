// v1's data, made in the browser from the user's own disc: the files v1's site hosted (maps/,
// objects/, models/ and the data scripts), built on first request by the TypeScript port of v1's
// converters (tools/) and kept in memory. The stage list (names, routes, scenes) is bundled
// metadata; everything drawn or simulated comes from the disc.
import { Bytes, openArc } from './bin.js';
import { setImageEncoder } from './glb.js';
import { encodePng } from './png.js';
import { pngDataUri } from './png.js';
import { buildStage } from './stage.js';
import { packCollision } from './collision.js';
import { buildArea, AreaObjects } from './objects.js';
import { setParamsArchive } from './objparts.js';
import { buildMario, buildYoshi, buildWaterTex, buildShineGet } from './models.js';
import { exportJpa, EFFECTS, BW_EFFECTS, BG_EFFECTS } from './jpa.js';
import STAGES from './tables/stages.json';

interface GameFS { has(path: string): boolean; read(path: string): Promise<ArrayBuffer> }
type Arc = Map<string, Bytes>;

setImageEncoder(async (img, alpha, max) => ({ bytes: await encodePng(img, alpha, max), mime: 'image/png' }));

export class V1Data {
    private arcs = new Map<string, Promise<Arc | null>>();
    private files = new Map<string, Promise<any>>();
    private areas = new Map<string, Promise<AreaObjects>>();
    readonly index: any[] = STAGES as any[];
    /** area x episode -> scene, from the stage list's object files */
    private table: string[][] = [];
    constructor(private fs: GameFS) {
        for (const e of this.index) for (const [route, file] of Object.entries<string>((e.objects || {}).scenes || {})) {
            const [a, ep] = route.split(':').map(Number);
            (this.table[a] = this.table[a] || [])[ep] = file.replace(/^objects\//, '').replace(/\.json$/, '');
        }
    }
    private arc(path: string): Promise<Arc | null> {
        if (!this.arcs.has(path)) this.arcs.set(path, this.fs.has(path) ? this.fs.read(path).then((b) => openArc(new Uint8Array(b))) : Promise.resolve(null));
        return this.arcs.get(path)!;
    }
    sceneArc(scene: string) { return this.arc(`data/scene/${scene}.szs`); }
    /** set up what the converters read from params.szs */
    async init() { setParamsArchive(await this.arc('data/params.szs')); }

    private area(id: string): Promise<AreaObjects> {
        if (!this.areas.has(id)) {
            const entry = this.index.find((e) => e.id === id);
            if (!entry) return Promise.reject(new Error(`no stage ${id}`));
            this.areas.set(id, buildArea(entry, this.table, (s) => this.sceneArc(s), (img) => pngDataUri(img, true)));
        }
        return this.areas.get(id)!;
    }
    private entryOfScene(scene: string) { return this.index.find((e) => Object.values<string>((e.objects || {}).scenes || {}).includes(`objects/${scene}.json`)); }

    /** A v1 site file: an ArrayBuffer for binary ones (the .b64.txt are served decoded), else parsed JSON. */
    get(path: string): Promise<any> {
        path = path.replace(/^\.?\//, '');
        if (!this.files.has(path)) this.files.set(path, this.make(path));
        return this.files.get(path)!;
    }
    has(path: string) {
        path = path.replace(/^\.?\//, '');
        return path === 'maps/index.json' || /^(maps|objects|models)\//.test(path);
    }
    private async make(path: string): Promise<any> {
        const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
        if (path === 'maps/index.json') return JSON.parse(JSON.stringify(this.index));
        let m = /^maps\/(.+)\.glb(\.b64\.txt)?$/.exec(path);
        if (m) {
            const e = this.index.find((x) => x.file === path || x.id === m![1]);
            const arc = await this.sceneArc(e ? e.scenes[0] : m[1]);
            if (!arc) throw new Error(`the disc has no ${m[1]}`);
            return ab(await buildStage(arc));
        }
        m = /^maps\/(.+)\.col(\.b64\.txt)?$/.exec(path);
        if (m) {
            const e = this.index.find((x) => x.col === path || x.id === m![1]);
            for (const s of e ? e.scenes : [m[1]]) { const arc = await this.sceneArc(s); const c = arc && arc.get('map/map.col'); if (c) return ab(packCollision(c)); }
            throw new Error(`no collision for ${m[1]}`);
        }
        m = /^objects\/(.+)\.lib\.glb(\.b64\.txt)?$/.exec(path);
        if (m) return ab((await this.area(m[1])).lib);
        if (path === 'objects/bgeso.json') {
            for (const p of this.areas.values()) { const a = await p; if (a.extra.has(path)) return a.extra.get(path); }
            throw new Error('Gooper Blooper data needs his stage loaded first');
        }
        m = /^objects\/(.+)\.json$/.exec(path);
        if (m) {
            const e = this.entryOfScene(m[1]);
            if (!e) throw new Error(`no objects for ${m[1]}`);
            const a = await this.area(e.id);
            return a.scenes.get(m[1]);
        }
        if (path === 'models/mario.glb.b64.txt' || path === 'models/mario.glb') return ab((await this.mario()).glb);
        if (path === 'models/mario_bck.json') return (await this.mario()).bck;
        if (path === 'models/yoshi.glb.b64.txt' || path === 'models/yoshi.glb') { const a = await this.arc('data/yoshi.szs'); if (!a) throw new Error('no yoshi.szs'); return ab(await buildYoshi(a)); }
        throw new Error(`not a v1 data file: ${path}`);
    }
    private marioP: Promise<{ glb: Uint8Array; bck: any }> | null = null;
    private mario() { return this.marioP || (this.marioP = this.arc('data/mario.szs').then((a) => { if (!a) throw new Error('no mario.szs'); return buildMario(a); })); }

    /** The data scripts' globals: JPA_RES (particle.szs + the Chain Chomp's), WATER_TEX, SHINE_BCK, CAM_BCK, SG_LETTERS. */
    async globals() {
        const part = await this.arc('data/particle.szs'), monte = await this.sceneArc('monte1');
        const todo: [string, Arc, string][] = [];
        if (part) for (const [k, f] of Object.entries(EFFECTS)) if (part.has(f)) todo.push([k, part, f]);
        if (monte) for (const [k, f] of Object.entries(BW_EFFECTS)) if (monte.has(f)) todo.push([k, monte, f]);
        const out: any = { JPA_RES: exportJpa(todo) };
        const mario = await this.arc('data/mario.szs');
        if (mario) out.WATER_TEX = await buildWaterTex(mario, (img, alpha) => pngDataUri(img, alpha));
        const sg = await this.sceneArc('mare1'), common = await this.arc('data/common.szs'), game = await this.arc('data/game_6.szs');
        if (sg && common && game) Object.assign(out, await buildShineGet(sg, common, game, (img, alpha) => pngDataUri(img, alpha)));
        return out;
    }
    /** Gooper Blooper's particles (added to JPA_RES where he is): bgeso/jpa in a stage archive that has him. */
    async gessoJpa(scene: string | null) {
        const scenes = [scene, 'ricco8', ...this.index.flatMap((e) => e.scenes)].filter((s): s is string => !!s);
        for (const s of scenes) {
            const arc = await this.sceneArc(s);
            if (arc && [...Object.values(BG_EFFECTS)].some((f) => arc.has(f))) return exportJpa(Object.entries(BG_EFFECTS).filter(([, f]) => arc.has(f)).map(([k, f]) => [k, arc, f] as [string, Arc, string]));
        }
        return {};
    }
}
