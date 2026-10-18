// TNameKuri / TNameKuriManager (Enemy/namekuri.cpp): the goop blobs (ナメクリ) the goop
// launchers throw out. They crawl the graph (and up walls: TWalker's spider mode, TSpider),
// follow Mario when they see him, and in reach (mSLJumpAttackRadius) wind up and leap at him;
// a leap that lands bursts them. Water melts them; they live mSLAliveTime ticks, swelling
// their last 100. TDiffusionNameKuriManager is the same with diffusionnamekuri.prm.
// TNameKuriLauncher is the plain TLauncher that throws them out.

import { fr, V3, MsSin, MsCos, MsClamp, MsMtxSetRotRPH, mtx } from '../math.js';
import { World, PathNode, LF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, LiveManager, LiveActor, SpineEnemy } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, Walker, walkerParams } from './walker.js';
import { Launcher, LauncherManager } from './launcher.js';
import { resetSRTV } from './generator.js';
import { register } from '../scene.js';
import type { BGCheckData, WallCheck } from '../collision.js';

/** TNameKuriSaveLoadParams */
const NAMEKURI_PARAMS = {
    mSLAliveTime: ['i', 2000], mSLLandHeight: ['f', 500], mSLJumpAttackGravity: ['f', 0.1], mSLJumpAttackSp: ['f', 20], mSLJumpAttackTurnSp: ['f', 2],
    mSLJumpPrepareFrame: ['i', 100], mSLJumpMaxFrame: ['f', 30], mSLJumpMaxAngle: ['f', 30], mSLJumpMaxScale: ['f', 0.2], mSLColorChangeRate: ['i', 25],
    mSLJumpAttackRadius: ['f', 400], mSLJumpAttackAngle: ['f', 180],
} as const;

const mExplosionSpeed = 1.2, mStopMinScaleFrame = 8;
const velocityMinY = -40;
/** nameKuriTevColorData (the body's TEV colours, a different one each time one appears) */
const TEV_COLORS = [[0x64, 0x0, 0xA, 0xA9], [0x0, 0x0, 0x64, 0xA9], [0x5D, 0x54, 0x0, 0xA9], [0x0, 0x4C, 0x10, 0xA9], [0x63, 0x4, 0x60, 0xA9], [0x0, 0x44, 0x75, 0xA9], [0x64, 0x28, 0x0, 0xA9]];

/** TSpider: the binder that walks up walls (TWalker's mode 1). */
export class Spider {
    unk4 = 0; unk8 = 0; unkC: BGCheckData | null = null; wallAttachRate = 0;
    bind(a: LiveActor) {
        const e = a as SpineEnemy, w = e.world;
        const delta = e.posDelta.clone();
        const n = e.pos.clone().add(delta);
        if (e.isAirborne()) {
            const v = e.vel.clone();
            n.add(v);
            v.y = fr(v.y - e.getGravityY());
            if (v.y < velocityMinY) v.y = velocityMinY;
            e.vel.set(v);
        }
        let [h, d] = w.checkGround(n.x, n.y + e.getHeadHeight(), n.z);
        h = fr(h + 1);
        if (e.pos.y - n.y > 0) {
            let [h2, d2] = w.checkGround(n.x, e.pos.y + e.getHeadHeight(), n.z);
            h2 = fr(h2 + 1);
            if (h2 > h) { d = d2; h = h2; }
        }
        if (d.isIllegal()) {
            if (this.unk4 <= 0) e.kill();
            else { n.y = e.pos.y; h = n.y; this.unk4 -= 1; }
        } else this.unk4 = 0x1E;
        if (n.y <= h) { n.y = h; e.vel.set(0, 0, 0); e.offLiveFlag(LF.AIRBORNE); e.offLiveFlag(LF.UNK8000); }
        else e.onLiveFlag(LF.AIRBORNE);
        e.groundHeight = h; e.groundPlane = d;
        const r: WallCheck = { center: [n.x, n.y + e.getHeadHeight(), n.z], radius: e.wallRadius, maxResults: 1, flags: 0, results: [] };
        const touched = w.isTouchedWallsAndMoveXZ(r);
        const c = new V3(r.center[0], r.center[1], r.center[2]);
        // (f29 is left unset when a wall is touched from behind: taken as 0)
        let lift = 0;
        if (!touched) {
            if (this.unk8 > 0) {
                this.unk8 -= 1;
                lift = e.marchSpeed;
                e.offLiveFlag(LF.AIRBORNE); e.offLiveFlag(LF.UNK8000);
                e.vel.set(0, 0, 0);
            } else { this.unkC = null; e.unk138 = null; lift = 0; }
            this.wallAttachRate = fr(this.wallAttachRate - 0.016666667);
            if (this.wallAttachRate < 0) this.wallAttachRate = 0;
        } else {
            const wall = r.results[0];
            const N = new V3(wall.n[0], wall.n[1], wall.n[2]);
            if (N.dot(delta) < 0) {
                lift = e.marchSpeed;
                e.offLiveFlag(LF.AIRBORNE); e.offLiveFlag(LF.UNK8000);
                e.vel.set(0, 0, 0);
                this.unkC = wall; e.unk138 = wall;
                this.unk8 = 0x3C;
                c.sub(N.scale(e.wallRadius * this.wallAttachRate));
                this.wallAttachRate = fr(this.wallAttachRate + 1 / 60);
                if (this.wallAttachRate > 1) this.wallAttachRate = 1;
            }
        }
        c.y = fr(c.y + lift - e.getHeadHeight());
        e.posDelta.set(V3.sub(c, e.pos));
    }
}
/** TWalker with setMode(1): binds through its TSpider. */
class SpiderWalker extends Walker {
    unk28 = 0; spider: Spider | null = null;
    setMode(m: number) { this.unk28 = m; if (this.unk28 === 1 && !this.spider) this.spider = new Spider(); }
    bind(a: LiveActor) { if (this.unk28 === 1 && this.spider) { this.spider.bind(a); return; } super.bind(a); }
}

