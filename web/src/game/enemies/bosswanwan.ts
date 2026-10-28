// TBossWanwan / TBWLeash / TBWPicket / TBWHit / TBWBinder / TBossWanwanManager
// (Enemy/bosswanwan.cpp): the big burning Chain Chomp of Pianta Village ("Chain Chomp's Bath",
// episode 4, monte1).
//
// It rides the "bwanwan" graph (TBWBinder only lets it move along the link it is on and pulls
// it back onto it), hopping along at a pace that scales with its heat (mHitPoints out of
// mSLBWHitPointMax); at a node it jumps (node flag 1) or rolls on to the link that leads most
// away from Mario (rollNextGraphNode). Its chain (TRope, 15 points mSLLeashNodeLen apart: the
// head on the ball's joint 5) is staked to the picket: staked, the chain keeps it within 650 /
// 860 of the stake, and after 600 ticks of a hot chomp straining the stake it shakes the picket
// out (TNerveBWShake). Water cools it a point a hit (a thrown barrel all at once), it heats up a
// point every 20 ticks and, cold for 2400 ticks, barks itself hot again (TNerveBWBark, which
// also pulls out the stake). Mario can carry the loose picket (TAKE) and, while it is cold,
// drag it by the chain (TBWPicket::moveRequest -> pullTail); dragged within 400 of the node
// nearest the bath (BW_BATH_POS: the graph's goal index) it jumps in (TNerveBWJumpToBath), cools
// to gold and the boss Shine appears (TNerveBWDie). The ball, its links and the picket burn
// Mario while it is hot (the first 8 links).
//
// For the viewer: the body is the manager's actor (its BRK, bwanwan_body.brk, at heat x (end - 1),
// rate 0; bwanwan_body_gold.brk in the bath; its joints as the calc leaves them in `locals`:
// the motion blend between BCKs, the root's translation dropped while airborne, the ball (joint 1)
// rolled by unk168). The chain links (BWLeashNode.model, bwanwan_chain.bmd, its BRK at the link's
// temperature) and the picket (BWPicket.model) are in world.extras; neither is drawn once it is in
// the bath (the game stops performing them). Effects: 'bwan:<particle>' world effects.
//
// Not here: camera shake / rumble (shakeCamera), the bas animation sounds, the demo camera.
// MarioProxy never sends TAKE / THROWN / HIP_DROP to the picket and has no stick
// (gpMarioOriginal->mIntendedYaw / mIntendedMag), so from a ghost the chomp stays staked until it
// shakes the stake out and is never dragged to the bath: see the report.

import { fr, V3, Mtx, mtx, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsSin, MsCos, MsMtxSetXYZRPH, JMASSin, JMASCos } from '../math.js';
import { World, NameRef, HitActor, TakeActor, LiveActor, SpineEnemy, EnemyManager, LiveManager, LF, HF, HC, MSG, nerve, Spine, Stream, Params, PSchema, SPINE_PARAMS,
    ANM_BCK, ANM_BTP, ANM_BRK, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, PathNode, GraphWeb } from '../engine.js';
import { AT } from '../actortypes.js';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { ObjCollisionManager } from '../mapobj/objcol.js';
import { mapObjGlobals } from '../mapobj/base.js';
import type { ItemManager } from '../mapobj/item.js';
import type { BGCheckData } from '../collision.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';
import { mat4 } from 'gl-matrix';
import { fmadd as FMA } from '../player/fmath.js';
import { msVecNormalize } from '../camera/lib.js';
import { matan, s16 } from '../math.js';
import { vNorm, vMag, vSq, vDot, vCross, msVecMag2 } from '../vecops.js';

/** TBWParams */
const BW_PARAMS = {
    mSLMarchSpeed: ['f', 6], mSLTurnSpeed: ['f', 1], mSLLeashNodeLen: ['f', 120], mSLPicketHeight: ['f', 100], mSLPicketRadius: ['f', 100],
    mSLChainHitHeight: ['f', 100], mSLChainHitRadius: ['f', 100], mSLChainGroundRadius: ['f', 60], mSLPullLimit: ['f', 1], mSLAttackSpeed: ['f', 10],
    mSLStunTimer: ['i', 4000], mSLSearchLength: ['f', 10000], mSLSearchAngle: ['f', 60], mSLBWHitPointMax: ['u8', 255], mSLHeadGap: ['f', 150],
    mSLShakeLengthMax: ['f', 3000], mSLShakeLengthMaxHP0: ['f', 2000],
} satisfies PSchema;

export const BW_BATH_POS = new V3(-1000, 4.5, -6217.2), BW_PICKET_START = new V3(6012.84, 0, 7323.15), BW_HEAD_START = new V3(5741.72, -100, 6311.62);
const EPS = fr(3.814697265625e-6);
const velocityMinY = -40;
// The vector maths as the game compiles it (all singles): TVec3::dot / squared as fmuls then
// fmadds (or fadds), cross as fmuls then fmsubs, VECNormalize / VECMag the SDK's paired-single
// PSVECNormalize / PSVECMag (frsqrte and a Newton step), MsVECNormalize / MsVECMag2 the raw estimate.
/** fromPolar: (r sin t, 0, r cos t), t in degrees: fmuls by 182.04445 and fctiwz into the sin table */
const fromPolar = (t: number, r: number) => { const a = Math.trunc(fr(fr(182.04444885253906) * t)); return new V3(fr(r * JMASSin(a)), 0, fr(r * JMASCos(a))); };
const norm = vNorm, mag = vMag, sq3 = vSq, dot = vDot, cross = vCross;
const isEnemyThrough = (d: BGCheckData) => d.bgType === 0x801 || d.bgType === 0x402;
/** MsPerpendicFootToLineR (0x801e77e8): the point of the segment a-b nearest p (no zero-length check) */
function perpendicFoot(a: V3, b: V3, p: V3) {
    const d = V3.sub(b, a);
    const ad = FMA(a.z, d.z, FMA(a.x, d.x, fr(a.y * d.y)));
    const sq = FMA(d.z, d.z, FMA(d.x, d.x, fr(d.y * d.y)));
    const pd = FMA(p.z, d.z, FMA(p.x, d.x, fr(p.y * d.y)));
    let t = fr(fr(pd - ad) / sq);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return new V3(fr(fr(d.x * t) + a.x), fr(fr(d.y * t) + a.y), fr(fr(d.z * t) + a.z));
}

