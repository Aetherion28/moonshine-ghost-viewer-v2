// TWalkerEnemy (Enemy/walkerEnemy.cpp) and its binder TWalker (Enemy/walker.cpp): enemies that
// walk the stage's graph, chase or flee Mario, and go round the walls they meet (the binder
// steers them along a wall it hasn't touched before, and jumps them out of pools).

import { fr, V3, MsSin, MsCos, frsqrte } from '../math.js';
import { World, LiveActor, LF, nerve, Spine, PathNode, ANM_BCK, PSchema, Files } from '../engine.js';
import { SmallEnemy, SmallEnemyNerves, smallParams, rangeRand as rangeRandF } from './smallEnemy.js';
import type { BGCheckData, WallCheck } from '../collision.js';
import { IGNORE_WATER_SURFACE } from '../collision.js';

/** TWalkerEnemyParams */
export const WALKER_PARAMS = { mSLZigzagCycle: ['f', 1000], mSLZigzagAngle: ['f', 30], mSLMarchSpeedLow: ['f', 0.8], mSLMarchSpeedHigh: ['f', 1.5] } satisfies PSchema;
export function walkerParams<S extends PSchema>(path: string, files: Files, more?: S) {
    const p: any = smallParams(path, files, { ...WALKER_PARAMS, ...(more || {}) });
    p.marchLow = p.mSLMarchSpeedLow; p.marchHigh = p.mSLMarchSpeedHigh;
    return p;
}

const velocityMinY = -40;
const isEnemyThrough = (d: BGCheckData) => d.bgType === 0x801 || d.bgType === 0x402;

function calcFarthestVertex(d: BGCheckData, p: V3, dir: V3) {
    const diffs = [d.p1, d.p2, d.p3].map((q) => new V3(q[0] - p.x, 0, q[2] - p.z));
    let first = true, f7 = 0;
    for (const v of diffs) if (v.dot(dir) > 0) { const s = v.squared(); if (first) { first = false; f7 = s; } else if (f7 < s) f7 = s; }
    // calcFarthestVertex (walker.cpp): "yet another copy of the standard sqrt but without the
    // newton iterations" -- the raw frsqrte estimate times f7, not a real sqrt.
    return first ? 0 : fr(f7 * fr(frsqrte(f7)));
}

