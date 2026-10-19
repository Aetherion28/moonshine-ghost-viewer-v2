// The map's drawn-by-hand things (MoveBG/MapObjFlag.cpp, MapObjGrass.cpp, MapObjPole.cpp) and
// the static map parts (Map/MapStaticObject.cpp's TMapStaticObj): what of them the game runs.
//
// Flags flutter (their cloth's vertices a sine over the rows and columns, its phase moving each
// frame; big ones make their sound) and grass sways (ten shared offsets): both kept here as the
// game works them out (TMapObjFlag.verts, TMapObjGrassManager.unk20) with their random draws;
// they are drawn by GX calls of their own, which the viewer doesn't draw from the sim.
// TMapStaticObj: its looping sound (the river's babble, the falls), its particles (told as
// effects) and its collision (Bianco Hills' invisible air walls); its model is the viewer's.
//
// TMapObjSoundGroup (the waves' sound along a rail, from the camera's place) isn't ported.

import { fr, V3, MsSin, MsWrap, MsRandF, MsMtxSetXYZRPH, mtx, Mtx } from '../math.js';
import { World, NameRef, Actor, HitActor, Stream, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { ObjCollisionManager } from './objcol.js';

const perform = (w: World, o: NameRef) => w.conductor.others.push(o);

// ---------------------------------------------------------------- flags
const FLAG_TEX = ['flagSun', 'flagWhite', 'flagRedsun', 'flagMonte', 'flagBird', 'flagHigekuri', 'flagBenvenuto', 'flagDolpicDolphin', 'flagDolSun',
    'flagDolSunWelcome', 'flagBianco', 'flagRiccoBuoy', 'flagSailMonte', 'MammaYacht00', 'flagMare'];
const FLAG_MGRS = new WeakMap<World, MapObjFlagManager>();
let mFlutterSpeed = 4;

export class MapObjFlag extends HitActor {
    unk68 = 0; unk6C = 0; unk70 = 0; unk74 = 0;
    /** the cloth's vertices (rows x columns, in the flag's own space) */
    verts: V3[][] = [];
    unk7C = 125; unk80 = 130; unk84 = 20; unk88: number;
    /** its matrix (where it's drawn) */
    unk8C: Mtx = mtx();
    unkBC = 1;
    texture = '';
    constructor(public world: World, name = '旗') { super(name); this.unk88 = fr(360 * MsRandF()); }
    load(s: Stream) { Actor.prototype.load.call(this, s); this.init(s.str()); }
    init(tex: string) {
        this.texture = tex;
        const S = this.scale;
        this.unk68 = fr(100 * S.z); this.unk6C = fr(100 * S.y);
        this.unk7C = fr(this.unk7C / S.z); this.unk80 = fr(this.unk80 / S.y); this.unk84 = fr(this.unk84 * S.z);
        this.unk70 = Math.trunc(fr(this.unk68 / 50)); this.unk74 = Math.trunc(fr(this.unk6C / 100));
        if (this.unk70 < 2) this.unk70 = 3;
        if (this.unk74 < 2) this.unk74 = 3;
        MsMtxSetXYZRPH(this.unk8C, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        const cw = fr(this.unk68 / this.unk70), rh = fr(this.unk6C / this.unk74);
        this.verts = [];
        for (let i = 0; i < this.unk74; i++) { const row: V3[] = []; for (let j = 0; j < this.unk70; j++) row.push(new V3(0, fr(i * rh), fr(j * cw))); this.verts.push(row); }
        const m = FLAG_MGRS.get(this.world);
        if (m) m.registerObj(this, tex);
        this.initHitActor(AT.MAP_OBJ_FLAG, 1, 0, 0, 0, 0, 0);
    }
    updateVertex() {
        for (let i = 0; i < this.unk74; i += this.unkBC) {
            const ra = fr(i * this.unk80);
            for (let j = 0; j < this.unk70; j += this.unkBC) {
                const k = fr(j / this.unk70);
                let a = fr(this.unk88 + fr(-j * this.unk7C + ra));
                a = MsWrap(a, -180, 180);
                this.verts[i][j].x = fr(fr(this.unk84 * k) * MsSin(a));
            }
        }
    }
    update() {
        MsMtxSetXYZRPH(this.unk8C, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.updateVertex();
        this.unk88 = fr(this.unk88 + mFlutterSpeed);
        if (this.unk88 > 360) this.unk88 = fr(this.unk88 - 360);
        if (this.scale.y > 3 && this.scale.z > 3) this.world.sound(SE.OBJ_FLAG, this.pos);
    }
}
export class MapObjFlagManager extends NameRef {
    lists: MapObjFlag[][] = FLAG_TEX.map(() => []);
    constructor(public world: World, name = '旗管理') { super(name); FLAG_MGRS.set(world, this); perform(world, this); }
    load(s: Stream) {
        super.load(s);
        s.str();
        switch (this.world.map) { case 0: mFlutterSpeed = 16; break; case 2: mFlutterSpeed = 16; break; case 4: mFlutterSpeed = 12; break; default: mFlutterSpeed = 8; break; }
    }
    registerObj(f: MapObjFlag, tex: string) { const i = FLAG_TEX.indexOf(tex); if (i >= 0 && this.lists[i].length < 0x14) this.lists[i].push(f); }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) for (const l of this.lists) for (const f of l) f.update(); }
}

// ---------------------------------------------------------------- grass
const GRASS_MGRS = new WeakMap<World, MapObjGrassManager>();
export class MapObjGrassGroup extends HitActor {
    unk68 = 0;
    /** the blades' tips (unk6C) */
    tips: V3[] = [];
    /** near (0) or far (1) */
    unk78 = 0;
    constructor(public world: World, name = '草群') { super(name); }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.unk68 = s.s32();
        const sx = fr(this.scale.x * 100), sz = fr(this.scale.z * 100), sy = fr(this.scale.y * 200);
        for (let i = 0; i < this.unk68; i++) {
            const x = fr(fr(fr(fr(sx * MsRandF()) * 2) + this.pos.x) - sx);
            const z = fr(fr(fr(fr(sz * MsRandF()) * 2) + this.pos.z) - sz);
            const y = fr(fr(fr(sy * MsRandF()) + this.pos.y) + 100);
            this.tips.push(new V3(x, y, z));
        }
        const m = GRASS_MGRS.get(this.world);
        if (m) m.entryGrassGroup(this, this.unk68);
    }
    /** calc: near or far from the camera (always near in Bianco Hills) */
    calc() {
        if (this.world.map === 2) { this.unk78 = 0; return; }
        const c = this.world.clipCamera as any, p = c && c.pos ? c.pos : this.world.mario.pos;
        const d = Math.sqrt(V3.sub(this.pos, p).squared());
        this.unk78 = d < MapObjGrassManager.mDistNear ? 0 : 1;
    }
}
export class MapObjGrassManager extends NameRef {
    static mWidth = 12; static mSwingWidth = 50; static mSwingSpeed = fr(0.04); static mDistNear = 800; static mDistFar = 25000;
    groups: MapObjGrassGroup[] = []; unk18 = 0; unk1C = 0;
    /** the swing offsets the blades take in turn (ten) */
    unk20 = new Float32Array(10);
    constructor(public world: World, name = '草管理') { super(name); GRASS_MGRS.set(world, this); perform(world, this); }
    entryGrassGroup(g: MapObjGrassGroup, n: number) { this.groups.push(g); this.unk1C += n; }
    perform(cue: number) {
        if (!(cue & CUE_CALC_ANIM)) return;
        let t = 0;
        for (let i = 0; i < 10; i++) { this.unk20[i] = fr(MapObjGrassManager.mSwingWidth * fr(Math.sin(fr(this.unk18 + t)))); t = fr(t + fr(0.2)); }
        this.unk18 = fr(this.unk18 + MapObjGrassManager.mSwingSpeed);
        if (this.unk18 > fr(3.14159 * 2)) this.unk18 = 0;
        for (const g of this.groups) g.calc();
    }
}