// BCKs / BTPs / BRKs (/scene/bwanwan, in the folder's order: bwanwan_bastable)
const BCK_BARK = 0, BCK_DOWN = 1, BCK_SHAKE = 2, BCK_SLEEP = 3, BCK_WAIT = 4, BCK_WAIT2 = 5, BCK_WAKEUP = 6;
const BTP_TDOWN = 0, BTP_TWAKEUP = 2;
const BRK_BODY = 0, BRK_BODY_GOLD = 1, BRK_CHAIN = 2;
void BCK_SLEEP;

/** TRope (MarioUtil/MtxUtil.cpp) */
interface RopePoint { prev: V3; pos: V3; vel: V3; len: number; flags: number; }
export class Rope {
    pts: RopePoint[] = [];
    constructor(public w: World, n: number, p: V3, len: number, public radius: number, public damp: number, public grav: number) {
        for (let i = 0; i < n; i++) this.pts.push({ prev: p.clone(), pos: p.clone(), vel: new V3(), len, flags: 0 });
    }
    get num() { return this.pts.length; }
    collision() {
        const w = this.w, r = this.radius;
        for (const pt of this.pts) {
            if (pt.flags & 1) continue;
            const p = pt.pos;
            const [ry, rd] = w.checkRoof(p.x, p.y + r, p.z);
            if (rd && !rd.isIllegal() && p.y + r > ry) p.y = fr(ry - 2 * r);
            let [gy, gd] = w.checkGround(p.x, p.y + r, p.z);
            gy = fr(gy + 3);
            if (!gd.isIllegal() && p.y < gy) p.y = gy;
            w.isTouchedOneWallAndMoveXZ(p, p.y, r);
        }
    }
    constraintHead(h: V3) {
        this.pts[0].pos.set(h);
        for (let i = 0; i < this.num - 1; i++) {
            const c = this.pts[i], n = this.pts[i + 1];
            const d = V3.sub(n.pos, c.pos);
            if (sq3(d) <= EPS) d.set(0, 1, 0);
            norm(d).scale(c.len);
            n.pos.set(c.pos).add(d).fround();
        }
        this.collision();
    }
    constraintTail(t: V3) {
        this.pts[this.num - 1].pos.set(t);
        for (let i = this.num - 1; i > 0; --i) {
            const c = this.pts[i], p = this.pts[i - 1];
            const near = (a: number, b: number) => { const t = fr(a - b); return -EPS <= t && t <= EPS; };
            const same = near(p.pos.x, c.pos.x) && near(p.pos.y, c.pos.y) && near(p.pos.z, c.pos.z);
            if (!same) {
                const d = norm(V3.sub(p.pos, c.pos)).scale(c.len);
                p.pos.set(c.pos).add(d).fround();
            }
        }
        this.collision();
    }
    moveHead(h: V3) {
        for (const p of this.pts) { p.pos.y = fr(p.pos.y + this.grav); p.pos.add(p.vel).fround(); }
        this.constraintHead(h);
        for (const p of this.pts) { p.vel.set(V3.sub(p.pos, p.prev).scale(this.damp)).fround(); p.prev.set(p.pos); }
    }
}

/** A model the boss carries that the viewer draws (a chain link, the picket): world.extras. */
class BWModel extends LiveActor {
    constructor(public owner: BossWanwan, file: string, public visible: () => boolean) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    perform() { }
    drawn() { return this.visible(); }
}

/** TBWLeashNode (鎖部品): one link of the chain. */
export class BWLeashNode extends HitActor {
    model: BWModel;
    temperature = 0;
    constructor(public leash: BWLeash, public index: number, name = '鎖部品') {
        super(name);
        const o = leash.owner;
        this.model = new BWModel(o, 'bwanwan_chain.bmd', () => !o.checkLiveFlag(LF.DEAD) && o.unk18C === 0 && this.index < this.leash.rope.num - 1);
        this.model.mactor!.setFromIndex(ANM_BRK, BRK_CHAIN);
        o.world.extras.push(this.model);
        const P = o.PB;
        this.initHitActor(AT.BOSS_UNKC, 1, HC.PLAYER, 1.2 * P.mSLChainHitRadius, 1.2 * P.mSLChainHitHeight, P.mSLChainHitRadius, P.mSLChainHitHeight);
    }
    calcTemperature() {
        if (this.index === 0) return;
        const d = fr(this.leash.nodes[this.index - 1].temperature - this.temperature);
        const step = d < 0 ? (d < fr(-0.1) ? fr(-0.02) : fr(-0.005)) : (d > fr(0.1) ? fr(0.02) : fr(0.005));
        let t = fr(this.temperature + step);
        if (t < 0) t = 0; if (t > 1) t = 1;
        this.temperature = t;
    }
    calcMatrix() {
        const r = this.leash.rope, m = this.model.baseTR;
        const p = r.pts[this.index].pos.clone();
        const front = this.index < r.num - 1 ? V3.sub(r.pts[this.index + 1].pos, p) : V3.sub(r.pts[this.index - 1].pos, p).scale(-1);
        norm(front);
        let up = new V3(0, 1, 0);
        const side = norm(cross(new V3(), up, front));
        up = norm(cross(new V3(), front, side));
        m[2] = front.x; m[6] = front.y; m[10] = front.z;
        // (every other link turned by 90 degrees)
        const [a, b] = this.index & 1 ? [side, up] : [up, side];
        m[0] = a.x; m[4] = a.y; m[8] = a.z; m[1] = b.x; m[5] = b.y; m[9] = b.z;
        m[3] = p.x; m[7] = fr(p.y + 30); m[11] = p.z;
        this.pos.set(p);
        this.model.pos.set(p);
    }
    perform(cue: number) {
        const o = this.leash.owner;
        if (cue & CUE_MOVE) {
            this.calcTemperature();
            this.calcMatrix();
            if (o.hitPoints !== 0 && this.index < 8) for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) c.receiveMessage(this, MSG.BURN);
        }
        const a = this.model.mactor!;
        if (cue & CUE_CALC_ANIM) {
            const c = a.getFrameCtrl(ANM_BRK);
            if (c) {
                let f = fr(this.temperature * (c.end - 1));
                const n = this.leash.rope.num;
                let heat: number;
                if (this.index < 5) heat = FMA(this.index, 0.25, fr(o.hitPoints / o.PB.mSLBWHitPointMax));
                else if (this.index >= n - 10) heat = fr((n - this.index) / 10);
                else heat = 1;
                if (heat > 1) heat = 1; else if (heat < 0) heat = 0;
                f = fr(f * heat);
                c.frame = f; c.rate = 0;
            }
        }
        if (this.index < this.leash.rope.num - 1 && (cue & CUE_CALC_ANIM)) a.frameUpdate();
    }
}

