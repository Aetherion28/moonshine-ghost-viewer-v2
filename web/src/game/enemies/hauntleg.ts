// THauntLeg / THauntLegManager / THauntedObject (Enemy/hauntLeg.cpp): the haunted-hotel legs
// (ハントレッグ). A TWalkerEnemy in spider mode (it walks up walls like the goop blobs) that
// wanders the "main" graph; bumping into an item or a map object (isCollidMove) it jumps at it
// (TNerveHauntLegHaunt: a jump aimed at the thing, then a second hop that takes it when within
// 200), spinning its joint 1 round Z (unk1AC, HauntLegCallback) while airborne, and carries it
// until it dies (setDeadAnm puts it back down). Its weak spot is THauntedObject: a separate hit
// cylinder in the enemy group, kept on joint 2, that a stomp or a ground pound (msg <= HIP_DROP)
// kills the leg through. Touching Mario within 100 hurts him (attackToMario).
// The manager (HauntLegManager, ハントレッグマネージャー) puts each leg on a random node of the
// "main" graph when it makes them (initSetEnemies: the TU's one rand()).
//
// Not here: the TEV colours the manager gives each leg (drawing only), the BAS sound table (empty).

import { fr, V3, Mtx, mtx, MsSin, MsCos, MsClamp, MsRandF } from '../math.js';
import { World, LF, HC, MSG, HF, nerve, Spine, Stream, HitActor, TakeActor, LiveActor, LiveManager } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, Walker, walkerParams } from './walker.js';
import { Spider } from './namekuri.js';
import { MsMtxSetRotX, MsMtxSetRotZ, MTXConcat } from '../mapobj/lib.js';
import { register } from '../scene.js';
import type { mat4 } from 'gl-matrix';

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

// hauntleg's BCK indices (setGenerateAnm / setWalkAnm, setRunAnm / setWaitAnm)
const BCK_GENERATE = 0, BCK_WALK = 1, BCK_WAIT = 2;

/** TWalker with setMode(1): binds through its TSpider. */
class SpiderWalker extends Walker {
    spider: Spider | null = null;
    setMode(m: number) { this.unk28 = m; if (this.unk28 === 1 && !this.spider) this.spider = new Spider(); }
    bind(a: LiveActor) { if (this.unk28 === 1 && this.spider) { this.spider.bind(a); return; } super.bind(a); }
}

export class HauntLegManager extends SmallEnemyManager {
    constructor(w: World, name = 'ハントレッグマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/hauntLeg.prm', this.world.files);
    }
    createModelData() { this.createModelDataArray(['hauntleg.bmd']); }
    createEnemyInstance(): SmallEnemy { return new HauntLeg(this.world); }
    /** initSetEnemies: each on a random node of "main", 5 up, airborne, reset */
    initSetEnemies() {
        for (let i = 0; i < this.objs.length; ++i) {
            const graph = this.world.graphByName('main');
            const e = this.objs[i] as HauntLeg;
            const p = graph.point(rangeRandI(0, graph.count));
            e.pos.set(p);
            e.pos.y = fr(e.pos.y + 5);
            e.onLiveFlag(LF.AIRBORNE);
            e.reset();
            // (SMS_InitPacket_TwoTevColor per material: drawing only)
        }
    }
}

/** THauntedObject: the leg's weak spot (ハントオブジェクト) */
export class HauntedObject extends HitActor {
    unk68: HauntLeg | null = null;
    constructor(name = 'ハントオブジェクト') { super(name); }
    receiveMessage(_s: HitActor, msg: number): boolean {
        if (msg <= MSG.HIP_DROP) { this.unk68!.kill(); return true; }
        if (msg === MSG.SPRAYED_BY_WATER) return true;
        return false;
    }
    /** (an empty loop over its collisions) */
    checkHit() { }
    kill() { this.onHitFilter(HF.NO_COLLISION); }
}

