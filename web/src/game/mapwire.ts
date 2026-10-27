// The tightrope wires (Map/MapWire.cpp, Map/MapWireManager.cpp) and the wire cubes they live in
// (Camera/CubeManagerBase.cpp, CubeMapTool.cpp: gpCubeWire over tables.bin's
// ワイヤーキューブテーブル, CLBIsPointInCube). Each cube of the table is one wire: its length the
// cube's depth, strung at the top of the cube along its rotated Z axis, sagging by half the cube's
// height in the middle (a sine). Mario hanging on one (TMapWireActorManager::doActorToWire) pulls
// its foot points down to him; letting go releases it into a decaying bounce. Wire traps and
// perching birds ride the wire's current shape (getPointPosOnWire at getPosInWire).
//
// Mario is "on the wire" here (his holder is the wire actor: TMario::isOnWire) while the ghost
// plays one of his rope animations (ANIM_ROPE_WALK 0xDB .. ANIM_ROPE_HMOVL 0xE6); his taken
// matrix (where the wire bends to) is his position. The wire fittings' collision
// (/common/map/WireFitting.col at each end) goes into the static map collision.

import { fr, V3, JMASSin, JMASCos, s16, MsMtxSetXYZRPH, mtx, type Mtx } from './math.js';
import { World, NameRef, Stream, parseSceneBin, SceneNode, CUE_MOVE, TakeActor, HitActor, HF, HC, MSG, IDX } from './engine.js';
import { AT } from './actortypes.js';
import { lengthJ } from './player/fmath.js';
import { MapCollision } from './collision.js';

// ---------------------------------------------------------------- cubes
/** CLBDegToShortAngle: CLBRoundf<s16>(deg * 65536 / 360) */
const degToShort = (deg: number) => { const v = fr(deg * fr(65536 / 360)); return s16(Math.trunc(fr(v + (v > 0 ? 0.5 : -0.5)))); };

/** TCubeGeneralInfo: centre (bottom middle), rotation (degrees), size (×100 as loaded). */
export class CubeInfo {
    c = new V3(); r = new V3(); s = new V3(1, 1, 1); unk30 = 0x80; unk34 = 0; name = '';
    load(st: Stream) {
        this.c.set(st.f32(), st.f32(), st.f32());
        this.r.set(st.f32(), st.f32(), st.f32());
        this.s.set(fr(st.f32() * 100), fr(st.f32() * 100), fr(st.f32() * 100));
        this.unk30 = s16(st.u32()); st.u32(); this.unk34 = st.u32() | 0;
    }
}

/** CLBIsPointInCube */
export function isPointInCube(p: V3, c: V3, r: V3, s: V3) {
    let dx = fr(p.x - c.x), dy = fr(p.y - c.y), dz = fr(p.z - c.z);
    if (r.y !== 0 || r.x !== 0 || r.z !== 0) {
        if (r.z !== 0) {
            const a = degToShort(-r.z), cz = JMASCos(a), sz = JMASSin(a);
            const t = fr(dy * sz);
            dy = fr(dx * sz + dy * cz); dx = fr(dx * cz - t);
        }
        if (r.y !== 0) {
            const a = degToShort(-r.y), cy = JMASCos(a), sy = JMASSin(a);
            const t = fr(dz * sy);
            dz = fr(-dx * sy + dz * cy); dx = fr(dx * cy + t);
        }
        if (r.x !== 0) {
            const a = degToShort(-r.x), cx = JMASCos(a), sx = JMASSin(a);
            const t = fr(dz * sx);
            dz = fr(dy * sx + dz * cx); dy = fr(dy * cx - t);
        }
    }
    return -s.x * 0.5 < dx && dx < s.x * 0.5 && 0 < dy && dy < s.y && -s.z * 0.5 < dz && dz < s.z * 0.5;
}