/** TBWLeash (ボスワンワン鎖): the chain. */
export class BWLeash extends NameRef {
    rope: Rope;
    nodes: BWLeashNode[] = [];
    constructor(public owner: BossWanwan, n: number, name = 'ボスワンワン鎖') {
        super(name);
        const P = owner.PB;
        this.rope = new Rope(owner.world, n, owner.pos, P.mSLLeashNodeLen, P.mSLChainGroundRadius, 0.7, -2);
        for (let i = 0; i < n; i++) this.nodes.push(new BWLeashNode(this, i));
        for (let i = 0; i < n; i++) {
            owner.world.addToGroup('敵グループ', this.nodes[i]);
            // (the last two links, by the picket, never collide)
            if (i < n - 2) this.nodes[i].offHitFilter(HF.NO_COLLISION); else this.nodes[i].onHitFilter(HF.NO_COLLISION);
            if (i < 2) this.rope.pts[i].flags |= 1; else this.rope.pts[i].flags &= ~1;
        }
    }
    invalidateAllCollision() { for (const n of this.nodes) n.onHitFilter(HF.NO_COLLISION); }
    pullTail(t: V3) {
        const h = this.rope.pts[0].pos.clone();
        this.rope.constraintTail(t);
        this.owner.unk15C.set(V3.sub(this.rope.pts[0].pos, h)).fround();
    }
    perform(cue: number) {
        const o = this.owner;
        if (cue & CUE_MOVE) {
            this.rope.moveHead(o.getJointTrans(5));
            o.unk188 = 0;
            if (o.unk17C !== 0) {
                this.pullTail(o.picket!.pos);
                const toHead = V3.sub(this.rope.pts[0].pos, new V3(o.pos.x, fr(o.pos.y + 500), o.pos.z));
                if (mag(toHead) > 650) {
                    norm(toHead).scale(20); toHead.y = 0;
                    o.pos.add(toHead).fround();
                    o.unk188 = 1;
                }
                const target = MsWrap(fr(MsGetRotFromZaxisY(toHead) + 180), 0, 360);
                const d = MsAngleDiff(target, o.rot.y);
                const t = d > 0 ? Math.min(d, 1.5 * o.turnSpeed) : Math.max(d, 1.5 * -o.turnSpeed);
                o.rot.y = MsWrap(fr(o.rot.y + t), 0, 360);
            }
        }
        if (cue & CUE_CALC_ANIM) {
            const c = o.getJointTrans(1);
            for (let i = 0; i < 15 && i < this.rope.num; ++i) {
                const p = this.rope.pts[i];
                const d = V3.sub(p.pos, c);
                const l = mag(d);
                if (l < 500) {
                    d.scale(fr(500 / l)).add(c);
                    p.vel.zero(); p.pos.set(d).fround(); p.prev.set(p.pos);
                }
            }
        }
        for (const n of this.nodes) n.testPerform(cue);
    }
}

/** TBWPicket (ボスワンワンつかみ): the stake, which Mario can pull out and carry. */
export class BWPicket extends TakeActor {
    takingMtx: Mtx = mtx();
    model: BWModel;
    constructor(public owner: BossWanwan, name = 'ボスワンワンつかみ') {
        super(name);
        const P = owner.PB;
        this.initHitActor(AT.BOSS_UNKD, 1, HC.PLAYER, P.mSLPicketRadius, P.mSLPicketHeight, P.mSLPicketRadius, P.mSLPicketHeight);
        owner.world.addToGroup('敵グループ', this);
        this.offHitFilter(HF.NO_COLLISION);
        this.model = new BWModel(owner, 'bwanwan_picket.bmd', () => !owner.checkLiveFlag(LF.DEAD) && owner.unk18C === 0);
        owner.world.extras.push(this.model);
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (sender.isActorType(AT.MARIO)) {
            if (msg === MSG.HIP_DROP) {
                // (ground pounding it stakes it back in)
                this.owner.unk17C = 1; this.owner.unk184 = 0;
                this.owner.world.sound(SE.BS_WANWAN_LOCK, this.pos);
                return true;
            }
            if (msg === MSG.TAKE) { this.owner.releasePicket(); this.holder = sender as TakeActor; return true; }
            if (msg === MSG.THROWN || msg === MSG.DETACH) { this.holder = null; return true; }
        }
        return false;
    }
    moveRequest(p: V3) {
        const o = this.owner, n = o.spine!.getLatestNerve();
        if (n === BWNerves.jumpToBath || n === BWNerves.die) return false;
        if (o.hitPoints !== 0) return false;
        o.leash!.pullTail(p);
        return true;
    }
    getTakingMtx() { return this.takingMtx; }
    isTaken() { return !!this.holder; }
    private static frame(m: Mtx, front: V3, p: V3) {
        let up = new V3(0, 1, 0);
        const side = norm(cross(new V3(), up, front));
        up = norm(cross(new V3(), front, side));
        cross(front, side, up); norm(front);
        m[0] = side.x; m[4] = side.y; m[8] = side.z; m[1] = up.x; m[5] = up.y; m[9] = up.z; m[2] = front.x; m[6] = front.y; m[10] = front.z;
        m[3] = p.x; m[7] = p.y; m[11] = p.z;
        return front;
    }
    perform(cue: number) {
        const o = this.owner, r = o.leash!.rope;
        if (cue & CUE_MOVE) {
            this.pos.set(r.pts[r.num - 1].pos);
            this.ensureTakeSituation();
            if (this.holder) {
                BWPicket.frame(this.takingMtx, V3.sub(this.holder.pos, r.pts[0].pos), this.pos);
                const h = this.holder as any;
                if (h.moveRequest) h.moveRequest(this.pos);
            }
        }
        if (cue & CUE_CALC_ANIM) {
            const m = this.model.baseTR;
            m.set(mtx());
            const front = V3.sub(this.pos, r.pts[r.num - 3].pos);
            if (sq3(front) <= EPS) front.set(0, 0, 1);
            const f = BWPicket.frame(m, front, this.pos);
            if (o.unk17C === 0) m[7] = fr(m[7] + 70);
            const k = this.isTaken() ? 50 : 60;
            m[3] = fr(m[3] - fr(k * f.x)); m[11] = fr(m[11] - fr(k * f.z));
            this.model.pos.set(m[3], m[7], m[11]);
            this.model.mactor!.frameUpdate();
        }
    }
}

/** TBWHit (ボスワンワンヒット): the ball's hit volumes (on joint 3, and 500 below it). */
export class BWHit extends HitActor {
    constructor(public owner: BossWanwan, public joint: number, name = 'ボスワンワンヒット') { super(name); }
    receiveMessage(sender: HitActor, msg: number) { return this.owner.receiveMessage(sender, msg); }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            if (this.joint >= 0) this.pos.set(this.owner.getJointTrans(this.joint));
            for (const c of this.collisions.slice()) if (this.owner.hitPoints !== 0 && c.isActorType(AT.MARIO)) c.receiveMessage(this.owner, MSG.BURN);
        }
    }
}