/** TWalker: the walking binder. */
export class Walker {
    walls: BGCheckData[] = []; unk14 = 0; unk18 = 1; unk1C = 0; unk20 = 30; unk24 = 0; unk28 = 0; unk30 = 1;
    reset() { this.unk14 = 0; this.unk1C = 0; this.unk20 = 30; this.unk24 = 0; this.walls.length = 0; }
    bind(a: LiveActor) {
        const e = a as SmallEnemy, w = e.world;
        const lv = e.posDelta.clone();
        const n = e.pos.clone().add(lv);
        this.unk1C = 0;
        if (e.isAirborne()) {
            const v = e.vel.clone();
            n.add(v);
            v.y -= e.getGravityY();
            if (v.y < velocityMinY) v.y = velocityMinY;
            e.vel.set(v);
        }
        if (this.unk30 !== 0 || e.vel.y < 0) {
            const flags = e.checkLiveFlag(LF.UNK1000) ? IGNORE_WATER_SURFACE : 0;
            let [h, d] = w.col.checkGround(n.x, n.y + e.getHeadHeight(), n.z, flags);
            h = fr(h + 1);
            if (this.unk30 === 2 && e.pos.y - n.y > 0 && !d.isIllegal() && !isEnemyThrough(d)) {
                let [h2, d2] = w.col.checkGround(n.x, e.pos.y + e.getHeadHeight(), n.z, flags);
                h2 = fr(h2 + 1);
                if (h2 > h) { d = d2; h = h2; }
            }
            if (d.isIllegal()) {
                if (this.unk20 <= 0) { e.kill(); return; }
                n.y = e.pos.y; h = n.y; this.unk20 -= 1;
            } else this.unk20 = 30;
            if (n.y <= h + 0.05 && !d.isIllegal() && !isEnemyThrough(d)) {
                n.y = h; e.vel.set(0, 0, 0); e.offLiveFlag(LF.AIRBORNE); e.offLiveFlag(LF.UNK8000);
            } else e.onLiveFlag(LF.AIRBORNE);
            e.groundHeight = h; e.groundPlane = d;
        }
        const f31 = n.y;
        const r: WallCheck = { center: [n.x, n.y + e.getHeadHeight(), n.z], radius: e.wallRadius, maxResults: 4, flags: 0, results: [] };
        if (!w.isTouchedWallsAndMoveXZ(r)) { this.walls.length = 0; this.unk14 = 0; this.unk24 = 0; e.unk138 = null; }
        else {
            let wall: BGCheckData | null = null;
            for (const x of r.results) if (!this.walls.includes(x)) { wall = x; break; }
            if (!wall) this.unk24 += 1;
            else {
                e.unk138 = wall;
                if (!e.isAirborne() && wall.maxY - f31 <= this.unk18 && wall.isPool()) this.unk1C = 1;
                if (this.walls.length < 4) this.walls.push(wall);
                const N = new V3(wall.n[0], wall.n[1], wall.n[2]);
                const side = new V3().cross(N, new V3(0, 1, 0));
                side.y = 0; side.normalize();
                if (this.unk14 === 0) {
                    const a0 = lv.clone(); a0.y = 0;
                    if (a0.dot(side) > 0) this.unk14 = 2; else { side.scale(-1); this.unk14 = 1; }
                    let far = calcFarthestVertex(wall, e.pos, side);
                    let q = e.pos.clone().add(side.clone().scale(e.wallRadius * 2 + far));
                    const qp = { x: q.x, z: q.z };
                    if (w.isTouchedOneWallAndMoveXZ(qp, q.y + e.getHeadHeight(), e.wallRadius)) {
                        const back = side.clone().scale(-1);
                        far = calcFarthestVertex(wall, e.pos, back);
                        q = e.pos.clone().add(back.clone().scale(e.wallRadius * 2 + far));
                        const qp2 = { x: q.x, z: q.z };
                        if (!w.isTouchedOneWallAndMoveXZ(qp2, q.y + e.getHeadHeight(), e.wallRadius)) side.scale(-1);
                    }
                } else if (this.unk14 === 1) side.scale(-1);
                const far = calcFarthestVertex(wall, e.pos, side);
                const k = e.wallRadius * 2 + far;
                const goal = e.pos.clone().sub(N.clone().scale(e.wallRadius)).add(side.clone().scale(k));
                if (!e.goalStack.length) { e.pushGoal(e.goal); e.goal = new PathNode(null, goal); }
                else e.goal = new PathNode(null, goal);
            }
        }
        n.x = r.center[0]; n.z = r.center[2];
        e.posDelta.set(V3.sub(n, e.pos));
    }
}

export class WalkerEnemy extends SmallEnemy {
    get walker() { return this.binder as Walker; }
    get PW(): any { return this.getSaveParam(); }
    init(m: any) {
        super.init(m);
        this.binder = new Walker();
        this.walker.reset();
        this.walker.unk18 = 150;
        const P = this.PW;
        this.marchSpeed = rangeRandF(P.marchLow, P.marchHigh);
        this.spine!.initWith(WalkerNerves.generate);
    }
    moveObject() {
        if (!this.groundPlane.isIllegal() && (this.instanceIndex & 0xF) === (this.world.moveTickCount & 0xF)) this.doShortCut();
        super.moveObject();
        if (this.walker.unk1C && this.spine!.current !== SmallEnemyNerves.jump) {
            const f = this.PW.marchHigh;
            this.vel.x = fr(f * MsSin(this.rot.y)); this.vel.z = fr(f * MsCos(this.rot.y));
            this.spine!.pushNerve(SmallEnemyNerves.jump);
            this.onLiveFlag(LF.AIRBORNE);
            this.pos.y += 5;
        }
    }
    attackToMario() {
        this.sendAttackMsgToMario();
        const c = this.spine!.current;
        if (c !== SmallEnemyNerves.jump && c !== SmallEnemyNerves.die && c !== WalkerNerves.generate) {
            this.spine!.pushNerve(WalkerNerves.postAttack);
            this.spine!.pushNerve(SmallEnemyNerves.jump);
        }
    }
    reset() {
        this.tracer.reset2(); this.tracer.reset();
        super.reset();
        const P = this.PW;
        this.marchSpeed = rangeRandF(P.marchLow, P.marchHigh);
        if (this.binder) this.walker.reset();
        this.spine!.reset();
        this.spine!.setNext(this.spine!.default);
        this.setGoalPath(new PathNode(this.world.mario));
    }
    walkBehavior(kind: number, k: number) {
        const f = k * this.unk158, P = this.PW;
        switch (kind) {
            case 0: this.zigzagToCurPathNode(this.marchSpeed * f, this.turnSpeed * f, P.mSLZigzagCycle, P.mSLZigzagAngle); break;
            case 1: case 2: this.walkToCurPathNode(this.marchSpeed * f, this.turnSpeed * f, 0); break;
            case 3: this.walkToCurPathNode(0, this.turnSpeed * f, 0); break;
            case 4: this.walkToCurPathNode(this.marchSpeed * f, 0, 0); break;
        }
    }
    behaveToFindMario() {
        const s = this.spine!;
        if (this.unk150 & 2) { s.pushAfterCurrent(WalkerNerves.graphWander); s.pushAfterCurrent(WalkerNerves.escape); s.pushAfterCurrent(SmallEnemyNerves.jump); }
        else { this.setGoalPath(new PathNode(this.world.mario)); s.pushAfterCurrent(WalkerNerves.graphWander); s.pushAfterCurrent(WalkerNerves.attack); s.pushAfterCurrent(SmallEnemyNerves.jump); }
    }
    isResignationAttack() { return V3.sub(this.goal104.point(), this.pos).length() > this.PW.mSLGiveUpLength; }
    isReachedToGoalXZ() {
        const t = V3.sub(this.goal104.point(), this.pos); t.y = 0;
        if (t.x === 0 && t.z === 0) return true;
        return t.length() < 100;
    }
    initialGraphNode() { this.tracer.reset(); this.goToShortestNextGraphNode(); }
}