/** TCubeManagerBase over one of tables.bin's cube tables. */
export class CubeManager {
    list: CubeInfo[] = [];
    getInCubeNo(p: V3) { for (let i = 0; i < this.list.length; i++) { const c = this.list[i]; if (isPointInCube(p, c.c, c.r, c.s)) return i; } return -1; }
    isInCube(p: V3, i: number) { if (i < 0 || i >= this.list.length) return false; const c = this.list[i]; return isPointInCube(p, c.c, c.r, c.s); }
    /** The table named so in the scene's map/tables.bin (TCubeManagerBase::load). */
    static fromTables(tables: Uint8Array | null, table: string) {
        const m = new CubeManager();
        if (!tables) return m;
        let found: SceneNode | null = null;
        const find = (n: SceneNode) => { if (found) return; if (n.name === table && n.children) { found = n; return; } for (const ch of n.children || []) find(ch); };
        find(parseSceneBin(tables));
        if (found) for (const ch of (found as SceneNode).children || []) {
            const ci = new CubeInfo(); ci.name = ch.name;
            ci.load(new Stream(ch.data));
            m.list.push(ci);
        }
        return m;
    }
}

// ---------------------------------------------------------------- TMapWire
/** MsPerpendicFootToLineR: the foot of p on the segment a-b (clamped to it). */
function perpendicFoot(a: V3, b: V3, p: V3) {
    const d = V3.sub(b, a);
    let t = fr((fr(p.dot(d)) - fr(a.dot(d))) / fr(d.squared()));
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return new V3(fr(d.x * t + a.x), fr(d.y * t + a.y), fr(d.z * t + a.z));
}

export class MapWirePoint {
    pos = new V3(); defPos = new V3(); posOnWire = 0; defPosOnWire = 0; returnRate = 0;
    reset() { this.pos.set(this.defPos); this.posOnWire = this.defPosOnWire; }
}

const IDLE = 0, HANGING = 1, RELEASED = 2;
export const MapWireConst = {
    mMoveTimerSpeed: 0.03, mDownRateMax: 0.003, mEndRate: 0.001, mStretchRate: 2, mHeightRate: 1.3, mReleaseHeight: 100, mFootLength: 26,
    mDrawWidth: 5, mDrawHeight: 6,
};

export class MapWire {
    start = new V3(); end = new V3(); span = new V3();
    length = 0; hAngle = 0; sag = 0;
    numActive = 0; points: MapWirePoint[] = [];
    hangPos = 0; hangOrBounce = new V3(); moveTimer = 0; bouncePower = 0; bounceAmplitude = 0; bounceDecay = 0;
    drawAxes = [0, 0]; hangRef1 = 0; hangRef2 = 0;
    /** the end fittings' base matrices (mStartFittingModel / mEndFittingModel: /common/map/WireFitting.bmd, drawn by the viewer) */
    fittings: Mtx[] = [];
    state = IDLE;