/** TBWBinder */
export class BWBinder {
    bind(a: LiveActor) {
        const bw = a as BossWanwan, w = bw.world;
        let delta = bw.posDelta.clone();
        const next = V3.add(bw.pos, delta);
        if (bw.isAirborne()) {
            const v = bw.vel.clone();
            next.add(v);
            v.y = fr(v.y - bw.getGravityY());
            if (v.y < velocityMinY) v.y = velocityMinY;
            bw.vel.set(v);
        }
        next.fround();
        if (bw.spine!.isNerve(BWNerves.jumpToBath) || bw.spine!.isNerve(BWNerves.die)) { bw.posDelta.set(V3.sub(next, bw.pos)); return; }
        if (bw.isAirborne()) {
            let [gy, g] = w.checkGround(next.x, next.y + bw.getHeadHeight(), next.z);
            gy = fr(gy + 1);
            if (bw.pos.y > next.y && !isEnemyThrough(g)) {
                let [gy2, g2] = w.checkGround(next.x, bw.pos.y + bw.getHeadHeight(), next.z);
                gy2 = fr(gy2 + 1);
                if (gy2 > gy) { gy = gy2; g = g2; }
            }
            if (next.y <= gy && !(g.flags & 0x10) && !isEnemyThrough(g)) {
                next.y = gy;
                bw.vel.zero();
                bw.offLiveFlag(LF.AIRBORNE); bw.offLiveFlag(LF.UNK8000);
            } else bw.onLiveFlag(LF.AIRBORNE);
            bw.groundHeight = gy; bw.groundPlane = g;
        }
        delta = V3.sub(next, bw.pos);
        const t = bw.tracer, G = t.graph;
        // (only along the current graph link)
        if (!bw.isAirborne() && G && t.cur >= 0 && t.prev >= 0 && t.cur !== t.prev) {
            const a2 = norm(V3.sub(G.point(t.cur), G.point(t.prev)));
            const sq = sq3(a2);
            const len = sq === 0 ? 0 : fr(dot(delta, a2) / sq);
            let speed = len;
            if (len < 0) { if (len > -3) speed = -3; }
            else if (len > 0 && len < 3) speed = 3;
            delta = a2.scale(speed).fround();
        }
        // (the ball rolls by the distance it moved)
        if (!bw.isAirborne()) {
            const dist = mag(delta);
            if (dist !== 0) {
                let roll = fr(360 * fr(dist / fr(3141.5927)));
                if (dot(fromPolar(bw.rot.y, 1), delta) < 0) roll = -roll;
                roll = fr(roll * 2);
                if (bw.unk16C !== 0) bw.unk168 = MsWrap(fr(roll + bw.unk168), 0, 360);
                else {
                    let ang = bw.unk168;
                    if (ang !== 0) { ang = fr(ang + roll); if (ang > 360) ang = 0; bw.unk168 = ang; }
                }
            }
        }
        // (staked: never further than the chain allows)
        if (bw.unk17C !== 0) {
            const anchor = bw.leash!.rope.pts[3].pos;
            const np = V3.add(bw.pos, delta).sub(anchor);
            if (mag(np) > 860) { norm(np).scale(860).add(anchor).sub(bw.pos); delta = np.fround(); }
        }
        // (pulled back onto the link)
        if (!bw.isAirborne() && G && t.cur >= 0 && t.prev >= 0) {
            const a2 = G.point(t.cur), b = G.point(t.prev);
            const foot = perpendicFoot(b, a2, bw.pos).sub(bw.pos);
            let d = mag(foot);
            if (d > 10) d = 10;
            if (d < fr(0.0001)) foot.zero(); else norm(foot).scale(d);
            delta.add(foot);
        }
        bw.posDelta.set(delta).fround();
    }
}