export class NameKuriManager extends SmallEnemyManager {
    unk60 = 0;
    prm = '/enemy/namekuri.prm';
    constructor(w: World, name = 'ナメクリマネージャー') { super(w, name); this.unk5C = 0; }
    load(s: Stream) {
        this.saveParams = walkerParams(this.prm, this.world.files, NAMEKURI_PARAMS as any);
        super.load(s);
    }
    loadAfter() {
        super.loadAfter();
        // (TMapObjBaseManager::newAndRegisterObj("bottle_short"): the water bottle it can leave, not modelled)
    }
    createModelData() { this.createModelDataArray(['name.bmd']); }
    createEnemyInstance(): SmallEnemy { return new NameKuri(this.world); }
    initSetEnemies() {
        // (the brain model each carries (TSharedParts, brain.bmd) and its TEV colours: only drawn)
        let ci = 0;
        for (const o of this.objs as NameKuri[]) { o.unk1C4 = TEV_COLORS[ci].slice(); if (++ci >= 7) ci = 0; }
    }
    getNextColorIdx() { this.unk60 += 1; if (this.unk60 >= 7) this.unk60 = 0; return this.unk60; }
}
export class DiffusionNameKuriManager extends NameKuriManager {
    constructor(w: World, name = '拡散ナメクリマネージャー') { super(w, name); this.prm = '/enemy/diffusionnamekuri.prm'; }
    createEnemyInstance(): SmallEnemy { return new NameKuri(this.world, '拡散ナメクリ'); }
}

