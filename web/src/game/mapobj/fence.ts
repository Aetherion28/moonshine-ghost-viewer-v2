// Fences (MoveBG/MapObjFence.cpp): the climbable fence (a super ground-pound shakes it), the
// revolving fence's frame and its panel that Mario flips over by ground-pounding (standing:
// it turns about Y, lying: it rolls), and the rail fence that slides along its rail when
// ground-pounded, stops at the rail's end and falls away to come back at its start.
// TFenceWater / TFenceWaterH (Pinna Park's spray-turned fences): sprayed, the fence turns 90
// degrees (the vertical one about Y, the lying one about Z, with its other collision while it
// moves), waits mTurnedWaitTime and turns back; a TMapObjMessenger 500 along its edge (the
// vertical one's) or under it (the lying one's) is what the water hits.

import { fr, V3, mtx, MsWrap, MsSin, MsCos } from '../math.js';
import { vNorm } from '../vecops.js';
import { World, Stream, HitActor, GraphTracer, MSG, HF, ANM_BCK } from '../engine.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, MOF, STATE_NORMAL, OBJ_MAKERS, newAndRegisterObj } from './base.js';
import { ObjCollisionManager } from './objcol.js';
import { MsMtxSetRotY, MTXConcat, setRootMtx, MapObjMessenger } from './lib.js';
import './item.js';   // (its OBJ_MAKERS.unique first: wrapped below)

export class Fence extends MapObjBase {
    /** bamboo */
    unk138 = 0;
    constructor(w: World, name = 'フェンス') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (msg === MSG.SUPER_HIP_DROP) { this.startBck('fence_normal_shake'); return true; }
        return false;
    }
    protected flat() { return Math.abs(this.rot.x) < 1 && Math.abs(this.rot.z) < 1; }
    initMapCollisionData() {
        const c = this.colMgr = new ObjCollisionManager(this.world, 1, 'mapObj', this);
        if (this.individualName !== 'fence3x3') c.init(this.flat() ? 'fence_normal_v_tool' : 'fence_h_tool', 0);
        else c.init(this.flat() ? 'fence_half_v_tool' : 'fence_half_h_tool', 0);
        this.mapCollision = c;
        c.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
    }
    initMapObj() {
        if (this.individualName.includes('bamboo')) this.unk138 = 1;
        super.initMapObj();
    }
}

export class RevolvingFenceOuter extends Fence {
    inner: MapObjBase | null = null;
    constructor(w: World, name = 'フェンス外側') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (msg === MSG.SUPER_HIP_DROP) {
            this.startBck('fence_revolve_outer_shake');
            if (this.inner) this.inner.startBck('fence_revolve_inner_shake');
            return true;
        }
        return false;
    }
    initMapCollisionData() {
        const c = this.colMgr = new ObjCollisionManager(this.world, 1, 'mapObj', this);
        c.init(this.flat() ? 'fence_revolve_outer_v_tool' : 'fence_revolve_outer_h_tool', 0);
        this.mapCollision = c;
        c.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
        this.inner = newAndRegisterObj(this.world, this.unk138 ? 'bambooFence_revolve_inner' : 'fence_revolve_inner', this.pos, this.rot);
        if (this.inner) this.inner.appear();
    }
}