export class BossWanwanManager extends EnemyManager {
    constructor(w: World, name = 'ボスワンワンマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = new Params('/enemy/bosswanwan.prm', this.world.files).read({ ...SPINE_PARAMS, ...BW_PARAMS });
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['bwanwan_body.bmd', 'bwanwan_chain.bmd', 'bwanwan_picket.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new BossWanwan(this.world, 'ボスワンワン'); }
}

export class BossWanwan extends SpineEnemy {
    leash: BWLeash | null = null;
    picket: BWPicket | null = null;
    /** the pull the chain gave the head this tick */
    unk15C = new V3();
    /** the ball's roll (joint 1, degrees), and whether it rolls freely (TNerveBWRoll) */
    unk168 = 0; unk16C = 0;
    hits: BWHit[] = [];
    /** the motion blend's speed (10 / the BCK's length a tick) */
    unk178 = 0;
    /** staked (1: the picket is in the ground) */
    unk17C = 0;
    /** cold ticks (barks at 2400), staked-while-hot ticks (shakes the stake out at 600) */
    unk180 = 0; unk184 = 0;
    /** the chain dragged it this tick */
    unk188 = 0;
    /** in the bath; the Shine has appeared */
    unk18C = 0; unk18D = 0;
    /** water hits since the last effect */
    unk190 = 0;
    /** never released yet (1); the splash made */
    unk194 = 1; unk195 = 0;
    /** the balloons shown (bit per message from 0xE001A) */
    unk198 = 0;
    /** ticks since the picket was first released */
    unk19C = 0;
    /** a barrel has hit it */
    unk1A0 = 0;
    unk1A4 = new V3();
    colManager: ObjCollisionManager | null = null;
    /** TBossWanwanMtxCalc (M3UMtxCalcSIAnmBlendQuat): the BCKs it blends between and how far */
    mc = { newIdx: -1, oldIdx: -1, oldFrame: 0, ratio: 0 };
    joints: mat4[] | null = null;
    /** each joint's matrix in its parent's, as the calc leaves them (the viewer draws these) */
    locals: mat4[] = [];
    get PB(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ボスワンワン') {
        super(w, name);
        this.binder = new BWBinder();
    }
    /** the heat, 0..1 (the colour: the body's BRK frame) */
    heat() { return this.hitPoints / this.PB.mSLBWHitPointMax; }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('bwanwan_body.bmd');
        const g = this.world.graphByName('bwanwan');
        g.initGoalIndex(BW_BATH_POS);
        this.tracer.init(g);
        this.spine!.initWith(BWNerves.graphWander);
        const P = this.PB;
        this.marchSpeed = P.mSLMarchSpeed; this.turnSpeed = P.mSLTurnSpeed;
        this.pos.set(BW_HEAD_START);
        // (the viewer's stand-in sits here too: the drawables match the two by this place)
        this.loadPos = BW_HEAD_START.clone();
        this.reset();
        this.calcRootMatrix();
        this.calcJoints();
        this.leash = new BWLeash(this, 15);
        this.picket = new BWPicket(this);
        this.picket.pos.set(BW_PICKET_START);
        this.unk17C = 1; this.unk184 = 0;
        this.goToRandomNextGraphNode();
        this.initHitActor(AT.BOSS_UNKB, 1, HC.PLAYER, 0, 0, 0, 0);
        this.hits = [new BWHit(this, 3), new BWHit(this, -1)];
        this.hits[0].initHitActor(AT.BOSS_UNKB, 3, HC.PLAYER | HC.ITEM, 500, 500, 450, 500);
        this.hits[1].initHitActor(AT.BOSS_UNKB, 3, HC.PLAYER | HC.ITEM, 300, 500, 270, 500);
        for (const h of this.hits) { this.world.addToGroup('敵グループ', h); h.offHitFilter(HF.NO_COLLISION); }
        this.scaledBodyRadius = 500;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.changeBck(BCK_WAIT);
        this.mactor!.setFromIndex(ANM_BRK, BRK_BODY);
        this.hitPoints = P.mSLBWHitPointMax;
        this.unk15C.zero();
        this.colManager = new ObjCollisionManager(this.world, 1, '/scene/bwanwan', this);
        this.colManager.init('bwanwan_ofuro_col.col', 2, null);
        this.colManager.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
        this.colManager.removeActiveCollision();
        this.mapCollision = this.colManager;
        this.calcJoints();
    }
    /** getJointTransByIndex: joint i's place as the last calc left it */
    getJointTrans(i: number) {
        const m = this.joints && this.joints[i];
        return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone();
    }
    /** MActor::calc with TBossWanwanMtxCalc */
    calcJoints() {
        const a = this.mactor;
        if (!a) return;
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const mc = this.mc, fc = a.getFrameCtrl(ANM_BCK);
        const nw = mc.newIdx >= 0 ? { anm: bck(mc.newIdx), frame: fc ? fc.frame : 0 } : null;
        const old = mc.oldIdx >= 0 ? { anm: bck(mc.oldIdx), frame: mc.oldFrame } : null;
        const B = this.baseTR;
        const air = this.isAirborne();
        const rx = mtx();
        {
            const s = MsSin(this.unk168), c = MsCos(this.unk168);
            rx[5] = c; rx[6] = -s; rx[9] = s; rx[10] = c;
        }
        const rot = mat4.fromValues(rx[0], rx[4], rx[8], 0, rx[1], rx[5], rx[9], 0, rx[2], rx[6], rx[10], 0, 0, 0, 0, 1);
        this.joints = jointMatricesBlend(sk, nw, old, mc.ratio, false, B, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals, (j, m) => {
            // (airborne, the root joint drops the animation's translation)
            if (j === 0 && air) { m[12] = B[3]; m[13] = B[7]; m[14] = B[11]; }
            // (the ball rolled by unk168: MTXConcat(anmMtx, RotX))
            if (j === 1) mat4.mul(m, m, rot);
        }, null, air ? (j) => j === 0 : null);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.MARIO)) return false;
        if (sender.isActorType(AT.WATER)) {
            if (this.unk18C !== 0) return true;
            this.world.effect('enemyWaterHit', sender.pos);
            if (this.hitPoints === 0) this.world.sound(SE.BS_WANWAN_COOL_MORE, this.pos);
            else if (this.hitPoints === 1) { this.world.effect('bwan:downyuge', this.getJointTrans(1)); this.world.sound(SE.BS_WANWAN_TO_COOL, this.pos); }
            else this.world.sound(SE.BS_WANWAN_COOL, this.pos);
            this.decHitPoints();
            this.unk190 += 1;
            return true;
        }
        if (sender.isActorType(AT.WOOD_BARREL)) {
            // (a barrel full of water cools it at once)
            sender.receiveMessage(this, MSG.HIP_DROP);
            this.hitPoints = 0;
            this.unk190 += 1;
            if (this.unk1A0 === 0) this.unk1A0 += 1;
            this.world.effect('bwan:downyuge', this.getJointTrans(1));
            this.world.sound(SE.BS_WANWAN_TO_COOL, this.pos);
        }
        return super.receiveMessage(sender, msg);
    }
    kill() { }
    takeBath() {
        this.unk16C = 0; this.unk168 = 0; this.unk18C = 1;
        this.pos.set(BW_BATH_POS);
        const p = this.pos.clone(); p.y = fr(p.y + 500);
        const s = this.scale.clone().scale(1.1);
        this.colManager!.setUpActiveCollisionTRS(p, this.rot, s);
        this.hits[0].onHitFilter(HF.NO_COLLISION); this.hits[1].onHitFilter(HF.NO_COLLISION);
        this.leash!.invalidateAllCollision();
        this.picket!.onHitFilter(HF.NO_COLLISION);
    }
    releasePicket() {
        if (this.unk17C !== 0) this.world.effect('bwan:jumpSmoke', this.picket!.pos, new V3(0.3, 0.5, 0.3));
        this.unk194 = 0; this.unk17C = 0;
    }
    changeBck(i: number) {
        const a = this.mactor!;
        const c0 = a.getFrameCtrl(ANM_BCK);
        const mc = this.mc;
        // (M3UMtxCalcSIAnmBlendQuat::joinAnm: nothing when it is the anm already, else the old one kept and the blend restarted)
        if (mc.newIdx !== i) { mc.oldIdx = mc.newIdx; mc.oldFrame = c0 ? c0.frame : 0; mc.newIdx = i; mc.ratio = 1; }
        a.setBckFromIndex(i);
        const c = a.getFrameCtrl(ANM_BCK);
        this.unk178 = c && c.end ? fr(10 / c.end) : 1;
    }
    isHeadPulled() { return !(sq3(this.unk15C) < this.PB.mSLPullLimit); }
    isBurning() { return this.hitPoints !== 0; }
    calcRootMatrix() { MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y + 500), this.pos.z, this.rot.x, this.rot.y, this.rot.z); }
    reverseNextGraphNode() {
        const t = this.tracer, g = t.graph!;
        const ahead = t.prev, cur = t.cur;
        const toMario = V3.sub(this.world.mario.pos, this.pos);
        t.prev = g.getAimToDirNextIndex(ahead, cur, toMario, this.pos, -1);
        t.cur = ahead;
        this.setGoalPathFromGraph();
        this.unk128 = 0; this.unk12C = 0;
    }
    rollNextGraphNode() {
        const t = this.tracer, g = t.graph!;
        const prev = t.prev, cur = t.cur;
        if (prev >= 0 && g.nodes[prev].conns.length >= 2 && this.world.moveTickCount >= 14400) this.showMessage(0xE001C);
        t.moveTo(getEscapeDirLimited(g, cur, prev, fromPolar(this.rot.y, 1), this.pos, this.world.mario.pos, 100));
        this.setGoalPathFromGraph();
        this.unk128 = 0; this.unk12C = 0;
    }
    slideToCurPathNode(speed: number, turn: number) {
        const to = V3.sub(this.goal.point(), this.pos);
        const dist = mag(to);
        const target = MsWrap(MsGetRotFromZaxisY(to), 0, 360);
        const d = MsAngleDiff(target, this.rot.y);
        const t = d > 0 ? Math.min(d, turn) : Math.max(d, -turn);
        this.rot.y = MsWrap(fr(this.rot.y + t), 0, 360);
        if (dist > 0) to.scale(fr(speed / dist));
        this.posDelta.add(to).fround();
    }
    control() {
        if (this.spine) this.spine.update();
        if (this.unk17C !== 0 || (this.picket!.isTaken() && this.isHeadPulled())) {
            // (pulled by the chain: it goes with it and looks away from it)
            this.posDelta.add(this.unk15C).fround();
            const away = V3.sub(this.pos, this.leash!.rope.pts[3].pos);
            const target = MsWrap(MsGetRotFromZaxisY(away), 0, 360);
            const d = MsAngleDiff(target, this.rot.y);
            const t = d > 0 ? Math.min(d, 4 * this.turnSpeed) : Math.max(d, 4 * -this.turnSpeed);
            this.rot.y = MsWrap(fr(this.rot.y + t), 0, 360);
        }
        this.unk15C.zero();
        this.updateSquareToMario();
    }
    emitEffects() {
        const a = this.mactor!, W = this.world;
        const pass = (f: number) => a.checkBckPass(f);
        const b4or5 = a.checkCurBckFromIndex(BCK_WAIT) || a.checkCurBckFromIndex(BCK_WAIT2);
        let landed = false;
        if (b4or5) { if (pass(8)) landed = true; }
        else if (a.checkCurBckFromIndex(BCK_SHAKE) && pass(38)) landed = true;
        if (landed) {
            W.effect('bwan:jumpRock', this.pos); W.effect('bwan:jumpSmoke', this.pos);
            const r = this.leash!.rope;
            if (this.hitPoints === 0) { W.sound(SE.M_BOSW_CHAIN_CAL_F, r.pts[0].pos); W.sound(SE.M_BOSW_CHAIN_CAL_R, this.picket!.pos); }
            else { W.sound(SE.M_BOSW_CHAIN_ANG_F, r.pts[0].pos); W.sound(SE.M_BOSW_CHAIN_ANG_R, this.picket!.pos); }
        }
        let sparks = false;
        if (a.checkCurBckFromIndex(BCK_BARK)) { if (pass(72)) sparks = true; }
        else if (b4or5) { if (pass(6) || pass(12)) sparks = true; }
        else if (a.checkCurBckFromIndex(BCK_SHAKE) && pass(4)) sparks = true;
        if (sparks) W.effect('bwan:hibana', this.getJointTrans(1));
        if (a.checkCurBckFromIndex(BCK_BARK)) {
            if (pass(60) || pass(127) || pass(202)) { W.effect('bwan:jumpRock', this.pos); W.effect('bwan:jumpSmoke', this.pos); }
        }
        if (this.hitPoints !== 0) W.effect('bwan:yugami', this.getJointTrans(1));
        if (this.unk190 !== 0 && this.hitPoints !== 0) { W.effect('bwan:hityuge', this.getJointTrans(1)); this.unk190 = 0; }
    }
    showMessage(msg: number) {
        const bit = 1 << (msg - 0xE001A);
        if (!(this.unk198 & bit)) this.world.effect('balloon:' + msg.toString(16), this.pos);
        this.unk198 |= bit;
    }
    perform(cue: number) {
        const P = this.PB;
        if (this.unk18C !== 0) {
            // (in the bath)
            this.hits[0].perform(cue);
            this.performBody(cue);
            if (cue & CUE_MOVE) this.mc.ratio = Math.min(1, Math.max(0, fr(this.mc.ratio - this.unk178)));
            // (cue 0x200: taken as once a frame)
            if (cue & CUE_CALC_ANIM) {
                const c = this.mactor!.getFrameCtrl(ANM_BRK);
                if (c && c.frame > 0.5 * c.end) { this.unk1A4.set(this.pos.x, fr(this.pos.y + 500), this.pos.z); this.world.effect('bwan:kira', this.unk1A4); }
            }
            return;
        }
        if (cue & CUE_CALC_ANIM) {
            const c = this.mactor!.getFrameCtrl(ANM_BRK);
            const heat = fr(this.hitPoints / P.mSLBWHitPointMax);
            if (c) { c.frame = fr(heat * (c.end - 1)); c.rate = 0; }
            if (this.hitPoints === 0 || this.hitPoints === P.mSLBWHitPointMax) this.leash!.nodes[0].temperature = heat;
            this.emitEffects();
        }
        this.hits[0].perform(cue);
        if (cue & CUE_MOVE) this.hits[1].pos.set(this.hits[0].pos.x, fr(this.hits[0].pos.y - 500), this.hits[0].pos.z);
        this.hits[1].perform(cue);
        if ((cue & CUE_MOVE) && this.unk194 === 0) {
            this.unk19C += 1;
            if (this.unk19C < 0) this.unk19C = 1;
            if (this.unk19C > 600) this.showMessage(0xE001A);
        }
        if ((cue & CUE_MOVE) && this.unk1A0 === 0 && this.world.moveTickCount >= 28800) this.showMessage(0xE001D);
        const s = this.spine!;
        if ((cue & CUE_MOVE) && !s.isNerve(BWNerves.die) && !s.isNerve(BWNerves.jumpToBath)) {
            if (this.hitPoints !== 0) {
                // (a hot chomp straining the stake 600 ticks pulls it out)
                if (this.unk17C !== 0 && this.unk194 === 0) {
                    this.unk184 += 1;
                    if (this.unk184 > 600) { s.pushNerve(BWNerves.shake); this.unk184 = 0; }
                }
            } else this.unk184 = 0;
            if (this.hitPoints === 0 && s.getLatestNerve() !== BWNerves.bark) {
                // (cold 2400 ticks: it barks itself hot)
                this.unk180 += 1;
                if (this.unk180 > 2400 && s.getLatestNerve() !== BWNerves.bark) s.setNext(BWNerves.bark);
            } else {
                // (a point of heat every 20 ticks)
                if (this.world.moveTickCount % 20 === 0 && this.hitPoints < P.mSLBWHitPointMax) this.hitPoints += 1;
                this.unk180 = 0;
            }
        }
        if ((cue & CUE_MOVE) && s.isNerve(BWNerves.graphWander) && this.picket!.isTaken()) this.world.sound(SE.BS_WANWAN_M_DRAG, this.leash!.rope.pts[6].pos);
        this.performBody(cue);
        this.leash!.testPerform(cue);
        this.picket!.testPerform(cue);
        if (cue & CUE_MOVE) this.mc.ratio = Math.min(1, Math.max(0, fr(this.mc.ratio - this.unk178)));
    }
    /** TSpineEnemy::perform, the model's calc (the joints) after the root matrix */
    private performBody(cue: number) {
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.DEAD)) this.calcJoints();
    }
}