    init(w: World, ci: CubeInfo) {
        const n = Math.trunc(fr(fr(ci.s.z / 50 + 1) - 2));
        this.numActive = n;
        this.points = [];
        this.length = ci.s.z;
        this.initTipPoints(ci);
        this.sag = fr(ci.s.y * 0.5);
        for (let i = 0; i < n; i++) {
            const p = new MapWirePoint();
            p.posOnWire = p.defPosOnWire = fr((i + 1) / n);
            this.getPointPosDefault(p.posOnWire, p.defPos);
            p.reset();
            this.points.push(p);
        }
        if (this.end.x !== this.start.x) {
            const a = fr(Math.atan(fr(fr(this.end.z - this.start.z) / fr(this.end.x - this.start.x))));
            this.hAngle = fr(fr((-a * 180) / Math.PI) + 90);
        } else this.hAngle = 0;
        const dx = this.end.x - this.start.x, dz = this.end.z - this.start.z, l = Math.sqrt(dx * dx + dz * dz) || 1;
        this.drawAxes = [fr(-dz / l), fr(dx / l)];   // normalized, rotated by 90°
        // the fittings' collision at both ends (SMS_CreatePartsModel's joint 0 at its base matrix)
        const col = (w.files as any).common ? (w.files as any).common('map/wirefitting.col') as Uint8Array | null : null;
        this.fittings = [];
        for (const [p, ry] of [[this.start, ci.r.y], [this.end, fr(ci.r.y + 180)]] as [V3, number][]) {
            const m = mtx(); MsMtxSetXYZRPH(m, p.x, p.y, p.z, ci.r.x, ry, ci.r.z);
            this.fittings.push(m);
            if (!col) continue;
            const cm = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1];
            for (const t of MapCollision.readCol(col.slice().buffer, cm)) w.col.add(t, 'static');
        }
    }
    /** initTipPoints: TRotation3::setEular(x, y, z) times (0, 0, length / 2) */
    initTipPoints(ci: CubeInfo) {
        const h = fr(this.length * 0.5);
        const ax = s16(Math.trunc(fr(fr(ci.r.x / 180) * 32768))), ay = s16(Math.trunc(fr(fr(ci.r.y / 180) * 32768))), az = s16(Math.trunc(fr(fr(ci.r.z / 180) * 32768)));
        const f3 = JMASSin(ax), f5 = JMASSin(ay), f4 = JMASSin(az), f6 = JMASCos(ax), f7 = JMASCos(ay), f8 = JMASCos(az);
        const f9 = fr(f6 * f8), f11 = fr(f6 * f4);
        // its Z column times h
        const hx = fr(fr(fr(f9 * f5) + fr(f3 * f4)) * h), hy = fr(fr(fr(f11 * f5) - fr(f3 * f8)) * h), hz = fr(fr(f6 * f7) * h);
        this.start.set(fr(ci.c.x - hx), fr(fr(ci.c.y - hy) + ci.s.y), fr(ci.c.z - hz));
        this.end.set(fr(hx + ci.c.x), fr(fr(hy + ci.c.y) + ci.s.y), fr(hz + ci.c.z));
        this.span.set(fr(this.end.x - this.start.x), fr(this.end.y - this.start.y), fr(this.end.z - this.start.z));
    }
    getPointPowerAtReleased(pos: number) {
        const rel = pos >= this.hangPos ? fr(fr(pos - this.hangPos) / fr(1 - this.hangPos)) : fr(1 - fr(pos / this.hangPos));
        return fr(1 - fr(rel * rel));
    }
    getPointPosOnLine(pos: number, out: V3) { return out.set(fr(this.start.x + this.span.x * pos), fr(this.start.y + this.span.y * pos), fr(this.start.z + this.span.z * pos)); }
    getPointPosDefault(pos: number, out: V3) {
        return out.set(fr(this.start.x + this.span.x * pos), fr(fr(this.start.y + this.span.y * pos) - fr(this.sag * JMASSin(Math.trunc(fr(pos * 32768))))), fr(this.start.z + this.span.z * pos));
    }
    getPointPosAtReleased(pos: number, out: V3) {
        const l = this.getPointPosOnLine(pos, new V3()), d = this.getPointPosDefault(pos, new V3());
        const pw = this.getPointPowerAtReleased(pos);
        return out.set(l.x, fr(fr(l.y + fr(fr(1 - this.bouncePower) * fr(d.y - l.y))) + fr(pw * this.hangOrBounce.y)), l.z);
    }
    updatePointAtReleased(i: number) {
        const p = this.points[i];
        let pos = p.defPosOnWire;
        if (Math.abs(pos - p.posOnWire) > Math.abs(p.returnRate)) pos = fr(p.posOnWire + p.returnRate);
        this.getPointPosAtReleased(pos, p.pos);
    }
    updateMovePointAtReleased() {
        this.bouncePower = fr(this.bouncePower - this.bounceDecay);
        if (this.bouncePower < MapWireConst.mEndRate) return true;
        this.moveTimer = fr(this.moveTimer + MapWireConst.mMoveTimerSpeed);
        if (this.moveTimer >= 2) this.moveTimer = fr(this.moveTimer - 2);
        this.hangOrBounce.y = fr(fr(JMASCos(Math.trunc(fr(this.moveTimer * 32768))) * this.bounceAmplitude) * this.bouncePower);
        return false;
    }
    initPointAtJustReleased(pos: number, p: MapWirePoint) {
        p.posOnWire = pos;
        this.getPointPosAtReleased(pos, p.pos);
        p.returnRate = fr(fr(p.defPosOnWire - pos) / 1000);
    }
    /** release: let go of (marioVel: SMS_GetMarioSpeedX/Y/Z) */
    release(marioVel: V3) {
        if (this.state === RELEASED) return;
        this.state = RELEASED;
        this.hangOrBounce.zero();
        this.numActive = this.points.length;
        const half = Math.trunc(this.numActive / 2);
        if (half !== 0) {
            const adv = fr(this.hangPos / half);
            for (let i = 0; i < half; i++) { this.points[i].reset(); this.initPointAtJustReleased(fr(adv * (i + 1)), this.points[i]); }
        }
        if (this.numActive - half !== 0) {
            const adv = fr(fr(1 - this.hangPos) / (this.numActive - half));
            for (let i = half; i < this.numActive; i++) { this.points[i].reset(); this.initPointAtJustReleased(fr(fr(adv * (i - half + 1)) + this.hangPos), this.points[i]); }
        }
        // (abs: MSL's <cmath> float overload, |hangPos - 0.5|)
        const stretch = fr(MapWireConst.mStretchRate * Math.abs(fr(this.hangPos - 0.5)));
        this.bounceAmplitude = marioVel.y > 0 ? fr(MapWireConst.mHeightRate * fr(marioVel.length())) : MapWireConst.mReleaseHeight;
        this.bounceDecay = fr(MapWireConst.mDownRateMax * stretch);
        this.bouncePower = 1;
        this.moveTimer = 1;
    }
    getPointPosAtHanged(pos: number, out: V3) {
        const off = fr(pos - this.hangPos), H = this.hangOrBounce;
        out.x = fr(this.span.x * off + H.x);
        out.z = fr(this.span.z * off + H.z);
        if (pos <= this.hangRef1) out.y = fr(H.y + fr(fr(fr(this.start.y - H.y) * fr(this.hangRef1 - pos)) / this.hangRef1));
        else if (pos >= this.hangRef2) out.y = fr(H.y + fr(fr(fr(this.end.y - H.y) * fr(pos - this.hangRef2)) / fr(1 - this.hangRef2)));
        else out.y = H.y;
        return out;
    }
    getPointInfoAtHanged(pos: number, p: MapWirePoint) { p.posOnWire = pos; this.getPointPosAtHanged(pos, p.pos); }
    /** setFootPointsAtHanged(the taken matrix's translation) */
    setFootPointsAtHanged(t: V3) {
        this.state = HANGING;
        this.hangOrBounce.set(t);
        this.hangPos = this.getPosInWire(this.hangOrBounce);
        const fl = MapWireConst.mFootLength;
        this.hangRef1 = fr(this.hangPos - fr(fl / this.length));
        this.hangRef2 = fr(this.hangPos + fr(fl / this.length));
        this.numActive = 2;
        const r = this.points;
        if (r.length < 2) return;
        if (fl < fr(this.hangPos * this.length)) this.getPointInfoAtHanged(this.hangRef1, r[0]);
        else { r[0].posOnWire = this.hangPos; r[0].pos.set(this.hangOrBounce); }
        if (fl < fr(fr(1 - this.hangPos) * this.length)) this.getPointInfoAtHanged(this.hangRef2, r[1]);
        else { r[1].posOnWire = this.hangPos; r[1].pos.set(this.hangOrBounce); }
    }
    move() {
        if (this.state !== RELEASED) return;
        if (this.updateMovePointAtReleased()) {
            for (let i = 0; i < this.numActive; i++) this.points[i].reset();
            this.state = IDLE;
        } else for (let i = 0; i < this.numActive; i++) this.updatePointAtReleased(i);
    }
    getPosInWire(p: V3) {
        const a = new V3(this.start.x, 0, this.start.z), b = new V3(this.end.x, 0, this.end.z);
        const foot = perpendicFoot(a, b, p);
        return fr(fr(V3.sub(foot, a).length()) / fr(V3.sub(b, a).length()));
    }
    getPointPosOnWire(pos: number, out: V3) {
        if (pos < 0) pos = 0;
        if (pos > 1) pos = 1;
        if (this.state === HANGING) return this.getPointPosAtHanged(pos, out);
        return this.getPointPosAtReleased(pos, out);
    }
    /** For the viewer: the wire's polyline now (start, the active points, end). */
    polyline(): V3[] { return [this.start.clone(), ...this.points.slice(0, this.numActive).map((p) => p.pos.clone()), this.end.clone()]; }
}