export class HauntLeg extends WalkerEnemy {
    unk194: HauntedObject | null = null;
    /** carrying unk19C */
    unk198 = 0;
    /** the haunt jump's first hop */
    unk199 = 1;
    /** the item / map object it haunts */
    unk19C: TakeActor | null = null;
    /** the jump's velocity */
    unk1A0 = new V3();
    /** joint 1's Z spin (HauntLegCallback) */
    unk1AC = 0;
    constructor(w: World, name = 'ハントレッグ') { super(w, name); }
    get spiderWalker() { return this.binder as SpiderWalker; }
    init(m: LiveManager | null) {
        super.init(m);
        this.binder = new SpiderWalker();   // (TWalkerEnemy::init's TWalker, with its mode)
        this.walker.reset();
        this.walker.unk18 = 150;
        this.actorType = AT.HAUNT_LEG;
        this.unk150 = 0x3A;
        this.onHitFilter(HC.ITEM | HC.MAP_OBJECT);
        this.spiderWalker.setMode(1);
        this.unk130 = 2;
        const o = this.unk194 = new HauntedObject();
        this.world.addToGroup('敵グループ', o);
        const r = fr(30 * this.bodyScale);
        o.initHitActor(AT.HAUNT_LEG, 2, HC.PLAYER, r, r, r, r);
        o.unk68 = this;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('hauntleg.bmd'); }
    reset() {
        this.unk19C = null; this.unk198 = 0; this.unk199 = 1;
        super.reset();
    }
    isUseCallBack() { return this.spine!.current === HauntLegNerves.haunt; }
    /** HauntLegCallback on joint 1: its matrix (and its children's) times a Z rotation by unk1AC */
    private jointPost = (j: number, m: mat4) => {
        if (j !== 1 || !this.isUseCallBack()) return;
        const r = mtx(); MsMtxSetRotZ(r, this.unk1AC);
        const a = Array.from(m);
        for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = a[row] * r[c] + a[4 + row] * r[4 + c] + a[8 + row] * r[8 + c];
    };
    /** getAnmMtx(j) as a Mtx */
    anmMtx(j: number): Mtx {
        const out = mtx();
        const m = this.mactor ? this.mactor.anmMtx(j, this.baseTR, this.scale, this.jointPost) : null;
        if (!m) { out.set(this.baseTR); return out; }
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
        return out;
    }
    calcRootMatrix() {
        if (this.isEaten()) return;
        const m = this.baseTR;
        const sp = this.spiderWalker.spider;
        if (sp && sp.wallAttachRate > 0 && this.unk138) {
            let z = new V3(0, 1, 0);
            const N = new V3(this.unk138.n[0], this.unk138.n[1], this.unk138.n[2]);
            const x = new V3().cross(N, z).normalize();
            z = new V3().cross(x, N).normalize();
            m[0] = x.x; m[4] = x.y; m[8] = x.z;
            m[1] = N.x; m[5] = N.y; m[9] = N.z;
            m[2] = z.x; m[6] = z.y; m[10] = z.z;
            m[3] = 0; m[7] = 0; m[11] = 0;
            const r = mtx(); MsMtxSetRotX(r, fr(90 * fr(1 - sp.wallAttachRate)));
            MTXConcat(m, r, m);
        } else {
            let z = new V3(MsSin(this.rot.y), 0, MsCos(this.rot.y));
            const g = this.groundPlane;
            const N = new V3(g.n[0], g.n[1], g.n[2]);
            const x = new V3().cross(N, z).normalize();
            z = new V3().cross(x, N).normalize();
            m[0] = x.x; m[4] = x.y; m[8] = x.z;
            m[1] = N.x; m[5] = N.y; m[9] = N.z;
            m[2] = z.x; m[6] = z.y; m[10] = z.z;
        }
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
        const o = this.unk194!;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) o.pos.set(this.pos);
        else { const j = this.anmMtx(2); o.pos.set(j[3], j[7], j[11]); }
        o.checkHit();
    }
    setGenerateAnm() { this.setBckAnm(BCK_GENERATE); }
    setWaitAnm() { this.setBckAnm(BCK_WAIT); }
    setWalkAnm() { this.setBckAnm(BCK_WALK); }
    setRunAnm() { this.setBckAnm(BCK_WALK); }
    setDeadAnm() {
        if (this.unk19C) {
            this.unk19C.receiveMessage(this, MSG.PUT);
            this.holder = null; this.held = null;
        }
        this.unk194!.kill();
    }
    attackToMario() {
        this.updateSquareToMario();
        if (this.distToMarioSq < 10000) this.sendAttackMsgToMario();
    }
    isCollidMove(a: HitActor) {
        if (this.spine!.current !== HauntLegNerves.haunt && !this.unk198 && !this.checkLiveFlag(LF.CLIPPED_OUT)) {
            const t = a.getHitCategory();
            if (t === (HC.ITEM | 0) || t === (HC.MAP_OBJECT | 0)) {
                const actor = a as TakeActor;
                if (!actor.holder || actor !== this.unk19C) {
                    this.unk19C = actor;
                    this.spine!.setNext(HauntLegNerves.haunt);
                }
                return false;
            }
        }
        return false;
    }
    getTakingMtx(): Mtx | null {
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) {
            const m = mtx(); m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
            this.baseTR.set(m);
            return this.baseTR;
        }
        return this.anmMtx(2);
    }
}

type S = Spine<HauntLeg>;
export const HauntLegNerves = {
    haunt: nerve<HauntLeg>('TNerveHauntLegHaunt', (spine: S) => {
        const e = spine.body;
        if (spine.time === 0) {
            e.unk1A0 = e.calcVelocityToJumpToY(e.unk19C!.pos, 10, e.getGravityY());
            e.vel.set(e.unk1A0);
            e.pos.y = fr(e.pos.y + 10);
            e.onLiveFlag(LF.AIRBORNE);
            e.unk199 = 1;
        } else if (!e.isAirborne()) {
            if (e.unk199) {
                e.vel.set(e.unk1A0);
                e.pos.y = fr(e.pos.y + 10);
                e.unk199 = 0;
                const t = e.unk19C!;
                if (V3.sub(e.pos, t.pos).length() < 200 && !t.holder && t.receiveMessage(e, MSG.TAKE)) {
                    e.held = t;
                    e.unk198 = 1;
                }
            } else {
                e.unk1AC = 0;
                spine.pushAfterCurrent(WalkerNerves.graphWander);
                return true;
            }
        }
        if (e.isAirborne()) e.unk1AC = MsClamp(fr(2 + e.unk1AC), 0, e.unk199 ? 180 : 360);
        return false;
    }),
};

register('HauntLegManager', (w, n) => new HauntLegManager(w, n));