// ---------------------------------------------------------------- poles (drawing only)
export class MapObjPoleManager extends NameRef {
    load(s: Stream) { super.load(s); s.str(); }
}
export class MapObjPole extends HitActor { load(_s: Stream) { } }

// ---------------------------------------------------------------- TMapStaticObj
/** actor_data_table: [name, actor type, col file, col in /mapObj (FLAG_UNK2), sound id, particle (type 1 / 3: emitted each frame)] */
const STATIC: [string, number, string | null, boolean, number, string | null][] = [
    ['SeaIndirect', 0, null, false, -1, null], ['ReflectParts', 0, null, false, -1, null], ['ReflectSky', 0, null, false, -1, null],
    ['sun_mirror', 0, null, true, -1, null], ['sea', 0, null, false, -1, null], ['falls', 0, null, false, SE.OBJ_FALL_SMALL, null],
    ['fountain', 0, null, false, SE.OBJ_FOUNTAIN, null], ['TopOfCorona', AT.TOP_OF_CORONA, null, false, -1, 'coronaSmoke'],
    ['BiancoRiver', 0, null, false, -1, null], ['SoundObjRiver', 0, null, false, SE.EV_STREAM, null],
    ['SoundObjWaterIntoWater', 0, null, false, SE.EV_STREAM_DOWN, null], ['BiancoAirWall', 0, 'BiaAirWall', true, -1, null],
    ['BiancoBossEffectLight', 0, null, false, -1, 'wmlinLight'], ['BiaWaterPollution', 0, null, false, -1, null],
    ['riccoSea', 0, 'riccoSea', false, -1, null], ['riccoSeaPollutionS0', 0, 'riccoSeaPollutionS0', false, -1, null],
    ['riccoSeaPollutionS1', 0, 'riccoSeaPollutionS1', false, -1, null], ['riccoSeaPollutionS2', 0, 'riccoSeaPollutionS2', false, -1, null],
    ['riccoSeaPollutionS3', 0, 'riccoSeaPollutionS3', false, -1, null], ['riccoSeaPollutionS4', 0, 'riccoSeaPollutionS4', false, -1, null],
    ['MareFalls', 0, null, false, SE.OBJ_FOUNTAIN, null], ['mareSeaPollutionS0', 0, 'mareSeaPollutionS0', false, -1, null],
    ['mareSeaPollutionS12', 0, 'mareSeaPollutionS12', false, -1, null], ['mareSeaPollutionS34567', 0, 'mareSeaPollutionS34567', false, -1, null],
    ['Mare5ExGate', 0, null, false, -1, null], ['MonteRiver', 0, 'MonteRiver', false, -1, null], ['IndirectObj', 0, null, false, -1, null],
    ['TargetArrow', 0, null, false, -1, null],
];
export class MapStaticObj extends HitActor {
    actorName = ''; data: (typeof STATIC)[number] | null = null; soundId = -1;
    col: ObjCollisionManager | null = null;
    constructor(public world: World, name = '') { super(name); perform(world, this); }
    load(s: Stream) { Actor.prototype.load.call(this, s); this.actorName = s.str(); }
    loadAfter() { if (!this.data) this.init(this.actorName); }
    init(name: string) {
        this.actorName = name;
        const d = STATIC.find((e) => e[0] === name) || null;
        this.data = d;
        if (!d) return;
        this.initHitActor(d[1], 5, 0, 0, 0, 0, 0);
        if (d[2]) {
            // initMapCollision: a static collision, set up where it stands
            const c = this.col = new ObjCollisionManager(this.world, 1, d[3] ? '/mapObj' : '/map/map', null);
            c.init(d[2], 0);
            c.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
        }
        this.soundId = d[4];
    }
    perform(cue: number) {
        if (!(cue & CUE_CALC_ANIM) || !this.data) return;
        if (this.soundId !== -1) this.world.sound(this.soundId, this.pos);
        if (this.data[5]) this.world.effect(this.data[5], this.pos, this.data[1] === AT.TOP_OF_CORONA ? new V3(1.8, 1.8, 1.8) : undefined);
    }
}

register('MapObjFlagManager', (w, n) => new MapObjFlagManager(w, n));
register('MapObjFlag', (w, n) => new MapObjFlag(w, n));
register('MapObjGrassManager', (w, n) => new MapObjGrassManager(w, n));
register('MapObjGrassGroup', (w, n) => new MapObjGrassGroup(w, n));
register('MapObjPoleManager', (_w, n) => new MapObjPoleManager(n));
register('MapObjPole', (_w, n) => new MapObjPole(n));
register('MapStaticObj', (w, n) => new MapStaticObj(w, n));