export class NameKuri extends WalkerEnemy {
    /** ticks alive */
    unk194 = 0;
    /** killed by something not water (it may leave a bottle) */
    unk198 = 0;
    unk1A4: any = null;
    /** on a wall */
    unk1A8 = false;
    unk1AC = 0; unk1B0 = 1; unk1B4 = 0; unk1B8 = 0;
    unk1BC = [0, 0, 0, 168]; unk1C4 = [0, 0, 0, 0];
    constructor(w: World, name = 'ナメクリ') { super(w, name); }
    get NP(): any { return this.unk1A4; }
    get spiderWalker() { return this.binder as SpiderWalker; }
    init(m: LiveManager | null) {
        super.init(m);
        this.binder = new SpiderWalker();   // (TWalkerEnemy::init's TWalker, with its mode)
        this.walker.reset();
        this.walker.unk18 = 150;
        this.onHitFilter(HC.MAP_OBJECT);
        this.actorType = AT.NAME_KURI;
        this.unk150 = 0x3A;
        this.spiderWalker.setMode(1);
        this.unk130 = 2;
        this.unk1A4 = this.getSaveParam();
        // (the joint callbacks: the leap's tilt and the hit-water squash, only drawn)
        this.unk1BC = [0, 0, 0, 168];
        if (!this.tracer.graph || this.tracer.graph.isDummy()) this.tracer.graph = this.world.graphByName('main');
    }
    calcRootMatrix() {
        if (this.isEaten()) return;
        const m = this.baseTR;
        this.unk1A8 = false;
        const sp = this.spiderWalker.spider;
        if (sp && sp.wallAttachRate > 0 && this.unk138) {
            this.unk1A8 = true;
            let up = new V3(0, 1, 0);
            const N = new V3(this.unk138.n[0], this.unk138.n[1], this.unk138.n[2]);
            const a = new V3().cross(N, up).normalize();
            up = new V3().cross(a, N).normalize();
            m[0] = a.x; m[4] = a.y; m[8] = a.z;
            m[1] = N.x; m[5] = N.y; m[9] = N.z;
            m[2] = up.x; m[6] = up.y; m[10] = up.z;
            m[3] = 0; m[7] = 0; m[11] = 0;
            const ang = (1 - sp.wallAttachRate) * 90;
            const r = mtx(); MsMtxSetRotRPH(r, ang, 0, 0);   // MsMtxSetRotX
            const out = new Float64Array(12);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = m[i * 4] * r[j] + m[i * 4 + 1] * r[4 + j] + m[i * 4 + 2] * r[8 + j];
            m.set(out);
        } else {
            let f = new V3(MsSin(this.rot.y), 0, MsCos(this.rot.y));
            const g = this.groundPlane;
            const N = new V3(g.n[0], g.n[1], g.n[2]);
            const a = new V3().cross(N, f).normalize();
            f = new V3().cross(a, N).normalize();
            m[0] = a.x; m[4] = a.y; m[8] = a.z;
            m[1] = N.x; m[5] = N.y; m[9] = N.z;
            m[2] = f.x; m[6] = f.y; m[10] = f.z;
        }
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
    }
    moveObject() {
        super.moveObject();
        const c = this.spine!.current, NP = this.NP;
        if (this.vel.y < 0 && (c === WalkerNerves.graphWander || c === WalkerNerves.escape) && this.pos.y - this.groundHeight > NP.mSLLandHeight) this.spine!.pushNerve(NameKuriNerves.land);
        if (!this.checkLiveFlag(LF.HIDDEN)) {
            ++this.unk194;
            const alive = NP.mSLAliveTime;
            if (this.unk194 + 100 > alive && this.scale.x < this.bodyScale * 2) {
                const s = fr(this.scale.z * 1.01);
                this.scale.set(s, s, s);
            }
            if (this.unk194 > alive) this.kill();
        }
    }
    setBehavior() { }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c !== SmallEnemyNerves.hitWaterJump && c !== SmallEnemyNerves.die && c !== NameKuriNerves.explosion) {
            this.spine!.pushNerve(SmallEnemyNerves.die);
            if (!this.isAirborne()) this.onLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
            this.onLiveFlag(LF.UNK20000);
        }
    }
    getGravityY() {
        if (this.checkLiveFlag(LIVE_FLAG_MELT_ON_DEATH)) return 0.01;
        if (this.spine!.current === NameKuriNerves.jumpAttack) return this.NP.mSLJumpAttackGravity;
        return this.gravity;
    }
    setGenerateAnm() { this.setBckAnm(5); this.vel.set(0, 0, 0); }
    setWalkAnm() { this.setBckAnm(7); }
    setDeadAnm() {
        this.setBckAnm(0);
        this.world.effect('namekuriDead', this.pos, this.scale);
        this.vel.set(0, 0, 0);
        this.onLiveFlag(LF.UNK10);
    }
    setAfterDeadEffect() {
        // (a small water bottle when Mario's tank is under half: the item isn't modelled)
        if (this.unk198) this.world.effect('bottleShort', this.pos);
    }
    setWaitAnm() { this.setBckAnm(6); }
    setMeltAnm() {
        this.setBckAnm(1);
        this.world.effect('namekuriMelt', this.pos, this.scale);
        this.vel.set(0, 0, 0);
        this.onLiveFlag(LF.UNK10);
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('name.bmd'); }
    reset() {
        super.reset();
        this.unk1B0 = 1;
        this.unk1B4 = rangeRand(0, 360);
        this.unk194 = 0;
        this.unk198 = 0;
        this.vel.set(0, 0, 0);
        this.scale.set(this.bodyScale, this.bodyScale, this.bodyScale);
        this.unk1BC = [0, 0, 0, 0];
        const man = this.manager as NameKuriManager | null;
        if (man && man.getNextColorIdx) this.unk1C4 = TEV_COLORS[man.getNextColorIdx()].slice();
        this.offLiveFlag(LF.UNK10);
    }
    attackToMario() {
        this.world.mario.receiveMessage(this, MSG.ATTACK);
        if (this.spine!.current === NameKuriNerves.jumpAttack) { this.vel.set(0, 0, 0); this.onLiveFlag(LF.UNK20000); this.kill(); }
    }
    behaveToFindMario() { this.spine!.pushAfterCurrent(WalkerNerves.graphWander); this.spine!.pushAfterCurrent(NameKuriNerves.followMario); }
    endHitWaterJump() { this.scale.set(this.bodyScale, this.bodyScale, this.bodyScale); }
    isAttackJump() { return this.spine!.current === NameKuriNerves.jumpAttack && this.pos.y > this.groundHeight + 5 && !this.unk1A8; }
    isHitWaterJump() { return this.spine!.current === SmallEnemyNerves.hitWaterJump; }
    isHitValid(msg: number) {
        this.unk198 = 1;
        if (msg === MSG.SPRAYED_BY_WATER) this.unk198 = 0;
        return !this.checkLiveFlag(LF.HIDDEN);
    }
    isCollidMove(a: HitActor) {
        if (a.getHitCategory() === (HC.MAP_OBJECT | 0)) {
            if (this.spine!.current === NameKuriNerves.jumpAttack) this.kill();
            return true;
        }
        return !(a as any).isAirborne?.() && !this.isAirborne();
    }
    switchNextGoalPath() { if (this.goalStack.length) this.goal = this.goalStack.pop()!; }
}

