// The secret courses' nail (MoveBG/MapObjEx.cpp's TMapObjNail): ground-pounded, it sinks 50 units
// into the floor, three times, and its hidden object (a coin) comes out on the third. The courses'
// other objects are lifts and blocks named for their looks, registered in railblock.ts. Also
// TJointCoin (CoinFish: the coin fish of Noki Bay and the secret stages; SandBird's base).

import { mat4 } from 'gl-matrix';
import { fr, V3, Mtx, mtx, MsMtxSetXYZRPH } from '../math.js';
import { World, HitActor, MActor, LF, HF, MSG, ANM_BCK, ANM_FRAME_RATE } from '../engine.js';
import { Skeleton } from '../skeleton.js';
import { MOF, newAndRegisterObj } from './base.js';
import { setRootMtx } from './lib.js';
import '../sound.js';
import { AT } from '../actortypes.js';
import { SE } from '../soundids.js';
import { register } from '../scene.js';
import { MapObjBase, mapObjGlobals } from './base.js';
import { HideObjBase } from './hide.js';
import { ItemManager } from './item.js';

export class MapObjNail extends HideObjBase {
    static mDownHeight = 50;
    /** unk150 times hit */
    unk150 = 0;
    constructor(w: World, name = 'くぎ') { super(w, name); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.HIP_DROP && !this.isStateTimerEngaged() && this.unk150 < 3) {
            this.pos.y = fr(this.pos.y - MapObjNail.mDownHeight);
            this.removeMapCollision();
            this.setUpCurrentMapCollision();
            this.world.sound(SE.OBJ_KUGI_IMPACT, this.pos);
            this.stateTimer = 120;
            ++this.unk150;
            if (this.unk150 === 3 && this.hidden) {
                let o: MapObjBase | null = this.hidden;
                if (o.isActorType(AT.COIN)) { const im = mapObjGlobals(this.world).itemManager as ItemManager | null; o = im ? im.makeObjAppear(AT.COIN) : null; }
                if (o) this.throwObjToFront(o, 200, this.appearSpeed, this.appearYSpeed);
            }
            return true;
        }
        return false;
    }
}

register('MapObjNail', (w, n) => new MapObjNail(w, n));


// ---------------------------------------------------------------- TJointCoin
/** a gl-matrix joint matrix as a row-major 3x4 */
const toMtx = (w: mat4): Mtx => {
    const m = mtx();
    m[0] = w[0]; m[1] = w[4]; m[2] = w[8]; m[3] = w[12];
    m[4] = w[1]; m[5] = w[5]; m[6] = w[9]; m[7] = w[13];
    m[8] = w[2]; m[9] = w[6]; m[10] = w[10]; m[11] = w[14];
    return m;
};
const jointNames = (a: MActor | null) => { const sk = a ? Skeleton.of(a.data.files.scene(a.model)) : null; return sk ? sk.names : []; };

export class JointCoin extends MapObjBase {
    /** unk138 the rail model (its root joint is where the fish is), unk140 the objects on its joints, unk144 their joints */
    unk138: MActor | null = null;
    unk13C = 0;
    unk140: MapObjBase[] = [];
    unk144: number[] = [];
    /** the rail model's base matrix (MsMtxSetXYZRPH of where it's placed) */
    railBase: Mtx = mtx();
    constructor(w: World, name = 'ジョイントコイン') { super(w, name); }
    control() {
        const r = this.unk138;
        if (r) {
            r.frameUpdate();
            const m0 = r.anmMtx(0, this.railBase, new V3(1, 1, 1));
            if (m0) {
                const m = toMtx(m0);
                this.pos.set(m[3], m[7], m[11]);
                this.baseTR.set(m);
            }
        }
        const a = this.mactor;
        if (a) {
            a.frameUpdate();
            const all = a.anmMtxAll(this.baseTR, this.scale);
            for (let i = 0; i < this.unk13C; i++) {
                const o = this.unk140[i], w = all && all[this.unk144[i]];
                if (!w) continue;
                const m = toMtx(w);
                if (o.mactor) setRootMtx(o, m);
                o.pos.set(m[3], fr(m[7] + o.yOffset), m[11]);
            }
        }
        super.control();
    }
    makeObj(name: string, i: number): MapObjBase | null {
        let o: MapObjBase | null;
        if (name === 'coin') {
            const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
            o = im ? im.newAndRegisterCoinReal() : null;
        } else o = newAndRegisterObj(this.world, name);
        // TODO: "no_data" (the dust joints) makes the data table's end entry, a bare TMapObjBase: the sim makes none
        if (!o) return null;
        if (o.isActorType(AT.COIN)) { o.offMapObjFlag(MOF.DISAPPEARING); o.onMapObjFlag(MOF.UNK10000000); }
        o.makeObjAppeared();
        o.onMapObjFlag(MOF.NO_ANIMATIONS);
        o.offMapObjFlag(MOF.DISAPPEARING);
        o.offLiveFlag(LF.ENABLE_CLIPPING);
        o.offHitFilter(HF.NO_COLLISION);
        this.unk140[this.unk13C] = o;
        this.unk144[this.unk13C] = i;
        ++this.unk13C;
        return o;
    }
    makeObjFromJointName(name: string, i: number) {
        if (name.includes('redcoin')) return this.makeObj('coin_red', i);
        if (name.includes('bluecoin')) return this.makeObj('coin_blue', i);
        if (name.includes('coin')) return this.makeObj('coin', i);
        if (name.includes('dust')) return this.makeObj('no_data', i);
        return null;
    }
    nameIsObj(name: string) { return name.includes('coin'); }
    loadAfter() {
        super.loadAfter();
        this.unk13C = 0;
        const names = jointNames(this.mactor);
        for (let i = 0; i < names.length - 1; i++) this.makeObjFromJointName(names[i], i);
        const fc = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
        if (fc) fc.rate = fr(ANM_FRAME_RATE * fr(0.25));
        const rc = this.unk138 && this.unk138.getFrameCtrl(ANM_BCK);
        if (rc) rc.rate = fr(ANM_FRAME_RATE * fr(0.25));
    }
    initMapObj() {
        super.initMapObj();
        for (const n of jointNames(this.mactor)) if (this.nameIsObj(n)) ++this.unk13C;
        const m = this.manager;
        let rail: string | null = null, bck = '';
        if (this.isActorType(AT.COIN_FISH)) { rail = 'mapobj/coinfishrail.bmd'; bck = 'coinfishrail'; }
        else if (this.isActorType(AT.SAND_BIRD)) { rail = 'mapobj/sandbirdrail.bmd'; bck = 'sandbirdrail'; }
        if (rail && m) {
            this.unk138 = new MActor(rail, m.getMActorAnmData());
            this.unk138.setBck(bck);
        }
        MsMtxSetXYZRPH(this.railBase, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
    }
}

register('CoinFish', (w, n) => new JointCoin(w, n));
