// The Monty Mole cannons (TCannon, Enemy/cannon.cpp, 砲台) and their mole (TChorobei, チョロベー)
// and barrels (TCannonDom, 砲身). Which one a cannon is goes by the area (unk230, getStage):
//  - 5 and 9 (Noki Bay): the fort. The mole pops out of the hatch (Open) and watches Mario
//    (Search, the cannon turning to its goal). Near (mSLBombDist) it throws what bombSet makes
//    appear — a Bob-omb (mSLBombHeiGenerateRate), else a Pokey head or a Strollin' Stu — at
//    Mario (Shoot: picked at frame end of BCK 17, thrown at frame 38 of BCK 16, growing from frame
//    26); far (mSLKillerDist) it fires three shots from its barrels in turn (unk214), then one more
//    throw (ForceBombShoot): Bullet Bills at Mario in area 5, or in Noki Bay (unk239 = 0) spiky
//    balls (TIgaiga::shoot) at the first node of their graph. Too close (mSLHideDist) the mole
//    ducks into the hatch (Close; the hatch's collision CannonFuta moves with joint 4) until Mario
//    is three times as far. A Bob-omb thrown or exploding on the mole (TChorobei::checkHit ->
//    hitHead), or a rolling Bullet Bill, hurts it (Damage); at no hit points left it falls over
//    (DamageDemo) and the cannon is a plain object (Object).
//  - otherwise: an object (Object) with one barrel, that a MARE_CORK can hold (TAKE).
// The mole and the barrels are TSharedParts drawn on the cannon's joints (world.extras here); the
// barrels' collision (CannonDom) moves with them, and the top of the fort is two triangles round
// joint 4 (unk258: calcObjCollision / entryObjCollision).
//
// Not here: the particles, the damage fog, rumble, the demo cameras (tyorocam_*), the mole's and
// barrels' anm sounds, the Mario-in-the-cannon model (hodai_mario.bmd: unk238 is never set here),
// TFlagManager's MSF_MONTY_MOLE_DEFEATED, and the director's STATE_UNK1 checks (taken as false).
// The Bullet Bills (killerShoot's area-5 branch) come from enemies/killer.ts's キラーマネージャー.

import { MSF } from '../flags.js';
import { fr, V3, Mtx, mtx, MsClamp, MsWrap, MsSin, MsGetRotFromZaxis, MsGetRotFromZaxisY, MsMtxSetRotRPH, MsMtxSetXYZRPH, JMASSin, JMASCos, MsRandF, s16 } from '../math.js';
import { World, Stream, HitActor, LiveActor, MActor, LF, HF, HC, MSG, ANM_BCK, ANM_BTK, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, nerve, Spine, PathNode, PSchema, SpineEnemy, MoveCollision } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { BGCheckData } from '../collision.js';
import { SmallEnemy, SmallEnemyManager, smallParams, rangeRand } from './smallEnemy.js';
import { msVecNormalize } from '../camera/lib.js';
import { MTXConcat } from '../mapobj/lib.js';
import type { BombHei } from './bombhei.js';

/** TCannonSaveLoadParams */
const CANNON_PARAMS = {
    mSLHideDist: ['f', 300], mSLBombDist: ['f', 2000], mSLKillerDist: ['f', 10000], mSLBombInterval: ['i', 100], mSLKillerInterval: ['i', 50],
    mSLShootInterval: ['i', 100], mSLChorobeiAttackRadius: ['f', 100], mSLChorobeiAttackHeight: ['f', 100], mSLChorobeiDamageRadius: ['f', 100],
    mSLChorobeiDamageHeight: ['f', 100], mSLKillerTransYOffset: ['f', -50], mSLBombHeiGenerateRate: ['f', 0.7], mSLThrowXZSpeed: ['f', 12],
} satisfies PSchema;

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

/** A J3D joint matrix (column-major 4x4) as a Mtx (3x4 row-major) */
function m4ToMtx(m: ArrayLike<number> | null, out: Mtx = mtx()): Mtx {
    if (!m) return out;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
    return out;
}
/** A Mtx as the column-major 4x4 MoveCollision.moveMat4 takes (TMapCollisionMove::moveMtx) */
const mtxToM4 = (m: Mtx) => [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1];
/** TMapCollisionMove::setUpTrans */
const setUpTrans = (c: MoveCollision, p: V3) => c.moveSRT(p, new V3(), new V3(1, 1, 1));