type S = Spine<WalkerEnemy>;
const marioHidden = (e: WalkerEnemy) => { const m = e.world.mario; return m.checkFlag(0x2) || m.checkFlag(0x10000) || m.groundPlane.isWaterSurface() || m.checkFlag(0x20000); };
export const WalkerNerves: Record<string, any> = {};
WalkerNerves.generate = nerve<WalkerEnemy>('TNerveWalkerGenerate', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setGenerateAnm();
    else if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
    return false;
});
WalkerNerves.graphWander = nerve<WalkerEnemy>('TNerveWalkerGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setWalkAnm(); self.initialGraphNode(); }
    if (self.isReachedToGoal()) self.goToRandomNextGraphNode();
    if (self.isFindMario(1)) { self.behaveToFindMario(); return true; }
    self.walkBehavior(0, 1);
    return false;
});
WalkerNerves.attack = nerve<WalkerEnemy>('TNerveWalkerAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setRunAnm();
    if (self.goal.actor === self.world.mario) {
        if (marioHidden(self)) return true;
        if (Math.trunc(Math.abs(self.world.mario.pos.y - self.pos.y)) > self.PW.mSLGiveUpHeight) return true;
    }
    self.walkBehavior(2, 3);
    return self.isResignationAttack();
});
WalkerNerves.postAttack = nerve<WalkerEnemy>('TNerveWalkerPostAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setWaitAnm();
    return spine.time >= self.PW.mSLAttackWait && self.checkCurAnmEnd(ANM_BCK);
});
WalkerNerves.escape = nerve<WalkerEnemy>('TNerveWalkerEscape', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.goToRandomEscapeGraphNode(); self.setWalkAnm(); }
    if (self.isReachedToGoal()) self.goToRandomEscapeGraphNode();
    if (self.world.mario.checkFlag(0x2)) { if (self.goalStack.length) self.goal = self.popGoal(); return true; }
    const g = self.PW.mSLGiveUpLength;
    self.updateSquareToMario();
    if (self.distToMarioSq > g * g) return true;
    self.walkBehavior(1, 2);
    return false;
});
WalkerNerves.traceMario = nerve<WalkerEnemy>('TNerveWalkerTraceMario', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setRunAnm(); self.setGoalPath(new PathNode(self.world.mario)); }
    if (spine.time === 10) self.offLiveFlag(LF.HIDDEN);
    if (marioHidden(self)) { spine.pushAfterCurrent(WalkerNerves.traceMario); spine.pushAfterCurrent(SmallEnemyNerves.wait); return true; }
    if (Math.trunc(Math.abs(self.world.mario.pos.y - self.pos.y)) > self.PW.mSLGiveUpHeight) return true;
    self.walkBehavior(2, 3);
    return self.isResignationAttack();
});
export { World };