export const RF = { UNK2: 2, UNK3: 3, UNK4: 4, UNK5: 5, UNK6: 6 };
export class RevolvingFenceInner extends Fence {
    static mSpeed = 4;
    unk13C = 0;
    /** standing (turns about Y) rather than lying (rolls by its BCKs) */
    unk140 = 1;
    constructor(w: World, name = 'フェンス内側') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (msg === MSG.SUPER_HIP_DROP && !this.unk140) {
            if (this.isState(STATE_NORMAL)) {
                this.world.sound(SE.OBJ_FENCE_REVERSE1, this.pos);
                this.state = RF.UNK3; this.startBck('fence_revolve_inner_roll_down'); this.offMapObjFlag(MOF.NO_ANIMATIONS);
                return true;
            } else if (this.isState(RF.UNK2)) {
                this.world.sound(SE.OBJ_FENCE_REVERSE2, this.pos);
                this.state = RF.UNK4; this.startBck('fence_revolve_inner_roll_up'); this.offMapObjFlag(MOF.NO_ANIMATIONS);
                return true;
            }
        }
        if (msg === MSG.SUPER_HIP_DROP && this.unk140) {
            // getRotYFromAxisZ: atan2f(dz, dx) (radians)
            const m = this.world.mario.pos;
            let a = fr(fr(180 * fr(fr(Math.atan2(m.z - this.pos.z, m.x - this.pos.x)) / fr(3.14))) + this.initialRot.y);
            a = MsWrap(a, -180, 180);
            if ((-180 < a && a < -90) || (0 < a && a < 90)) {
                this.world.sound(SE.OBJ_FENCE_REVERSE1, this.pos);
                this.state = this.isState(STATE_NORMAL) ? RF.UNK3 : RF.UNK4;
            } else {
                this.world.sound(SE.OBJ_FENCE_REVERSE2, this.pos);
                this.state = this.isState(STATE_NORMAL) ? RF.UNK5 : RF.UNK6;
            }
            return true;
        }
        return false;
    }
    calcCurrentMtx() {
        this.rot.y = fr(this.unk13C + this.initialRot.y);
        // (the game drops MsWrap's result)
        MsWrap(this.rot.y, 0, 360);
        const m = Float64Array.from(this.rootMtx());
        const r = Float64Array.from(m); MsMtxSetRotY(r, this.rot.y);
        r[3] = this.pos.x; r[7] = fr(this.pos.y - this.yOffset); r[11] = this.pos.z;
        setRootMtx(this, r);
    }
    controlWall() {
        const S = RevolvingFenceInner.mSpeed;
        switch (this.state) {
            case STATE_NORMAL: case RF.UNK2: break;
            case RF.UNK3:
                this.unk13C = fr(this.unk13C + S);
                if (this.unk13C > 180) { this.unk13C = 180; this.rot.y = fr(this.unk13C + this.initialRot.y); this.state = RF.UNK2; }
                this.calcCurrentMtx();
                break;
            case RF.UNK4:
                this.unk13C = fr(this.unk13C + S);
                if (this.unk13C > 360) { this.unk13C = 0; this.rot.y = fr(this.unk13C + this.initialRot.y); this.state = STATE_NORMAL; }
                this.calcCurrentMtx();
                break;
            case RF.UNK5:
                this.unk13C = fr(this.unk13C - S);
                if (this.unk13C < -180) { this.unk13C = 180; this.rot.y = fr(this.unk13C + this.initialRot.y); this.state = RF.UNK2; }
                this.calcCurrentMtx();
                break;
            case RF.UNK6:
                this.unk13C = fr(this.unk13C - S);
                if (this.unk13C < 0) { this.unk13C = 0; this.rot.y = fr(this.unk13C + this.initialRot.y); this.state = STATE_NORMAL; }
                this.calcCurrentMtx();
                break;
        }
    }
    controlGroundRoof() {
        const a = this.mactor;
        if (!a) return;
        const stop = (next: number) => {
            if (!a.curAnmEndsNext(ANM_BCK)) return;
            this.state = next;
            a.setFrameRate(0, ANM_BCK);
            const fc = a.getFrameCtrl(ANM_BCK); if (fc) fc.frame = 0;
            this.onMapObjFlag(MOF.NO_ANIMATIONS);
        };
        switch (this.state) {
            case RF.UNK3: case RF.UNK5: stop(RF.UNK2); break;
            case RF.UNK4: case RF.UNK6: stop(STATE_NORMAL); break;
        }
    }
    setGroundCollision() {
        // (Yoshi standing in it moves its collision too: no Yoshi here)
        super.setGroundCollision();
    }
    control() {
        super.control();
        if (this.unk140) this.controlWall();
        else this.controlGroundRoof();
    }
    initMapCollisionData() {
        const c = this.colMgr = new ObjCollisionManager(this.world, 1, 'mapObj', this);
        c.init(Math.abs(this.rot.x) < 80 && Math.abs(this.rot.z) < 80 ? 'fence_revolve_inner_v_tool' : 'fence_revolve_inner_h_tool', 1);
        this.mapCollision = c;
    }
    initMapObj() {
        super.initMapObj();
        this.unk140 = this.flat() ? 1 : 0;
        if (this.colMgr) this.colMgr.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
    }
}