// BCKs (/scene/cannon, in the folder's order: the cannon's, the barrels' and the mole's share it)
const BCK_CANNON_CLOSE = 0, BCK_DOM_SHOOT = 1, BCK_DOM_BREAK = 2, BCK_CANNON_OPEN = 3, BCK_CANNON_DOWN = 4;
const BCK_TYORO_APPEAR = 12, BCK_TYORO_DAMAGE = 13, BCK_TYORO_DOWN = 14, BCK_TYORO_HIDE = 15, BCK_TYORO_THROW = 16, BCK_TYORO_PICK = 17,
    BCK_TYORO_WAIT = 18, BCK_TYORO_SEARCH = 19;

// ---------------------------------------------------------------- the parts
/** A TSharedParts model: drawn by the viewer (world.extras) at baseTR. */
class PartModel extends LiveActor {
    constructor(w: World, name: string, m: MActor, public visible: () => boolean) {
        super(w, name);
        this.mactor = m;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        w.extras.push(this);
    }
    perform() { }
    drawn() { return this.visible(); }
    /** getModel()->getAnmMtx(j) */
    anmMtx(j: number) { return m4ToMtx(this.mactor!.anmMtx(j, this.baseTR, this.scale)); }
}

/** TCannonDom: a barrel on one of the cannon's joints (nullA-C). */
export class CannonDom {
    model: PartModel;
    /** unk24 not shown, unk28 / unk2C its pitch / yaw on the joint, unk30 its sway's phase */
    unk24 = 0; unk28 = 0; unk2C = 0; unk30 = 0;
    constructor(public owner: Cannon, public joint: number, name = '砲身') {
        const m = owner.manager!;
        this.model = new PartModel(owner.world, name, new MActor('cannon/cannon_dom.bmd', m.getMActorAnmData()),
            () => !this.unk24 && !owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT | LF.UNK200));
        this.unk30 = rangeRand(0, 360);
    }
    getConnectedMtx() { return this.owner.getAnmMtx(this.joint); }
    perform(cue: number) {
        const o = this.owner;
        if (o.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) return;
        if (cue === CUE_CALC_ANIM) {
            const m = this.getConnectedMtx();
            const r = mtx(); MsMtxSetRotRPH(r, this.unk28, this.unk2C, 0);
            MTXConcat(m, r, m);   // (into the cannon's joint matrix itself: the game's)
            this.model.baseTR.set(m);
        }
        if (cue & CUE_CALC_ANIM) this.model.mactor!.frameUpdate();
    }
    setBckAnm(i: number) { this.model.mactor!.setBckFromIndex(i); }
}

/** TChorobei: the Monty Mole on top (tyorobe_model1.bmd on joint 0, 300 up), and its hit. */
export class Chorobei extends HitActor {
    model: PartModel;
    /** unk70 down (not shown), unk7C its height over the joint */
    unk70 = 0; unk7C = 300;
    constructor(public owner: Cannon, public joint: number, name = 'チョロベー') {
        super(name);
        const m = owner.manager!;
        this.model = new PartModel(owner.world, name, new MActor('cannon/tyorobe_model1.bmd', m.getMActorAnmData()),
            () => !this.unk70 && !owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT | LF.UNK200));
    }
    get mactor() { return this.model.mactor!; }
    perform(cue: number) {
        const o = this.owner;
        if (o.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) return;
        if (this.unk70) return;
        if (cue & CUE_CALC_ANIM) {
            const m = o.getAnmMtx(this.joint).slice();
            m[7] = fr(m[7] + this.unk7C);
            this.model.baseTR.set(m);
            this.pos.set(m[3], fr(m[7] - 150), m[11]);
            this.mactor.frameUpdate();
        }
    }
    setBckAnm(i: number) { this.mactor.setBckFromIndex(i); }
    checkHit() {
        for (const a of this.collisions.slice()) {
            if (a.isActorType(AT.MARIO)) this.owner.world.mario.receiveMessage(this, MSG.ATTACK);
            if (a.isActorType(AT.BOMB_HEI)) this.owner.hitHead(a as BombHei);
            if (a.isActorType(AT.ENEMY_UNK1F)) {
                const k = a as any;
                if (!(k.isRollFly && k.isRollFly())) continue;
                this.owner.spine!.pushNerve(CannonNerves.damage);
                k.kill();
            }
        }
    }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    isUpEnd() {
        if (this.mactor.curAnmEndsNext(ANM_BCK) && this.mactor.checkCurBckFromIndex(BCK_TYORO_APPEAR)) return true;
        this.unk70 = 0;
        return false;
    }
    isDownEnd() {
        if (this.mactor.curAnmEndsNext(ANM_BCK) && this.mactor.checkCurBckFromIndex(BCK_TYORO_HIDE)) { this.unk70 = 1; return true; }
        return false;
    }
}

