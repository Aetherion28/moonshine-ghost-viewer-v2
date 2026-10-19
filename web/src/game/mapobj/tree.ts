// Palms and banana trees (MoveBG/MapObjTree.cpp): each leaf is its own moving collision
// (/mapObj/<name>LeafNN.col, its triangles' data the leaf's number) that Mario can stand on;
// standing or ground-pounding on one sets it swinging on a damped spring. Falling Mario lands on
// the leaves; jumping up he goes through them (they're only put in the grid while he isn't
// going up). TMapObjTreeScale: a banana tree that starts small (on goop, or in Pinna) and grows
// when sprayed or once the goop under it is gone, shaking the camera as it does.

import { fr, V3, Mtx, mtx, MsRandF } from '../math.js';
import { World, HitActor, HF, CUE_MOVE, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MOF, STATE_NORMAL } from './base.js';
import { MapObjGeneral } from './general.js';
import { ObjCollision, KIND_MOVE } from './objcol.js';
import { MTXConcat, MTXRotAxisRad, restJointMtx, setJointWorlds, marioGroundPlane, marioSpeedY } from './lib.js';
import { marioIsOn, marioHipAttack } from './bianco.js';

/** TMapObjLeaf */
class MapObjLeaf {
    angle = 0; angVel = 0;
    col: ObjCollision;
    transform: Mtx = mtx();
    /** (for the viewer) its joint's world matrix now */
    now: Mtx = mtx();
    constructor(w: World, owner: MapObjTree) { this.col = new ObjCollision(w, KIND_MOVE, owner); }
}

export class MapObjTree extends MapObjGeneral {
    static mBananaTreeJumpPower = 1000;
    minCanopyRadius = 0; maxCanopyRadius = 0; leafNum = 0; leaves: MapObjLeaf[] = []; freezeLeaves = true;
    leafTouchImpulse = 0; leafHipDropImpulse = 0; leafStiffness = 0; leafDamping = 0; unk16C = 0;
    private leavesMoved = false;
    constructor(w: World, name = '木') { super(w, name); }
    getRadiusAtY(y: number) {
        return fr(this.minCanopyRadius + fr(fr(fr(this.maxCanopyRadius - this.minCanopyRadius) * fr(fr(this.pos.y + this.damageHeight) - y)) / this.damageHeight));
    }
    touchPlayer(_p: HitActor) {
        this.freezeLeaves = false;
        const g = marioGroundPlane(this.world), data = g.data;
        if (!(g.actor === this && data >= 0 && data < this.leafNum)) return;
        const l = this.leaves[data];
        if (marioHipAttack(this)) l.angVel = fr(l.angVel + this.leafHipDropImpulse);
        else if (marioIsOn(this)) l.angVel = fr(l.angVel + this.leafTouchImpulse);
    }
    controlLeaf(i: number) {
        const l = this.leaves[i];
        if (l.angVel === 0) {
            if (marioSpeedY(this.world) <= 0) l.col.moveMtx(l.transform);
            return 1;
        }
        l.angle = fr(l.angle + l.angVel);
        l.angVel = fr(l.angVel - fr(l.angle * this.leafStiffness));
        l.angVel = fr(l.angVel * this.leafDamping);
        const r = mtx();
        MTXRotAxisRad(r, new V3(1, 0, 0), l.angle);
        const m = MTXConcat(l.transform, r, mtx());
        l.now = m;
        this.leavesMoved = true;
        if (marioSpeedY(this.world) <= 0) l.col.moveMtx(m);
        // TODO: the decomp's abs() (int or float?): read as the float one here
        if (Math.abs(l.angle) < this.leafTouchImpulse && Math.abs(l.angle) < this.leafTouchImpulse) return 1;
        return 0;
    }
    perform(cue: number) {
        if (!this.freezeLeaves && (cue & CUE_MOVE)) {
            let n = 0;
            for (let i = 0; i < this.leafNum; i++) n += this.controlLeaf(i);
            if (this.collisions.length === 0 && n === this.leafNum) this.freezeLeaves = true;
        }
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && this.leavesMoved) {
            // the leaves' joints (setAnmMtx(leafNum - i)) for the viewer
            this.leavesMoved = false;
            const W = new Map<number, Mtx>();
            for (let i = 0; i < this.leafNum; i++) W.set(this.leafNum - i, this.leaves[i].now);
            setJointWorlds(this, W);
        }
    }
    initEach() {
        const set = (min: number, max: number, n: number, ti: number, hi: number, st: number, dm: number) => {
            this.minCanopyRadius = min; this.maxCanopyRadius = max; this.leafNum = n;
            this.leafTouchImpulse = fr(ti); this.leafHipDropImpulse = fr(hi); this.leafStiffness = fr(st); this.leafDamping = fr(dm);
        };
        switch (this.actorType) {
            case AT.PALM_NORMAL: case AT.PALM_LEAF: set(20, 95, 12, 0.001, 0.006, 0.01, 0.97); break;
            case AT.PALM_OUGI: set(20, 100, 8, 0.001, 0.006, 0.01, 0.97); break;
            case AT.PALM_SAGO: set(50, 100, 12, 0.001, 0.006, 0.01, 0.97); break;
            case AT.PALM_NATUME: set(95, 60, 8, 0.001, 0.006, 0.01, 0.97); break;
            case AT.BANANA_TREE: set(70, 100, 8, 0.004, 0.008, 0.03, 0.9); break;
        }
    }
    initMapObj() {
        super.initMapObj();
        this.initEach();
        this.leaves = [];
        for (let i = 0; i < this.leafNum; i++) {
            const l = new MapObjLeaf(this.world, this);
            const nn = String(i + 1).padStart(2, '0');
            const path = this.isActorType(AT.PALM_LEAF) ? `/mapObj/palmLeaf${nn}` : `/mapObj/${this.individualName}Leaf${nn}`;
            l.col.init(path, 0);
            for (const d of l.col.checks) d.data = i;   // setAllData(i)
            l.col.remove();
            const j = restJointMtx(this, this.leafNum - i);
            if (j) l.transform = j;
            l.now = l.transform;
            l.col.setUpMtx(l.transform);
            this.leaves.push(l);
        }
    }
}