// ---------------------------------------------------------------- TMapWireManager
/** Mario's rope animations (TMario's wire states): his holder is then the wire actor. */
export const isMarioOnWireAnim = (anim: number) => anim >= 0xDB && anim <= 0xE6;

/** the simulated Mario as the wire actor sees him (TMario::getTakenMtx: his body's base matrix) */
interface WireMario extends TakeActor { getTakenMtx(): Mtx; }
const isSimMario = (m: any): m is WireMario => !!m && typeof m.getTakenMtx === 'function' && typeof m.wireMove === 'function';

/**
 * TMapWireActor (アクター補助): a hit actor in the item group, put at Mario's taken matrix each
 * tick he's in a wire cube (else no collision). The hit check gives it Mario when he's within its
 * 200 x 200 cylinder; its checkTakingActor then sends him TAKE, and his receiveMessage catches
 * the wire (TMario's mHolder is this actor; it holds him).
 */
export class MapWireActor extends TakeActor {
    static mCommonAttackRadius = 200; static mCommonAttackHeight = 200;
    /** unk70: he let go (the wire is released) */
    unk70 = false;
    constructor(public mgr: WireActorManager) {
        super('アクター補助');
        this.initHitActor(AT.MAP_WIRE_ACTOR, 1, HC.PLAYER, MapWireActor.mCommonAttackRadius, MapWireActor.mCommonAttackHeight, 0, 0);
    }
    getTakingMtx(): Mtx | null { return null; }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.DETACH && sender === this.held) { this.held = null; this.unk70 = true; return true; }
        return false;
    }
    checkTakingActor() {
        if (this.held && this.held.holder !== this) { this.held = null; this.unk70 = true; }
        if (this.mgr.wire) for (const c of this.collisions.slice())
            if (c.isActorType(AT.MARIO) && c.receiveMessage(this, MSG.TAKE)) this.held = c as TakeActor;
    }
    getTipPoints(start: V3, end: V3) { const w = this.mgr.wire!; start.set(w.start); end.set(w.end); }
    /** getPosInWire: his place along the wire, flat (both tips at y 0), from the actor's position */
    getPosInWire() {
        const a = new V3(), b = new V3();
        this.getTipPoints(a, b);
        a.y = 0; b.y = 0;
        const foot = perpendicFoot(a, b, this.pos);
        const l = (v: V3) => lengthJ(v.x, v.y, v.z);
        return fr(l(V3.sub(foot, a)) / l(V3.sub(b, a)));
    }
}