/**
 * TGraphWeb::getEscapeDirLimited (0x8025f50c): among the links within limit degrees of dir (the
 * angle by matan of the dot and |cross|, MsVECMag2), the one leading most away from Mario (the
 * least dot with the way to him); if none is that close to dir, the least dot with the way to him
 * of all of them. The node points are the rail's s16s; the directions MsVECNormalize'd.
 */
function getEscapeDirLimited(g: GraphWeb, i: number, prev: number, dir: V3, pos: V3, mario: V3, limit: number) {
    const c = g.nodes[i].conns;
    if (c.length === 0) return i;
    if (c.length === 1) return c[0];
    if (c.length === 2 && prev >= 0) return c[0] !== prev ? c[0] : c[1];
    const d0 = msVecNormalize(dir.clone(), new V3()) as V3, m = msVecNormalize(V3.sub(mario, pos), new V3()) as V3;
    let r = -1, best = 0;
    for (const k of c) {
        if (k === prev) continue;
        const d = msVecNormalize(V3.sub(g.point(k), pos), new V3()) as V3;
        const cr = cross(new V3(), d0, d);
        const cs0 = dot(d0, d);
        const ang = Math.abs(fr(matan(cs0, msVecMag2(cr)) * fr(0.0054931640625)));
        if (ang < limit) {
            const cs = dot(d, m);
            if (r < 0 || cs < best) { r = k; best = cs; }
        }
    }
    if (r >= 0) return r;
    for (const k of c) {
        if (k === prev) continue;
        const cs = dot(msVecNormalize(V3.sub(g.point(k), pos), new V3()) as V3, m);
        if (r < 0 || cs < best) { best = cs; r = k; }
    }
    return r;
}