type S = Spine<NameKuri>;
export const NameKuriNerves: Record<string, any> = {};
NameKuriNerves.land = nerve<NameKuri>('TNerveNameKuriLand', (spine: S) => {
    const self = spine.body;
    if (self.isBckAnm(4)) { if (self.checkCurAnmEnd(ANM_BCK)) return true; }
    else if (!self.isAirborne()) self.setBckAnm(4);
    return false;
});
NameKuriNerves.jumpAttack = nerve<NameKuri>('TNerveNameKuriJumpAttack', (spine: S) => {
    const self = spine.body, m = self.world.mario;
    if (spine.time <= 1) {
        self.setGoalPath(new PathNode(m));
        self.unk1B0 = self.scale.y;
        self.unk1AC = 0; self.unk1B8 = 0;
    } else {
        const P = self.NP;
        if (self.isBckAnm(6)) {
            // (time > 1 here: always)
            if (spine.time > 0) self.setBckAnm(3);
            else self.walkToCurPathNode(0, P.mSLJumpAttackTurnSp, 0);
        } else if (self.isBckAnm(3)) {
            const fc = self.mactor!.getFrameCtrl(ANM_BCK);
            if (fc && fc.checkPass(62)) {
                const v = self.calcVelocityToJumpToY(m.pos.clone(), P.mSLJumpAttackSp, self.getGravityY());
                self.pos.y = fr(self.pos.y + 2);
                self.vel.set(v);
                self.onLiveFlag(LF.AIRBORNE);
                self.unk1AC = 0; self.unk1B8 = 0;
                self.setGoalPath(new PathNode(null, m.pos.clone()));
            }
            self.walkToCurPathNode(0, 6, 0);
            const rate = P.mSLColorChangeRate;
            if (self.getCurAnmFrameNo(ANM_BCK) > 62) {
                self.unk1B8 += 1;
                const c = MsClamp(((self.unk1BC[0] - rate) << 16) >> 16, 0, 255);
                self.unk1BC[0] = self.unk1BC[1] = self.unk1BC[2] = c;
            } else {
                const c = ((Math.trunc(Math.abs(MsSin(rate * spine.time)) * 255)) << 16) >> 16;
                self.unk1BC[0] = self.unk1BC[1] = self.unk1BC[2] = c;
            }
            if (self.isAirborne()) self.scale.x = self.unk1B0;
            if (!self.isAirborne() && self.checkCurAnmEnd(ANM_BCK)) self.setBckAnm(2);
        } else if (self.isBckAnm(2)) {
            if (self.checkCurAnmEnd(ANM_BCK)) {
                self.switchNextGoalPath();
                self.onLiveFlag(LF.UNK20000);
                spine.pushAfterCurrent(SmallEnemyNerves.die);
                return true;
            }
            const mx = P.mSLJumpMaxAngle;
            self.unk1AC = MsClamp(fr(self.unk1AC * 0.9), -mx, 0);
        }
    }
    return false;
});
NameKuriNerves.jumpAttackPrepare = nerve<NameKuri>('TNerveNameKuriJumpAttackPrepare', (spine: S) => {
    const self = spine.body, m = self.world.mario;
    if (spine.time === 1) { self.setGoalPath(new PathNode(m)); self.setBckAnm(6); }
    else if (self.isBckAnm(6)) {
        if (self.isInSight(m.pos.clone(), 100000, 30, 0) && !self.checkLiveFlag(LF.CLIPPED_OUT)) {
            if (!self.isAirborne() && !self.unk1A8) { spine.pushAfterCurrent(NameKuriNerves.jumpAttack); return true; }
        } else self.walkToCurPathNode(0, self.NP.mSLJumpAttackTurnSp, 0);
    }
    return false;
});
NameKuriNerves.explosion = nerve<NameKuri>('TNerveNameKuriExplosion', (spine: S) => {
    const self = spine.body;
    if (spine.time < mStopMinScaleFrame) { const s = fr(self.bodyScale * 0.5); self.scale.set(s, s, s); }
    else if (self.scale.x < self.bodyScale * 2) { const s = fr(self.scale.z * mExplosionSpeed); self.scale.set(s, s, s); }
    else return true;
    return false;
});
NameKuriNerves.diffuse = nerve<NameKuri>('TNerveNameKuriDiffuse', (spine: S) => !spine.body.isAirborne());
NameKuriNerves.drawPollute = nerve<NameKuri>('TNerveNameKuriDrawPollute', () => true);
NameKuriNerves.followMario = nerve<NameKuri>('TNerveNKFollowMario', (spine: S) => {
    const self = spine.body, m = self.world.mario;
    if (spine.time === 0) self.setGoalPath(new PathNode(m));
    self.walkToCurPathNode(self.marchSpeed, 3, 0);
    const P = self.NP;
    if (self.isInSight(m.pos.clone(), P.mSLJumpAttackRadius, P.mSLJumpAttackAngle, 0)) { spine.pushAfterCurrent(NameKuriNerves.jumpAttackPrepare); return true; }
    return false;
});