/** TMapWireActorManager for Mario (TMapWireManager::loadAfter: entry(gpMarioOriginal)). */
class WireActorManager {
    /** unk7C: the wire whose cube he's in */
    wire: MapWire | null = null;
    /** unk4 */
    actor: MapWireActor;
    /** (the ghost's Mario: on a wire while he plays a rope animation) */
    private ghostHeld = false; private ghostLetGo = false;
    constructor(public mgr: MapWireManager) {
        this.actor = new MapWireActor(this);
        const w = mgr.world, g = w.groups[IDX.ITEM] || (w.groups[IDX.ITEM] = []);
        g.push(this.actor);
    }
    /** the wire actor holds him */
    get held() { return isSimMario(this.mgr.world.mario) ? !!this.actor.held : this.ghostHeld; }
    takenPos() {
        const m = this.mgr.world.mario;
        if (isSimMario(m)) { const t = m.getTakenMtx(); return new V3(fr(t[3]), fr(t[7]), fr(t[11])); }
        return m.pos.clone();
    }
    doActorToWire() {
        const m = this.mgr.world.mario;
        if (!isSimMario(m)) return this.doActorToWireGhost();
        const A = this.actor, prev = this.wire;
        const no = this.mgr.cubes.getInCubeNo(m.pos);
        this.wire = no !== -1 ? this.mgr.getWire(no & 0xFFFF) : null;
        A.checkTakingActor();
        if (prev && this.wire && this.wire !== prev) A.unk70 = true;
        if (A.unk70) {
            if (prev) prev.release(m.vel);
            A.unk70 = false;
            return;
        }
        if (A.held) {
            if (this.wire) this.wire.setFootPointsAtHanged(this.takenPos());
            if (prev) { prev.setFootPointsAtHanged(this.takenPos()); this.wire = prev; }
        }
        if (!this.wire && prev) prev.release(m.vel);
    }
    /** the ghost's Mario can't be sent TAKE: held while he plays a rope animation */
    private doActorToWireGhost() {
        const m = this.mgr.world.mario;
        const prev = this.wire;
        const no = this.mgr.cubes.getInCubeNo(m.pos);
        this.wire = no !== -1 ? this.mgr.wires[no] || null : null;
        const on = !!m.present && isMarioOnWireAnim(m.anim);
        if (this.ghostHeld && !on) { this.ghostHeld = false; this.ghostLetGo = true; }
        if (this.wire && !this.ghostHeld && on) this.ghostHeld = true;
        if (prev && this.wire && this.wire !== prev) this.ghostLetGo = true;
        if (this.ghostLetGo) {
            if (prev) prev.release(m.vel);
            this.ghostLetGo = false;
            return;
        }
        if (this.ghostHeld) {
            if (this.wire) this.wire.setFootPointsAtHanged(m.pos);
            if (prev) { prev.setFootPointsAtHanged(m.pos); this.wire = prev; }
        }
        if (!this.wire && prev) prev.release(m.vel);
    }
    /** (perform's end) the actor at his taken matrix while he's in a wire cube, else no collision */
    placeActor() {
        const A = this.actor;
        A.onHitFilter(HF.NO_COLLISION);
        if (this.wire && isSimMario(this.mgr.world.mario)) {
            A.offHitFilter(HF.NO_COLLISION);
            A.pos.set(this.takenPos());
        }
    }
}