type S = Spine<BossWanwan>;
export const BWNerves: Record<string, any> = {};
const frameAt = (self: BossWanwan, f: number, rate: number) => { const c = self.mactor!.getFrameCtrl(ANM_BCK); if (c) { c.frame = f; c.rate = rate; } };
BWNerves.graphWander = nerve<BossWanwan>('TNerveBWGraphWander', (spine: S) => {
    const self = spine.body, a = self.mactor!, P = self.PB;
    if (spine.time === 0) {
        self.unk16C = 0;
        // (the second check was probably meant to be 5: the game's)
        if (!a.checkCurBckFromIndex(BCK_WAIT) && !a.checkCurBckFromIndex(BCK_WAIT)) {
            self.changeBck(self.hitPoints === 0 ? BCK_WAIT2 : BCK_WAIT);
            frameAt(self, 0, ANM_FRAME_RATE);
        }
        a.setFromIndex(ANM_BTP, BTP_TDOWN);
        const c = a.getFrameCtrl(ANM_BTP); if (c) { c.frame = 0; c.rate = 0; }
    }
    if (a.curAnmEndsNext(ANM_BCK) && self.hitPoints === 0 && !a.checkCurBckFromIndex(BCK_WAIT2)) { self.changeBck(BCK_WAIT2); frameAt(self, 0, ANM_FRAME_RATE); }
    if (self.unk17C === 0 && self.picket!.isTaken() && self.isHeadPulled()) {
        // (Mario drags it by the chain)
        const t = self.tracer, g = t.graph!;
        const ahead = t.prev;
        const toNode = V3.sub(g.point(ahead), self.pos);
        if (mag(toNode) < 400 && ahead === g.goalIdx) { spine.pushAfterCurrent(BWNerves.jumpToBath); return true; }
        if (mag(toNode) < 400) self.reverseNextGraphNode();
        const heat = fr(self.hitPoints / P.mSLBWHitPointMax);
        self.slideToCurPathNode(fr(3 * fr(heat * self.marchSpeed)), self.turnSpeed);
        return false;
    }
    if (self.isReachedToGoal()) {
        if (self.jumpToNextGraphNode() >= 0) { spine.pushAfterCurrent(BWNerves.graphWander); spine.pushAfterCurrent(BWNerves.jump); }
        else { spine.pushAfterCurrent(BWNerves.graphWander); self.rollNextGraphNode(); }
        return true;
    }
    self.unk16C = 0;
    const heat = fr(self.hitPoints / P.mSLBWHitPointMax);
    if (self.picket!.isTaken()) {
        // (Mario holding the picket holds it back by leaning away: gpMarioOriginal's stick, mIntendedYaw /
        // mIntendedMag; the ghost's MarioProxy has none: 0)
        const m = self.world.mario as any;
        const yaw = typeof m.mIntendedYaw === 'number' ? m.mIntendedYaw : 0, im = typeof m.mIntendedMag === 'number' ? m.mIntendedMag : 0;
        const stick = fromPolar(fr(s16(yaw) * fr(0.0054931640625)), 1);
        const from = norm(V3.sub(self.pos, self.world.mario.pos));
        // (mag / 32 in singles, times 0.75 as a double, then fmuls by the dot)
        const pull = fr((fr(im * fr(0.03125)) * 0.75) * -dot(from, stick));
        let rate = fr(1 - pull);
        if (rate < 0) rate = 0;
        if (1.5 < rate) rate = 1.5;
        self.slideToCurPathNode(fr(rate * fr(heat * self.marchSpeed)), self.turnSpeed);
    } else self.slideToCurPathNode(FMA(heat, self.marchSpeed, fr(0.2)), self.turnSpeed);
    return false;
});
BWNerves.roll = nerve<BossWanwan>('TNerveBWRoll', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { frameAt(self, 0, 0); self.unk16C = 1; }
    if (self.isReachedToGoal()) { spine.pushAfterCurrent(BWNerves.graphWander); const c = self.mactor!.getFrameCtrl(ANM_BCK); if (c) c.rate = ANM_FRAME_RATE; return true; }
    self.walkToCurPathNode(self.PB.mSLAttackSpeed, self.turnSpeed, 0);
    return false;
});
BWNerves.bark = nerve<BossWanwan>('TNerveBWBark', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(BCK_BARK);
        self.unk16C = 0; self.unk168 = 0;
        if (self.unk194 === 0) { self.releasePicket(); self.world.sound(SE.BS_WANWAN_ESCAPE1, self.picket!.pos); }
    }
    // (barking heats it up all the way)
    if (spine.time === 280) self.hitPoints = self.PB.mSLBWHitPointMax;
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BWNerves.graphWander); self.showMessage(0xE001B); return true; }
    return false;
});
BWNerves.jump = nerve<BossWanwan>('TNerveBWJump', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.vel.set(self.calcVelocityToJumpToY(self.goal104.point(), self.tracer.unkC, self.getGravityY()));
        self.onLiveFlag(LF.AIRBORNE);
        self.unk16C = 0;
    }
    if (self.isReachedToGoal()) { spine.pushAfterCurrent(BWNerves.graphWander); return true; }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
