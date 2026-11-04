// gpCubeStream (流れキューブテーブル in map/tables.bin) and TMapWarp::watchToWarp's stream push on Mario.
// Kept apart from mapobj/lib.ts (which imports scene.ts) so that Stage can call mapWarpStream.
import { fr, V3, mtx, MsMtxSetXYZRPH } from './math.js';
import { World, Stream, parseSceneBin, SceneNode } from './engine.js';
import { isPointInCube } from './mapwire.js';

export interface StreamCube { c: V3; r: V3; s: V3; unk34: number; unk38: number; unk3C: number; unk40: number; }
const STREAMS = new WeakMap<World, StreamCube[]>();
/** 流れキューブテーブル's TCubeStreamInfo cubes: unk18 their rotation, unk40 their strength */
export function streamCubes(w: World): StreamCube[] {
    let l = STREAMS.get(w);
    if (l) return l;
    l = [];
    const b = w.files.scene('map/tables.bin');
    if (b) {
        let found: SceneNode | null = null;
        const find = (n: SceneNode) => { if (found) return; if (n.name === '流れキューブテーブル' && n.children) { found = n; return; } for (const c of n.children || []) find(c); };
        try { find(parseSceneBin(b)); } catch { }
        if (found) for (const ch of (found as SceneNode).children || []) {
            const s = new Stream(ch.data);
            const c = new V3(s.f32(), s.f32(), s.f32()), r = new V3(s.f32(), s.f32(), s.f32());
            const sc = new V3(fr(s.f32() * 100), fr(s.f32() * 100), fr(s.f32() * 100));
            s.u32(); s.u32();
            const unk34 = s.u32() | 0;
            const unk40 = s.s32(), unk38 = s.s32();
            l.push({ c, r, s: sc, unk34, unk38, unk3C: unk34, unk40 });
        }
    }
    STREAMS.set(w, l);
    return l;
}
/** gpCubeStream->getInCubeNo */
export function inStreamCube(w: World, p: V3): StreamCube | null {
    for (const c of streamCubes(w)) if (isPointInCube(p, c.c, c.r, c.s)) return c;
    return null;
}

/**
 * TMapWarp::watchToWarp's stream (TMap::perform's movement, before Mario's): in a 流れキューブテーブル cube, Mario
 * is pushed along it, (0, 0, unk40 / 100) turned by the cube's rotation: SMS_FlowMoveMario (types 0 and 1:
 * only while swimming) or SMS_WindMoveMario (the others). Not here: the warp grounds (BG isWarp: the
 * Mario warp and model change) and the map-change grounds.
 */
export function mapWarpStream(w: World) {
    const m: any = w.mario;
    if (!m || typeof m.windMove !== 'function') return;
    const c = inStreamCube(w, m.pos);
    if (!c) return;
    const r = mtx(); MsMtxSetXYZRPH(r, 0, 0, 0, c.r.x, c.r.y, c.r.z);
    const s = fr(c.unk40 * fr(0.01));
    const v = new V3(fr(r[2] * s), fr(r[6] * s), fr(r[10] * s));
    if (c.unk38 === 0 || c.unk38 === 1) m.flowMove(v); else m.windMove(v);
}