export class RailFence extends Fence {
    static mFallHeight = 50000; static mWaitTime = 240;
    tracer = new GraphTracer(); unk140 = 0;
    constructor(w: World, name = 'レールフェンス') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (msg === MSG.SUPER_HIP_DROP) {
            this.world.sound(SE.OBJ_MVING_FENCT_PNCH, this.pos);
            this.setUpMapCollision(1);
            this.offMapObjFlag(MOF.NO_ANIMATIONS);
            this.state = RF.UNK2;
            return true;
        }
        return false;
    }
    falling() {
        this.pos.y = fr(this.pos.y + this.vel.y);
        this.vel.y = fr(this.vel.y - this.gravity);
        if (this.vel.y < -100) this.vel.y = -100;
        if (this.pos.y < this.initialPos.y - RailFence.mFallHeight) {
            this.pos.set(this.initialPos);
            this.setUpMapCollision(0);
            if (this.tracer.graph) this.tracer.setTo(this.tracer.graph.findNearestNodeIndex(this.pos, -1));
            this.makeObjAppeared();
            this.calcRootMatrix();
            this.onMapObjFlag(MOF.NO_ANIMATIONS);
        }
    }
    goOnRail() {
        const t = this.tracer;
        if (!t.graph) return;
        let d = V3.sub(t.current(), this.pos);
        if (d.squared() < 50) {
            const n = t.graph.nodes[t.cur];
            if (n.conns.length === 0 && (n.flags & 8)) {
                this.world.sound(SE.OBJ_MVING_FENCT_SET, this.pos);
                this.stateTimer = RailFence.mWaitTime;
                this.startAnim(1);
                this.state = RF.UNK3;
                return;
            }
            t.moveTo(t.graph.getShortestNextIndex(t.cur, t.prev, -1));
            // (the game sets the direction to the next node's position itself, not the offset)
            d = t.current();
        }
        this.world.sound(SE.OBJ_MVING_FENCE_MOVE, this.pos);
        // goOnRail: VECNormalize (PSVECNormalize: frsqrte + one Newton step), then scale by unk140 -- not a Math.sqrt-based normalize.
        const dir = vNorm(d.clone()).scale(this.unk140);
        this.posDelta.add(dir);
    }
    control() {
        super.control();
        switch (this.state) {
            case RF.UNK2: this.goOnRail(); break;
            case RF.UNK3:
                if (!this.isStateTimerEngaged()) { this.removeMapCollision(); this.world.sound(SE.OBJ_SUPERBLOCK_BREAK, this.pos); this.state = RF.UNK4; }
                break;
            case RF.UNK4: this.falling(); break;
        }
    }
    /** TMapObjBase's own (the table's two collisions) */
    initMapCollisionData() { MapObjBase.prototype.initMapCollisionData.call(this); }
    load(s: Stream) {
        super.load(s);
        const g = this.world.graphByName(s.str());
        if (g && !g.isDummy()) { this.tracer.init(g); this.tracer.setTo(g.findNearestNodeIndex(this.pos, -1)); }
        this.unk140 = 8;
        this.gravity = fr(0.3);
    }
}