export class MapWireManager extends NameRef {
    cubes = new CubeManager();
    wires: MapWire[] = [];
    actors: WireActorManager[] = [];
    upper = [0x78, 0x78, 0x78]; lower = [0x32, 0x32, 0x32];
    constructor(public world: World, name = 'ワイヤー管理') { super(name); }
    /** TMapWireManager::load: (a string, the array sizes, the drawing's width/height and colours) */
    load(s: Stream) {
        s.str(); s.u32(); s.u32();
        MapWireConst.mDrawWidth = s.f32(MapWireConst.mDrawWidth); MapWireConst.mDrawHeight = s.f32(MapWireConst.mDrawHeight);
        this.upper = [s.s32(0x78), s.s32(0x78), s.s32(0x78)];
        this.lower = [s.s32(0x32), s.s32(0x32), s.s32(0x32)];
    }
    loadAfter() { if (!this.actors.length) this.actors.push(new WireActorManager(this)); }
    /** getWireNo: gpCubeWire->getInCubeNo */
    getWireNo(p: V3) { return this.cubes.getInCubeNo(p); }
    getWire(i: number) { return this.wires[i] || null; }
    /** getPointPosInNthWire */
    getPointOnWire(no: number, p: V3) { const w = this.wires[no]; if (!w) return p.clone(); return w.getPointPosOnWire(w.getPosInWire(p), new V3()); }
    /** Mario on a wire (SMS_IsMarioOnWire) */
    isMarioOnWire() { return this.actors.some((a) => a.held); }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        if (!this.actors.length) this.loadAfter();
        for (const a of this.actors) a.doActorToWire();
        for (const w of this.wires) w.move();
        for (const a of this.actors) a.placeActor();
    }
}

declare module './engine.js' { interface World { mapWires: MapWireManager | null; } }
World.prototype.mapWires = null;

/**
 * Sets world.mapWires (gpMapWireManager with gpCubeWire): the wire cube table from the scene's
 * map/tables.bin and a TMapWire for each of its cubes. Once per stage (later calls give the same
 * one); call it before scene.bin's objects load (wire traps and birds look their wire up then).
 */
export function installMapWires(w: World): MapWireManager {
    if (w.mapWires) return w.mapWires;
    const m = new MapWireManager(w, 'ワイヤーマネージャー');
    m.cubes = CubeManager.fromTables(w.files.scene('map/tables.bin'), 'ワイヤーキューブテーブル');
    for (const ci of m.cubes.list) { const wire = new MapWire(); wire.init(w, ci); m.wires.push(wire); }
    w.mapWires = m;
    return m;
}