// ---------------------------------------------------------------- TMapObjTreeScale
export const TS = { SMALL: 0xB, SCALING_UP_Y_ONLY: 0xC, SCALING_UP: 0xD };
const sWaitTime = 1;
export class MapObjTreeScale extends MapObjTree {
    static mScaleMin = fr(0.1); static mScaleSpeedXZ = fr(0.007); static mStatusChangeScaleY = fr(0.3); static mScaleSpeedY = fr(0.005);
    particles: V3[] = Array.from({ length: 30 }, () => new V3());
    nextParticle = 0; particleTimer = 0;
    sinkEvent: { isBuried(i: number): boolean } | null = null;
    constructor(w: World, name = 'スケールの木') { super(w, name); }
    startScaleUp() {
        this.awake();
        this.actorType = AT.BANANA_TREE;
        this.removeMapCollision();
        this.state = TS.SCALING_UP_Y_ONLY;
    }
    touchWater(a: HitActor) {
        if (this.scale.x === 1) return super.touchWater(a);
        if (this.isState(TS.SMALL)) this.startScaleUp();
        return 1;
    }
    private polluted() { const P = this.world.pollution; return !!P && P.isPolluted(this.pos.x, this.pos.y, this.pos.z); }
    control() {
        const T = MapObjTreeScale, w = this.world;
        switch (this.state) {
            case TS.SMALL:
                if (w.map !== 4 && !this.polluted()) this.startScaleUp();
                break;
            case TS.SCALING_UP_Y_ONLY:
                w.sound(SE.OBJ_TREE_APPEAR, this.pos);
                this.scale.y = fr(this.scale.y + T.mScaleSpeedY);
                if (this.scale.y > T.mStatusChangeScaleY) this.state = TS.SCALING_UP;
                break;
            case TS.SCALING_UP:
                w.sound(SE.OBJ_TREE_APPEAR, this.pos);
                if (this.scale.y < 1) this.scale.y = fr(this.scale.y + T.mScaleSpeedY);
                else this.scale.y = 1;
                if (this.scale.x < 1) { this.scale.x = fr(this.scale.x + T.mScaleSpeedXZ); this.scale.z = fr(this.scale.z + T.mScaleSpeedXZ); }
                else {
                    this.scale.x = 1; this.scale.z = 1;
                    this.onMapObjFlag(MOF.NO_ANIMATIONS);
                    // getModel()->calc(): its matrices at the full size
                    this.calcRootMatrix();
                    this.offHitFilter(HF.NO_ATTACK);
                    this.setUpCurrentMapCollision();
                    this.state = STATE_NORMAL;
                }
                break;
            default:
                super.control();
                break;
        }
        if (this.isState(TS.SCALING_UP_Y_ONLY) || this.isState(TS.SCALING_UP)) {
            this.setObjHitData(0);
            if (w.map !== 2 || (!w.demoMode && (!this.sinkEvent || this.sinkEvent.isBuried(1)))) {
                // SMSRumbleMgr->start(0x13) / gpCameraShake->keepShake(CAM_SHAKE_MODE_UNK5, 1)
                w.events.push({ t: w.tickCount, kind: 'cameraShake', data: { mode: 5, power: 1, p: this.pos.clone() } });
            }
            if (this.particleTimer > sWaitTime) {
                const x = fr(fr(this.pos.x + fr(400 * MsRandF())) - 200);
                const z = fr(fr(this.pos.z + fr(400 * MsRandF())) - 200);
                const p = this.particles[this.nextParticle].set(x, this.pos.y, z);
                w.effect('rakuKie', p);
                if (++this.nextParticle >= this.particles.length) this.nextParticle = 0;
                this.particleTimer = 0;
            }
            ++this.particleTimer;
        }
    }
    beSmall() {
        const s = MapObjTreeScale.mScaleMin;
        this.scale.set(s, s, s);
        this.sleep();
        this.offHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_ATTACK);
        this.setObjHitData(0);
        this.damageRadius = this.attackRadius;
        this.calcEntryRadius();
        this.damageHeight = 30;
        this.calcEntryRadius();
        this.removeMapCollision();
        this.offMapObjFlag(MOF.NO_ANIMATIONS);
        this.actorType = AT.MAP_OBJ_TREE_SCALE;
        this.state = TS.SMALL;
        // SMS_HideAllShapePacket: (sleep's flag keeps it from being drawn here)
    }
    loadAfter() {
        super.loadAfter();
        if (this.world.map === 4 || this.polluted()) this.beSmall();
        this.sinkEvent = this.world.search('イベント（地形沈むビアンコ）') as any;
    }
}

register('BananaTree', (w, n) => new MapObjTree(w, n));
register('Palm', (w, n) => new MapObjTree(w, n));
register('PalmOugi', (w, n) => new MapObjTree(w, n));
register('PalmSago', (w, n) => new MapObjTree(w, n));
register('PalmNatume', (w, n) => new MapObjTree(w, n));
register('MapObjTreeScale', (w, n) => new MapObjTreeScale(w, n));