// ---------------------------------------------------------------- the manager
export class CannonManager extends SmallEnemyManager {
    constructor(w: World, name = '砲台マネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = smallParams('/enemy/cannon.prm', this.world.files, CANNON_PARAMS);
    }
    createEnemyInstance(): SpineEnemy | null { return new Cannon(this.world); }
    /** clipEnemies: none */
    clipActors() { }
}

// ---------------------------------------------------------------- TCannon
export class Cannon extends SmallEnemy {
    static mChorobeiJntIdx = [4]; static mChorobeiHandJntIdx = [4];
    static mVelocityRate = fr(0.62); static mSearchRate = fr(0.02);
    /** unk194 / unk1A0 an enemy attached to the mole (never set here), unk1A4 what the mole holds to throw */
    unk194 = new V3(); unk1A0: SmallEnemy | null = null; unk1A4: SpineEnemy | null = null;
    unk1A8: Chorobei | null = null; unk1AC: CannonDom[] = []; unk1B8: CannonDom | null = null;
    unk1C0: MoveCollision[] = [];
    unk1E4 = mtx();
    /** unk214 the barrel that fires next, unk21C a Pokey head held (never set here), unk220 its full scale */
    unk214 = 0; unk218 = 0; unk21C = 0; unk220 = 0; unk224 = [0, 0, 0];
    /** unk230 the area, unk234 its first yaw, unk238 Mario in it (hodai_mario), unk239 Bullet Bills (else spiky balls) */
    unk230 = 1; unk234 = 0; unk238 = 0; unk239 = 1;
    unk23C = new V3(); unk248 = new V3();
    /** unk254 efMareGate */
    unk254: any = null;
    /** unk258 the top's two triangles round unk25C */
    unk258 = [new BGCheckData(), new BGCheckData()]; unk25C = [new V3(), new V3(), new V3(), new V3()];
    unk28C: any = null;
    /** unk290 a throw (else a shot) */
    unk290 = 0; unk294 = new V3(); unk2A0 = new V3(); unk2AC = 0;
    unk2B0: MoveCollision | null = null;
    /** the model's joint matrices as of its last calc (getModel()->getAnmMtx) */
    private anm: Mtx[] = [];
    constructor(w: World, name = '砲台') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.reset();
        this.resetHitPoints();
        this.unk230 = this.world.map;
        this.unk23C.set(this.pos);
    }
    loadAfter() {
        // (the particles: ms_cannon_*.jpa)
        if (this.unk230 === 5) {
            this.unk254 = this.world.search('efMareGate');
            if (this.unk254 && this.unk254.kill) this.unk254.kill();
        }
    }
    init(m: any) {
        super.init(m);
        this.actorType = AT.DPT_CANNON;
        this.unk150 = 17;
        this.unk28C = this.getSaveParam();
        this.setBckAnm(BCK_CANNON_OPEN);
        this.unk234 = this.rot.y;
        this.unk230 = this.world.map;
        if (this.unk230 === 5 || this.unk230 === 9) {
            this.spine!.initWith(CannonNerves.search);
            if (this.unk230 === 9) { this.unk239 = 0; this.setGoalPath(new PathNode(null, new V3(-565, 8500, 7675))); }
            else this.setGoalPath(new PathNode(this.world.mario));
            const c = this.unk1A8 = new Chorobei(this, 0);
            const P = this.unk28C;
            c.initHitActor(AT.ENEMY_UNK1D, 3, HC.PLAYER | HC.ENEMY, P.mSLChorobeiAttackRadius, P.mSLChorobeiAttackHeight, P.mSLChorobeiDamageRadius, P.mSLChorobeiDamageHeight);
            this.world.addToGroup('敵グループ', c);
            for (const j of ['nullC', 'nullB', 'nullA']) {
                this.unk1AC.push(new CannonDom(this, this.mactor ? this.mactor.jointIndex(j) : -1));
                const col = new MoveCollision(this.world, '/scene/cannon/cannondom.col', this);
                setUpTrans(col, this.pos);
                this.unk1C0.push(col);
            }
            this.unk2B0 = new MoveCollision(this.world, '/scene/cannon/cannonfuta.col', this);
            setUpTrans(this.unk2B0, this.pos);
        } else {
            this.spine!.initWith(CannonNerves.object);
            this.unk1B8 = new CannonDom(this, this.mactor ? this.mactor.jointIndex('nullA') : -1);
            this.unk1B8.unk24 = 1;
        }
        // (unk1BC: hodai_mario.bmd on joint 0, only shown while unk238)
    }
    reset() {
        super.reset();
        this.resetHitPoints();
        this.onHitFilter(HF.NO_COLLISION);
        this.unk214 = 1;
        this.headHeight = 40;
        this.onLiveFlag(LF.UNK10);
        this.unk2AC = this.rot.y;
        if (this.unk230 === 9) { this.unk239 = 0; this.setGoalPath(new PathNode(null, new V3(-565, 8500, 7675))); }
    }
    isCollidMove(_a: HitActor) { return false; }
    isInhibitedForceMove() { return true; }
    isHitVallid(_m: number) { return false; }
    /** getModel()->getAnmMtx(j) (the base TR matrix for -1) */
    getAnmMtx(j: number): Mtx {
        if (j < 0) return this.baseTR;
        if (!this.anm[j]) this.anm[j] = m4ToMtx(this.mactor ? this.mactor.anmMtx(j, this.baseTR, this.scale) : null);
        return this.anm[j];
    }
    /** the model's calc (after its root matrix, in its CalcAnim) */
    private calcAnm() {
        const all = this.mactor ? this.mactor.anmMtxAll(this.baseTR, this.scale) : null;
        this.anm = all ? all.map((m) => m4ToMtx(m)) : [];
    }
    moveObject() {
        super.moveObject();
        if (this.unk230 !== 5 && this.unk230 !== 9) return;
        const c = this.unk1A8!;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) c.pos.set(this.pos);
        else { const m = this.getAnmMtx(Cannon.mChorobeiJntIdx[0]); c.pos.set(m[3], fr(m[7] - 100), m[11]); }
        c.checkHit();
        const vy = this.vel.y;
        this.pos.y = fr(this.pos.y + vy);
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.pos.y < this.unk23C.y) { this.vel.set(0, 0, 0); this.pos.y = this.unk23C.y; }
        this.updateAttachPos();
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.actorType === (AT.MARE_CORK | 0) && msg === MSG.TAKE && !this.holder) { this.holder = sender as any; return true; }
        return msg === MSG.SPRAYED_BY_WATER;
    }
    calcObjCollision() {
        const xz = [1, -1, 1, 1, -1, 1, -1, -1];
        this.headHeight = 50;
        const p = this.pos.clone();
        p.y = this.getAnmMtx(4)[7];
        for (let i = 0; i < 4; i++) {
            const c = this.unk25C[i];
            c.set(p);
            c.x = fr(c.x + fr(200 * xz[2 * i]));
            c.z = fr(c.z + fr(200 * xz[2 * i + 1]));
        }
    }
    /** setVertexData(0 / 1): into the move grid (TMap::perform empties it every tick) */
    entryObjCollision() {
        const c = this.unk25C, v = (p: V3) => [p.x, p.y, p.z];
        const set = (d: BGCheckData, a: V3, b: V3, e: V3) => { d.bgType = 0; d.data = 0; d.actor = null; d.setVertex(v(a), v(b), v(e)); this.world.col.add(d, 'move'); };
        set(this.unk258[0], c[2], c[1], c[0]);
        set(this.unk258[1], c[0], c[3], c[2]);
    }
    perform(cue: number) {
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.UNK200 | LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) this.calcAnm();
        // (unk238: hodai_mario and its particles; never set here)
        if (this.unk230 === 5 || this.unk230 === 9) {
            this.unk1A8!.perform(cue);
            // (CUE_ENTRY in TNerveCannonDamage: the damage fog)
            for (let i = 0; i < this.unk1AC.length; i++) {
                const d = this.unk1AC[i];
                if (d.unk24) continue;
                if (cue === CUE_MOVE) {
                    const dist = this.unk28C.mSLBombDist;
                    if (dist * dist < this.distToMarioSq && this.unk230 === 5) {
                        d.unk2C = this.unk224[i];
                        if (i !== this.unk214 && this.spine!.current !== CannonNerves.object) {
                            d.unk30 = fr(d.unk30 + 1);
                            if (d.unk30 > 360) d.unk30 = fr(d.unk30 - 360);
                            d.unk28 = fr((i === 2 ? -10 : -20) * MsSin(fr(0.5 * d.unk30)));
                        }
                    } else {
                        d.unk30 = 0;
                        d.unk28 = fr(d.unk28 * fr(0.99));
                        this.unk1C0[i].moveMat4(mtxToM4(d.getConnectedMtx()));
                    }
                }
                d.perform(cue);
            }
        } else if (this.unk1B8 && !this.unk1B8.unk24) this.unk1B8.perform(cue);
    }
    calcRootMatrix() {
        if (this.spine!.current !== CannonNerves.object) { this.calcObjCollision(); this.entryObjCollision(); }
        if (this.holder) {
            const m = this.holder.getTakingMtx();
            if (m) {
                if (this.spine!.current === CannonNerves.object) { this.baseTR.set(m); this.pos.set(m[3], m[7], m[11]); }
                else {
                    if (this.world.demoMode) this.rot.y = -80;
                    this.pos.set(m[3], m[7], m[11]);
                    MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
                }
            }
        } else SpineEnemy.prototype.calcRootMatrix.call(this);
        const c = this.unk1A8;
        if (c && c.mactor.checkCurBckFromIndex(BCK_TYORO_DOWN) && c.mactor.getFrameCtrl(ANM_BCK)!.checkPass(2)) {
            for (const d of this.unk1AC) {
                const m = d.getConnectedMtx();
                this.unk294.set(m[3], m[7], m[11]);
                d.setBckAnm(BCK_DOM_BREAK);
                // (the hip drop particles)
            }
        }
    }
    getTakingMtx() {
        const c = this.unk1A8!;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) return c.model.baseTR;
        const y = c.model.anmMtx(Cannon.mChorobeiHandJntIdx[0])[7];
        const m = this.unk1E4;
        m.set(mtx());
        m[3] = c.pos.x; m[7] = y; m[11] = c.pos.z;
        return m;
    }
    /** bombSet: a Bob-omb, a Pokey head or a Strollin' Stu into the mole's hand */
    bombSet() {
        const value = rangeRand(0, 1);
        const rate = this.unk28C.mSLBombHeiGenerateRate;
        this.unk21C = 0;
        this.unk1A4 = null;
        const C = this.world.conductor;
        let a: SpineEnemy | null;
        if (value < rate) a = C.makeOneEnemyAppear(this.pos, 'ボム兵マネージャー', 1);
        else if (rangeRandI(0, 100) % 2 === 1) {
            a = C.makeOneEnemyAppear(this.pos, 'ポポマネージャー', 1);
            if (a) (a as any).thrownByChorobei();
        } else a = C.makeOneEnemyAppear(this.pos, 'ハムクリマネージャー', 1);
        if (!this.unk1A4) {
            this.unk1A4 = a;
            if (a) { (a as SmallEnemy).reset(); a.mactor!.setFrameRate(0, ANM_BCK); }
        }
        const b = this.unk1A4;
        if (b) {
            b.pos.set(this.unk1A8!.pos);
            this.unk220 = b.scale.x;
            b.scale.set(0, 0, 0);
            b.rot.set(this.rot);
            if (b.receiveMessage(this, MSG.TAKE)) this.held = b;
        }
    }
    bombShoot() {
        const b = this.unk1A4;
        if (!b) return;
        const m = this.world.mario.pos;
        const dir = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
        if (dir.x === 0 && dir.z === 0) dir.x = 1;
        msVecNormalize(dir, dir);
        // (a rotation by a random -30..30 the game makes and doesn't use)
        rangeRand(-30, 30);
        const speed = this.unk28C.mSLThrowXZSpeed;
        dir.y = speed; dir.x = fr(dir.x * speed); dir.z = fr(dir.z * speed);
        if (this.unk21C) { b.vel.set(dir.x, dir.y, dir.z); b.offLiveFlag(LF.UNK10); }
        else { b.vel.set(dir); b.onLiveFlag(LF.AIRBORNE); b.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK); }
        b.pos.y = fr(b.pos.y + 2);
        b.receiveMessage(this, MSG.PUT);
    }
    bombScaleUp() {
        const b = this.unk1A4;
        if (!b) return;
        const add = fr(0.2 * this.unk220);
        b.scale.x = MsClamp(fr(b.scale.x + add), 0, this.unk220);
        b.scale.setAll(this.scale.x);   // (the cannon's scale: the game's)
    }
    hitHead(b: BombHei) {
        if (this.spine!.current !== CannonNerves.damage && b.isDamageToCannon()) { this.spine!.pushNerve(CannonNerves.damage); b.kill(); }
    }
    updateAttachPos() {
        const a = this.unk1A0;
        if (!a) return;
        a.pos.set(V3.add(this.unk194, this.unk1A8!.pos));
        a.offLiveFlag(LF.AIRBORNE);
        if (this.spine!.current === CannonNerves.close) { a.kill(); this.unk1A0 = null; return; }
        if (!a.doKeepDistance()) { this.unk1A0 = null; this.spine!.pushNerve(CannonNerves.damage); }
    }
    killerShoot() {
        const C = this.world.conductor;
        if (this.unk239) {
            const k = C.makeOneEnemyAppear(this.pos, 'キラーマネージャー', 0) as any;
            if (!k) return;
            k.reset();
            const dm = this.unk1AC[this.unk214].model.anmMtx(1);
            const t = mtx(); t[3] = 0; t[7] = -60; t[11] = 150;
            MTXConcat(dm, t, t);
            k.pos.set(t[3], t[7], t[11]);
            const mv = marioVel(this.world);
            const speedX = mv.x, speedZ = mv.z;
            const goal = this.world.mario.pos.clone();
            goal.x = fr(goal.x + rangeRand(-300, 300));
            if (this.unk214 === 0) goal.z = fr(goal.z - fr(2 * Math.abs(rangeRand(-300, 300))));
            else if (this.unk214 === 2) goal.z = fr(goal.z + fr(2 * Math.abs(rangeRand(-300, 300))));
            let v = k.calcVelocityToJumpToY(goal, 5, k.getGravityY());
            const time = Math.abs(fr(msVecMag(V3.sub(goal, this.pos)) / fr(v.x * Cannon.mVelocityRate)));
            k.unk1A5 = 0;
            let rate = Cannon.mVelocityRate;
            if (rangeRandI(0, 100) % 5 === 0) k.unk1A5 = 1;
            else {
                if (mv.x > 2) rate = fr(0.55);
                if (mv.x < -2) rate = fr(0.68);
            }
            const pred = new V3(fr(goal.x + fr(Cannon.mSearchRate * fr(speedX * time))), goal.y, fr(goal.z + fr(Cannon.mSearchRate * fr(speedZ * time))));
            v = k.calcVelocityToJumpToY(pred, 5, k.getGravityY());
            v.scale(rate);
            k.rot.set(0, MsWrap(MsGetRotFromZaxisY(v), 0, 360), 0);
            k.scale.set(0.1, 0.1, 0.1);
            // (TMarDirector STATE_UNK1: slower and bigger)
            if (k.setColorType) k.setColorType();
            k.unk1A8 = v.clone();
            k.vel.set(v);
            k.onLiveFlag(LF.AIRBORNE);
            const d = V3.sub(this.world.mario.pos, this.pos);
            goal.x = fr(goal.x + d.x); goal.z = fr(goal.z + d.z);
            k.setGoalPath(new PathNode(null, goal));
            this.world.sound(SE.EN_KILLER_FIRE, k.pos);
            this.world.sound(SE.EN_KILLER_FLY, k.pos);
        } else {
            const g = C.makeOneEnemyAppear(this.pos, 'イガイガマネージャー', 1) as any;
            if (!g) return;
            g.reset();
            const dm = this.unk1AC[this.unk214].model.anmMtx(1);
            const t = mtx(); t[3] = 0; t[7] = -60; t[11] = 150;
            MTXConcat(dm, t, t);
            g.pos.set(t[3], t[7], t[11]);
            // (the PARTICLE_MS_IGA_FUMI_AIR particle)
            const goal = g.tracer.graph.point(0);
            this.unk248.set(goal);
            const v = g.calcVelocityToJumpToY(goal, 10, g.getGravityY());
            g.rot.set(this.rot);
            g.shoot(v);
        }
    }
    endKillerShoot() { this.unk214++; if (this.unk214 >= 3) this.unk214 = 0; }
    damage() {
        this.setFreezeAnm();
        const c = this.unk1A8!;
        c.setBckAnm(BCK_TYORO_DAMAGE);
        const m = c.model.anmMtx(0);
        this.unk294.set(m[3], m[7], m[11]);
        // (the smoke particle)
    }
    setKillerGoalPoint() {
        if (this.unk239) {
            const a = s16(Math.trunc(rangeRand(0, 360000)));
            const g = this.world.mario.pos.clone();
            g.x = fr(g.x + fr(500 * JMASCos(a)));
            g.z = fr(g.z + fr(500 * JMASSin(a)));
            this.setGoalPath(new PathNode(null, g));
        } else this.setGoalPath(new PathNode(null, this.unk248.clone()));
        this.unk1AC[this.unk214].setBckAnm(BCK_DOM_SHOOT);
    }
    deadCannon() { this.onHitFilter(HF.NO_COLLISION); this.unk1A8!.onHitFilter(HF.NO_COLLISION); }
    turnToGoal() { this.walkToCurPathNode(0, this.turnSpeed, 0); }
    isObject() { return this.isBckAnm(BCK_CANNON_DOWN) && this.checkCurAnmEnd(ANM_BCK); }
    killShootAct() { if (this.unk1A4) this.unk1A4.kill(); }
    gateOpen() {
        const g = this.unk254;
        if (!g) return;
        if (g.checkLiveFlag(LF.DEAD)) {
            g.appear();
            g.pos.set(this.pos);
            g.scale.set(0.27, 0.02, 0.27);
            if (g.mactor) g.mactor.setAnimation('maregate', ANM_BTK);
        }
        g.scale.y = MsClamp(fr(g.scale.y * fr(1.01)), 0, 0.22);
    }
}
/** TMarDirector::mState == STATE_UNK1 (not modelled) */
const DIRECTOR_STATE_UNK1 = false;