/** TNameKuriLauncher: a TLauncher throwing out ナメクリマネージャー's blobs. */
export class NameKuriLauncher extends Launcher {
    constructor(w: World, name = 'ナメクリランチャー') { super(w, name); }
    stateLaunch() {
        if (this.ticksInState === 0) {
            const e = this.getProperEnemy('ナメクリマネージャー');
            if (e) {
                const r = mtx(); MsMtxSetRotRPH(r, this.rot.x, this.rot.y, this.rot.z);
                const v = new V3(r[1] * 4, r[5] * 4, r[9] * 4);
                resetSRTV(e, this.pos, new V3(0, 0, 0), e.scale, v);
            }
        }
        if (this.anmEndsNext()) { this.resetLaunchTimer(); this.changeState(2); }
    }
}
export class NameKuriLauncherManager extends LauncherManager {
    constructor(w: World, name = 'ナメクリランチャーマネージャー') { super(w, name); }
}

register('NameKuriManager', (w, n) => new NameKuriManager(w, n));
register('NameKuri', (w, n) => new NameKuri(w, n));
register('DiffusionNameKuriManager', (w, n) => new DiffusionNameKuriManager(w, n));
register('NamekuriLauncher', (w, n) => new NameKuriLauncher(w, n));
register('NamekuriLauncherManager', (w, n) => new NameKuriLauncherManager(w, n));