export const FW = { STATE_UNK2: 2, STATE_UNK3: 3, STATE_UNK4: 4 };
export class FenceWater extends Fence {
    static mWaterAccel = fr(2.1); static mBackSpeed = 3; static mTurnedWaitTime = 600;
    /** its turning speed, its turn */
    unk13C = 0; unk140 = 0;
    unk144: MapObjMessenger | null = null;
    constructor(w: World, name = '水回転フェンス（垂直）') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (!this.isState(FW.STATE_UNK3) && msg === MSG.SPRAYED_BY_WATER) {
            this.unk13C = FenceWater.mWaterAccel;
            if (this.unk13C > 0) this.changeStatusToGo();
            return true;
        }
        return false;
    }
    changeStatusToGo() { this.world.sound(SE.OBJ_WATER_FENCE_FW, this.pos); this.state = FW.STATE_UNK2; }
    changeStatusToWait() { this.unk140 = 0; this.unk13C = 0; this.state = STATE_NORMAL; }
    controlRotation() {
        switch (this.state) {
            case STATE_NORMAL: break;
            case FW.STATE_UNK2:
                this.unk140 = fr(this.unk140 - this.unk13C);
                if (this.unk140 <= -90) { this.unk140 = -90; this.unk13C = 0; this.state = FW.STATE_UNK3; this.stateTimer = FenceWater.mTurnedWaitTime; }
                break;
            case FW.STATE_UNK3:
                if (!this.isStateTimerEngaged()) { this.world.sound(SE.OBJ_WATER_FENCE_REV, this.pos); this.unk13C = FenceWater.mBackSpeed; this.state = FW.STATE_UNK4; }
                break;
            case FW.STATE_UNK4:
                this.unk140 = fr(this.unk140 + this.unk13C);
                if (this.unk140 >= 0) this.changeStatusToWait();
                break;
        }
    }
    control() {
        MapObjBase.prototype.control.call(this);
        this.controlRotation();
        this.rot.y = MsWrap(fr(this.unk140 + this.initialRot.y), 0, 360);
        const m = this.unk144!;
        m.pos.x = fr(this.pos.x + fr(500 * MsCos(this.rot.y)));
        m.pos.z = fr(this.pos.z - fr(500 * MsSin(this.rot.y)));
    }
    /** TMapObjBase's (the table's collisions) */
    initMapCollisionData() { MapObjBase.prototype.initMapCollisionData.call(this); }
    initMapObj() {
        super.initMapObj();
        const m = this.unk144 = new MapObjMessenger('地形オブジェメッセンジャー');
        m.owner = this;
        m.initHitActor(this.actorType, 1, 0, 0, 0, 100, 300);
        m.offHitFilter(HF.NO_COLLISION);
        m.pos.set(this.pos.x, fr(this.pos.y - 150), this.pos.z);
        this.world.addToGroup('オブジェクトグループ', m);
    }
}
export class FenceWaterH extends FenceWater {
    constructor(w: World, name = '水回転フェンス（水平）') { super(w, name); }
    control() {
        MapObjBase.prototype.control.call(this);
        this.controlRotation();
        this.rot.z = MsWrap(fr(this.unk140 + this.initialRot.z), 0, 360);
        // TPosition3f::setEular(0, y, 0) x setEular(0, 0, z), at the position: getModel()->setAnmMtx(0, ...)
        const y = fr(0.017453294 * this.rot.y), z = fr(0.017453294 * this.rot.z);
        const sy = fr(Math.sin(y)), cy = fr(Math.cos(y)), sz = fr(Math.sin(z)), cz = fr(Math.cos(z));
        const ry = mtx(); ry[0] = cy; ry[2] = sy; ry[8] = -sy; ry[10] = cy;
        const rz = mtx(); rz[0] = cz; rz[1] = -sz; rz[4] = sz; rz[5] = cz;
        MTXConcat(ry, rz, ry);
        ry[3] = this.pos.x; ry[7] = this.pos.y; ry[11] = this.pos.z;
        setRootMtx(this, ry);
        const m = this.unk144!;
        m.pos.x = this.pos.x;
        m.pos.y = fr(this.pos.y - 150);
    }
    changeStatusToGo() { super.changeStatusToGo(); this.setUpMapCollision(1); }
    changeStatusToWait() { super.changeStatusToWait(); this.setUpMapCollision(0); }
}

// the revolving fence's panel, made by name
const prevUnique = OBJ_MAKERS.unique;
OBJ_MAKERS.unique = (w, name) => {
    if (name === 'fence_revolve_inner' || name === 'bambooFence_revolve_inner' || name === 'fenceInnerGreen') return new RevolvingFenceInner(w);
    return prevUnique ? prevUnique(w, name) : null;
};

register('Fence', (w, n) => new Fence(w, n));
register('FenceRevolve', (w, n) => new RevolvingFenceOuter(w, n));
register('FenceInner', (w, n) => new RevolvingFenceInner(w, n));
register('RailFence', (w, n) => new RailFence(w, n));
register('FenceWaterH', (w, n) => new FenceWaterH(w, n));
register('FenceWaterV', (w, n) => new FenceWater(w, n));