BWNerves.stun = nerve<BossWanwan>('TNerveBWStun', (spine: S) => {
    const self = spine.body;
    if (self.picket!.isTaken() && self.isHeadPulled()) {
        const t = self.tracer, g = t.graph!, ahead = t.prev;
        const toNode = V3.sub(g.point(ahead), self.pos);
        if (mag(toNode) < 100) {
            if (ahead === g.goalIdx) { spine.pushAfterCurrent(BWNerves.jumpToBath); return true; }
            self.reverseNextGraphNode();
        }
        return false;
    }
    if (spine.time > self.PB.mSLStunTimer) { self.hitPoints = self.PB.mSLBWHitPointMax; spine.pushAfterCurrent(BWNerves.wakeup); return true; }
    return false;
});
BWNerves.wakeup = nerve<BossWanwan>('TNerveBWWakeup', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(BCK_WAKEUP); self.mactor!.setFromIndex(ANM_BTP, BTP_TWAKEUP); self.unk16C = 0; self.unk168 = 0; }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BWNerves.graphWander); return true; }
    return false;
});
BWNerves.jumpToBath = nerve<BossWanwan>('TNerveBWJumpToBath', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const v = self.calcVelocityToJumpToY(BW_BATH_POS, 10, self.getGravityY());
        self.setGoalPath(new PathNode(null, BW_BATH_POS.clone()));
        self.vel.set(v);
        self.onLiveFlag(LF.AIRBORNE);
        self.unk16C = 0;
    }
    if (spine.time > 120 && self.unk195 === 0 && self.pos.y < 10 + BW_BATH_POS.y) {
        const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト水柱マネージャー', 1) as any;
        if (e && e.generate) { e.generate(new V3(self.pos.x, fr(500 + self.pos.y - 30), self.pos.z), new V3(5, 5, 5)); self.unk195 = 1; }
        self.world.sound(SE.BS_WANWAN_DIVE, self.pos);
    }
    const d = V3.sub(BW_BATH_POS, self.pos);
    if (sq3(d) < 10000 && self.pos.y <= BW_BATH_POS.y) { self.pos.set(BW_BATH_POS); spine.pushAfterCurrent(BWNerves.die); return true; }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
BWNerves.die = nerve<BossWanwan>('TNerveBWDie', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) {
        self.vel.zero(); self.posDelta.zero();
        self.onLiveFlag(LF.UNK10);
        self.offLiveFlag(LF.AIRBORNE);
        self.world.effect('bwan:deadyuge', self.pos);
    }
    // (cooled all the way first, a point a tick)
    if (self.hitPoints !== 0) {
        self.decHitPoints();
        frameAt(self, 0, 0);
        spine.pushAfterCurrent(BWNerves.die);
        return true;
    }
    if (spine.time === 0) {
        // (fireStartDemoCamera("bwanwan_down_camera"))
        self.world.effect('demo:bwanwan_down_camera', self.pos);
        self.takeBath();
        self.changeBck(BCK_DOWN);
        a.setFromIndex(ANM_BTP, BTP_TDOWN);
        a.setFromIndex(ANM_BRK, BRK_BODY_GOLD);
    }
    if (spine.time > 60 && self.unk18D === 0) {
        const im = mapObjGlobals(self.world).itemManager as ItemManager | null;
        if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', self.pos.x, self.pos.y, self.pos.z);
        self.unk18D = 1;
    }
    if (a.curAnmEndsNext(ANM_BRK)) { const c = a.getFrameCtrl(ANM_BRK); if (c) c.rate = 0; }
    return false;
});
BWNerves.jumpAway = nerve<BossWanwan>('TNerveBWJumpAway', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const v = self.calcVelocityToJumpToY(BW_HEAD_START, 40, self.getGravityY());
        self.setGoalPath(new PathNode(null, BW_HEAD_START.clone()));
        self.vel.set(v); self.onLiveFlag(LF.AIRBORNE); self.unk16C = 0;
    }
    if (self.unk188 !== 0) { spine.pushAfterCurrent(BWNerves.fall); return true; }
    if (self.isReachedToGoal()) {
        self.pos.set(BW_HEAD_START);
        self.tracer.reset(); self.tracer.reset2();
        self.goToShortestNextGraphNode();
        spine.pushAfterCurrent(BWNerves.graphWander);
        return true;
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
BWNerves.shake = nerve<BossWanwan>('TNerveBWShake', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK_SHAKE);
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { self.releasePicket(); self.world.sound(SE.BS_WANWAN_ESCAPE2, self.picket!.pos); return true; }
    return false;
});
BWNerves.fall = nerve<BossWanwan>('TNerveBWFall', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const v = self.calcVelocityToJumpToY(self.picket!.pos, 5, self.getGravityY());
        self.setGoalPath(new PathNode(null, self.picket!.pos.clone()));
        self.vel.set(v); self.onLiveFlag(LF.AIRBORNE); self.unk16C = 0;
    }
    if (self.isReachedToGoal()) {
        self.pos.set(self.picket!.pos);
        self.tracer.reset(); self.tracer.reset2();
        self.goToShortestNextGraphNode();
        spine.pushAfterCurrent(BWNerves.graphWander);
        return true;
    }
    return false;
});

register('BossWanwanManager', (w, n) => new BossWanwanManager(w, n));
register('BossWanwan', (w, n) => new BossWanwan(w, n));