/** MsVECMag2 (TODO: the game's is the raw frsqrte estimate, see tobipuku.ts's msVecMag2) */
const msVecMag = (v: V3) => fr(Math.sqrt(fr(fr(fr(v.x * v.x) + fr(v.y * v.y)) + fr(v.z * v.z))));
/** SMS_GetMarioSpeedX / Z: his mVel */
function marioVel(w: World): V3 { const m = w.mario as any; return (typeof m.mStatus === 'number' ? m.mVel : m.vel) as V3; }

// ---------------------------------------------------------------- nerves
type S = Spine<Cannon>;
export const CannonNerves: Record<string, any> = {};
CannonNerves.open = nerve<Cannon>('TNerveCannonOpen', (spine: S) => {
    const self = spine.body, c = self.unk1A8!;
    if (spine.time === 0) { c.setBckAnm(BCK_TYORO_APPEAR); self.setBckAnm(BCK_CANNON_OPEN); }
    if (c.isUpEnd() && self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(CannonNerves.search); return true; }
    return false;
});
CannonNerves.search = nerve<Cannon>('TNerveCannonSearch', (spine: S) => {
    const self = spine.body, c = self.unk1A8!, P = self.unk28C;
    self.updateSquareToMario();
    const bomb0 = P.mSLBombDist, d2 = self.distToMarioSq;
    if (spine.time === 0) {
        if (d2 < bomb0 * bomb0) self.setGoalPath(new PathNode(self.world.mario));
        c.setBckAnm(BCK_TYORO_SEARCH);
    }
    if (c.mactor.curAnmEndsNext(ANM_BCK) && c.mactor.checkCurBckFromIndex(BCK_TYORO_SEARCH)) c.setBckAnm(BCK_TYORO_WAIT);
    const hide = P.mSLHideDist;
    if (d2 < hide * hide) { spine.pushAfterCurrent(CannonNerves.close); return true; }
    const bomb = P.mSLBombDist;
    if (d2 < bomb * bomb) {
        if (spine.time > P.mSLBombInterval) { self.unk290 = 1; spine.pushAfterCurrent(CannonNerves.shoot); return true; }
    } else if (self.unk230 === 5 || self.unk230 === 9) {
        const k = P.mSLKillerDist;
        if (d2 < k * k && spine.time > P.mSLShootInterval) {
            self.unk290 = 0;
            spine.pushAfterCurrent(CannonNerves.search);
            spine.pushAfterCurrent(CannonNerves.forceBombShoot);
            spine.pushAfterCurrent(CannonNerves.shoot);
            spine.pushAfterCurrent(CannonNerves.shoot);
            spine.pushAfterCurrent(CannonNerves.shoot);
            return true;
        }
    }
    if (self.unk2AC !== self.rot.y) { self.unk2AC = self.rot.y; self.world.sound(SE.EN_CANNON_MOVE, self.pos); }
    // TODO: area 5 in the director's STATE_UNK1 faces Mario directly (MsGetRotFromZaxis(SMS_DistanceFromMarioVec).y); taken as never
    if (self.unk230 === 5 && DIRECTOR_STATE_UNK1) self.rot.y = MsGetRotFromZaxis(V3.sub(self.world.mario.pos, self.pos)).y;
    else self.turnToGoal();
    return false;
});
/** the mole's throw (Shoot with unk290, ForceBombShoot) */
function throwStep(self: Cannon): boolean {
    const c = self.unk1A8!, a = c.mactor;
    if (a.checkCurBckFromIndex(BCK_TYORO_PICK)) {
        if (a.curAnmEndsNext(ANM_BCK)) { c.setBckAnm(BCK_TYORO_THROW); self.bombSet(); }
        self.turnToGoal();
    } else if (a.checkCurBckFromIndex(BCK_TYORO_THROW)) {
        if (a.curAnmEndsNext(ANM_BCK)) return true;
        const fc = a.getFrameCtrl(ANM_BCK)!;
        if (fc.checkPass(38)) self.bombShoot();
        if (fc.frame > 26) self.bombScaleUp();
    }
    return false;
}
CannonNerves.shoot = nerve<Cannon>('TNerveCannonShoot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { if (!self.unk290) self.setKillerGoalPoint(); else self.unk1A8!.setBckAnm(BCK_TYORO_PICK); }
    if (self.unk290) {
        if (throwStep(self)) { spine.pushAfterCurrent(CannonNerves.search); return true; }
    } else {
        if (spine.time < 40) self.turnToGoal();
        if (spine.time === 40) self.killerShoot();
        if (spine.time > self.unk28C.mSLKillerInterval) { self.endKillerShoot(); return true; }
    }
    return false;
});
CannonNerves.forceBombShoot = nerve<Cannon>('TNerveCannonForceBombShoot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const d = self.unk28C.mSLBombDist;
        if (self.distToMarioSq < 2 * (d * d)) self.unk1A8!.setBckAnm(BCK_TYORO_PICK);
        else return true;
    }
    return throwStep(self);
});
CannonNerves.close = nerve<Cannon>('TNerveCannonClose', (spine: S) => {
    const self = spine.body, c = self.unk1A8!;
    if (spine.time < 2) {
        self.deadCannon();
        c.setBckAnm(BCK_TYORO_HIDE);
        self.unk294.set(self.pos); self.unk294.y = fr(self.unk294.y + 300);
        // (the sweat particle)
    }
    if (c.isDownEnd() && !self.isBckAnm(BCK_CANNON_CLOSE)) self.setBckAnm(BCK_CANNON_CLOSE);
    if (self.isBckAnm(BCK_CANNON_CLOSE) && self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(10)) {
        self.unk294.set(self.pos); self.unk294.y = fr(self.unk294.y + 290);
        // (the dust particle)
    }
    self.updateSquareToMario();
    let hide = self.unk28C.mSLHideDist;
    hide = fr(hide * 3); hide = fr(hide * hide);
    if (self.distToMarioSq > hide) {
        self.offHitFilter(HF.NO_COLLISION);
        c.offHitFilter(HF.NO_COLLISION);
        spine.pushAfterCurrent(CannonNerves.open);
        return true;
    }
    self.unk2B0!.moveMat4(mtxToM4(self.getAnmMtx(4)));
    return false;
});
CannonNerves.damage = nerve<Cannon>('TNerveCannonDamage', (spine: S) => {
    const self = spine.body, c = self.unk1A8!;
    if (spine.time === 0) {
        // (the explosion particles)
        self.decHitPoints();
        if (self.hitPoints === 0) {
            self.killShootAct();
            c.setBckAnm(BCK_TYORO_DAMAGE);
            // (rumble, smoke, the demo camera tyorocam_pinna / tyorocam_mare)
            if (self.world.map === 5) { self.unk2A0.set(self.pos); self.unk2A0.y = 0; }
            self.deadCannon();
        } else self.damage();
        self.vel.set(0, 4, 0);
        self.onLiveFlag(LF.AIRBORNE);
        self.pos.y = fr(self.pos.y + 10);
    }
    if (c.mactor.curAnmEndsNext(ANM_BCK)) {
        spine.pushAfterCurrent(self.hitPoints === 0 ? CannonNerves.damageDemo : CannonNerves.search);
        return true;
    }
    return false;
});
CannonNerves.damageDemo = nerve<Cannon>('TNerveCannonDamageDemo', (spine: S) => {
    const self = spine.body, c = self.unk1A8!;
    if (spine.time === 0) c.setBckAnm(BCK_TYORO_DOWN);
    if (spine.time > 120 && c.mactor.curAnmEndsNext(ANM_BCK) && !self.isBckAnm(BCK_CANNON_DOWN)) {
        self.setBckAnm(BCK_CANNON_DOWN);
        self.world.sound(SE.EN_CANNON_DOWN, self.pos);
        const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト爆発マネージャー', 1) as any;
        if (e && e.generate) e.generate(self.pos, new V3(2.5, 2.5, 2.5));
        self.world.flags.setBool(true, MSF.MONTY_MOLE_DEFEATED);
        spine.pushAfterCurrent(CannonNerves.object);
        return true;
    }
    return false;
});
CannonNerves.object = nerve<Cannon>('TNerveCannonObject', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (!self.isBckAnm(BCK_CANNON_DOWN)) {
            self.setBckAnm(BCK_CANNON_DOWN);
            const fc = self.mactor!.getFrameCtrl(ANM_BCK);
            if (fc) fc.frame = fc.end;
        }
        if (self.unk1A8) self.unk1A8.unk70 = 1;
    }
    if (self.isBckAnm(BCK_CANNON_DOWN) && self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(60)) self.world.sound(SE.EN_CANNON_LAND, self.pos);
    if (spine.time > 150) self.gateOpen();
    return false;
});

register('CannonManager', (w, n) => new CannonManager(w, n));
register('Cannon', (w, n) => new Cannon(w, n));
