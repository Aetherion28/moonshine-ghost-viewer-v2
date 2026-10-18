// FLUDD's water (Player/ModelWaterManager.cpp, Player/WaterGun.cpp): TModelWaterManager's 256
// particle slots, each a drop in flight (state 1), a wet spot on the ground (2) or running down a
// wall (3); what they hit (TObjHitCheck::checkWater finds an actor for each drop in flight, which
// move() then sends HIT_MESSAGE_SPRAYED_BY_WATER; drops landing on a live actor's collision send
// it too), and the goop they clean (splashGround / splashWall stamp the clean shape every tick a
// wet spot lasts). Emission is TNozzle*::emit from what a ghost records of FLUDD each tick: the
// nozzle, its power, the emit point and direction.

import { V3, fr, rand, MsRandF, JMASSin, JMASCos } from './math.js';
import { HitActor, Params, PSchema, World, HC, MSG, ObjHitCheck, Files } from './engine.js';
import { AT } from './actortypes.js';
import { BGCheckData, IGNORE_WATER_THROUGH, WallCheck } from './collision.js';

export class WaterHitActor extends HitActor {
    /** the particle it stands for (getParticleAttack) */
    unk68 = -1;
}

/** TWaterEmitInfo */
export interface EmitInfo {
    num: number; alive: number; attack: number; dir: number[]; pos: number[]; v: number[];
    dirTremble: number; pow: number; powTremble: number; size: number; sizeTremble: number;
    hitRadius: number; hitHeight: number; flag: number; type: number;
}
export const EMIT_INFO = {
    mNum: ['i', 1], mAlive: ['i', 0xFF], mAttack: ['s16', 1], mDir: ['v3', [0, 1, 0]], mPos: ['v3', [0, 0, 0]], mV: ['v3', [0, 0, 0]],
    mDirTremble: ['f', 0], mPow: ['f', 0], mPowTremble: ['f', 0], mSize: ['f', 17], mSizeTremble: ['f', 0],
    mHitRadius: ['f', 50], mHitHeight: ['f', 80], mFlag: ['i', 0], mType: ['u8', 0],
} satisfies PSchema;
export function emitInfo(path: string, files: Files): EmitInfo {
    const p = new Params(path, files).read(EMIT_INFO);
    return { num: p.mNum, alive: p.mAlive, attack: p.mAttack, dir: p.mDir as number[], pos: p.mPos as number[], v: p.mV as number[], dirTremble: p.mDirTremble, pow: p.mPow,
        powTremble: p.mPowTremble, size: p.mSize, sizeTremble: p.mSizeTremble, hitRadius: p.mHitRadius, hitHeight: p.mHitHeight, flag: p.mFlag, type: p.mType };
}

const WTP_NAMES = ['WTP00_Normal', 'WTP01_Wide', 'WTP02_Bomb', 'WTP03_TrgRocket', 'WTP04_HHover', 'WTP05_Sinper', 'WTP06_Yoshi', 'WTP07_Diving', 'WTP08_Bubble',
    'WTP09_Parasol', 'WTP10_Back', 'WTP11_Sprinkler', 'WTP12_YoshiMouth', 'WTP13_Turbo', 'WTP14_Rocket', 'WTP15_Hover', 'WTP16_SpRocket'];
const WTP = { mExtension: ['f', 0.5], mMagnify: ['f', 0.3], mCleanSize: ['f', 12], mGravity: ['f', -0.4], mAlive: ['f', 255] } satisfies PSchema;
type WTPType = { mExtension: number; mMagnify: number; mCleanSize: number; mGravity: number; mAlive: number };

const SLOT_NUM = 256;
const rand11 = () => fr(((rand() & 0xFF) - 128) / 128);
/** gWaterManagerPlaneInfo: friction, fall, vanish speed (water-slip planes, others). */
const PLANE = { frSlip: 0.93, fallSlip: -3, vanSlip: 2, fr: 0.7, fall: -1, van: 1 };
/** unk5D88 */
const K = [0.5, 0.35, 0.5, 10000, 0.2, 0, 2.5, 1, 0.3, 0.5, 0.8, 0.3, 0.08];

export class Water {
    count = 0;
    life = new Float32Array(SLOT_NUM); flag = new Uint16Array(SLOT_NUM); attack = new Int16Array(SLOT_NUM);
    pos: V3[] = []; vel: V3[] = []; size = new Float32Array(SLOT_NUM); type = new Uint8Array(SLOT_NUM);
    hit: (HitActor | null)[] = []; plane: (BGCheckData | null)[] = [];
    types: WTPType[];
    staticHitActor = new WaterHitActor('<WaterHitActor>');
    /** unk5E08: drops further than this (across the ground) from Mario are dropped */
    far = 5000;
    /** unk5D60 (0x40: wet spots close together merge) */
    flags = 367;
    tick = 0;
    /** juice (unk5D5F: 0 water, 1-3 Yoshi's juices) */
    juice = 0;
    diving = false;
    constructor(public w: World, files: Files) {
        for (let i = 0; i < SLOT_NUM; i++) { this.pos.push(new V3()); this.vel.push(new V3()); this.hit.push(null); this.plane.push(null); }
        this.types = WTP_NAMES.map((n) => new Params(`/Mario/${n}.prm`, files).read(WTP));
        this.staticHitActor.initHitActor(AT.WATER, 1, HC.MAP_OBJECT | HC.ENEMY | HC.BOSS | HC.NPC, 50, 80, 50, 80);
        this.staticHitActor.unk68 = -1;
    }
    getParticleAttack(a: WaterHitActor) { return a.unk68 >= 0 ? this.attack[a.unk68] : 0; }
    private gravity(i: number) { return this.diving ? K[12] : this.types[this.type[i]].mGravity; }
    private friction(p: BGCheckData) { return p.isWaterSlip() ? PLANE.frSlip : PLANE.fr; }
    private fall(p: BGCheckData) { return p.isWaterSlip() ? PLANE.fallSlip : PLANE.fall; }
    private vanish(p: BGCheckData) { return p.isWaterSlip() ? PLANE.vanSlip : PLANE.van; }
    askDoWaterHitCheck() { return true; }

    private makeEmit(e: EmitInfo) {
        const n = this.count;
        this.life[n] = e.alive; this.flag[n] = e.flag | 1; this.attack[n] = e.attack;
        this.pos[n].set(e.pos[0], e.pos[1], e.pos[2]);
        let x = rand11(), y = rand11(), z = rand11();
        x = fr(x * e.dirTremble + e.dir[0]); y = fr(y * e.dirTremble + e.dir[1]); z = fr(z * e.dirTremble + e.dir[2]);
        if (x === 0 && y === 0 && z === 0) y = -1;
        const l = Math.sqrt(x * x + y * y + z * z);
        x = fr(x / l); y = fr(y / l); z = fr(z / l);
        const sc = fr(rand11() * e.powTremble + e.pow);
        this.vel[n].set(fr(x * sc + e.v[0]), fr(y * sc + e.v[1]), fr(z * sc + e.v[2]));
        this.size[n] = fr(rand11() * e.sizeTremble + e.size);
        this.type[n] = e.type;
        this.plane[n] = null; this.hit[n] = null;
    }
    /** emitRequest: the drops that fit in the free slots; how many it made. */
    emitRequest(e: EmitInfo) {
        let left = e.num;
        if (left === 0) return 0;
        while (left > 0) { if (this.count >= SLOT_NUM) break; this.makeEmit(e); --left; this.count++; }
        return (e.num - left) & 0xFF;
    }

    /** TObjHitCheck::checkWater: the actor each drop in flight is in (for move to tell). */
    checkHits(hc: ObjHitCheck) {
        const er = this.staticHitActor.entryRadius;
        for (let i = 0; i < this.count; i++) {
            if ((this.flag[i] & 0xF) !== 1) continue;
            const h = hc.waterHitAt(this.pos[i], this.staticHitActor.attackRadius, this.staticHitActor.attackHeight, er);
            if (h !== undefined) this.hit[i] = h;
        }
    }

    private tell(a: HitActor, i: number) {
        const s = this.staticHitActor;
        s.pos.set(this.pos[i]); s.unk68 = i;
        return a.receiveMessage(s, MSG.SPRAYED_BY_WATER);
    }

    /** TModelWaterManager::move (a movement tick). */
    move() {
        const mario = this.w.mario.pos, N = this.count;
        for (let i = 0; i < N; ++i) {
            const P = this.pos[i], V = this.vel[i];
            const h = this.hit[i];
            if (h) {
                if (this.tell(h, i)) {
                    if (MsRandF() < K[8]) { /* gpSplashManager->newSplash */ }
                    this.life[i] = 0;
                    continue;
                }
            }
            const dx = mario.x - P.x, dz = mario.z - P.z;
            if (dx * dx + dz * dz > this.far * this.far) { this.life[i] = 0; continue; }
            const hv = V.x * V.x + V.z * V.z, sz = this.size[i];
            if (hv > sz * sz) {
                const hl = Math.sqrt(hv);
                V.x = fr(fr(sz - 0.1) * fr(V.x * fr(1 / hl)));
                V.z = fr(fr(sz - 0.1) * fr(V.z * fr(1 / hl)));
            }
            switch (this.flag[i] & 0xF) {
                case 1:
                    V.y = fr(V.y + this.gravity(i));
                    P.x = fr(P.x + V.x); P.y = fr(P.y + V.y); P.z = fr(P.z + V.z);
                    break;
                case 2: {
                    const pl = this.plane[i]!;
                    V.x = fr(V.x * this.friction(pl) + pl.n[0]);
                    V.y = this.gravity(i);
                    V.z = fr(V.z * this.friction(pl) + pl.n[2]);
                    P.x = fr(P.x + V.x); P.y = fr(P.y + V.y); P.z = fr(P.z + V.z);
                    break;
                }
                case 3:
                    P.y = fr(P.y + this.fall(this.plane[i]!));
                    break;
            }
        }

        let ground: BGCheckData | null = null, f31 = 0;
        for (let i = 0; i < N; ++i) {
            const P = this.pos[i], V = this.vel[i], T = this.types[this.type[i]];
            if (V.y < 0) {
                const r = this.w.col.checkGround(P.x, fr(P.y - V.y), P.z, IGNORE_WATER_THROUGH);
                f31 = r[0]; ground = r[1];
                if (ground.isLegal() && !(1 + f31 < P.y)) {
                    if (ground.isWaterSurface()) { MsRandF(); this.life[i] = 0; continue; }
                    if (ground.isPool()) { this.life[i] = 0; MsRandF(); continue; }
                    P.y = fr(f31 - this.gravity(i));
                    const st = this.flag[i] & 0xF;
                    if (st === 3) { this.life[i] = 0; continue; }
                    if (st === 1) {
                        MsRandF();   // a splash (unk5D88[9])
                        this.size[i] = fr(this.size[i] * T.mMagnify);
                        if (MsRandF() < K[0]) this.flag[i] = (this.flag[i] & ~0xF) | 2;
                        else { this.life[i] = 0; continue; }
                    }
                    this.plane[i] = ground;
                    if (ground.actor && this.tell(ground.actor, i)) this.life[i] = 0;
                    continue;
                }
            }
            const wc: WallCheck = { center: [P.x, fr(P.y + this.size[i] * 0.5), P.z], radius: this.size[i], maxResults: 1, flags: IGNORE_WATER_THROUGH, results: [] };
            if (this.w.col.checkWalls(wc)) {
                const wall = wc.results[0];
                if ((this.flag[i] & 0xF) === 2) { this.life[i] = 0; continue; }
                if (ground && ground.isLegal() && P.y < this.size[i] * T.mMagnify + f31) { this.life[i] = 0; continue; }
                if (wall.actor) this.tell(wall.actor, i);
                const d = fr(wall.d + (P.x * wall.n[0] + P.y * wall.n[1] + P.z * wall.n[2]));
                P.x = fr(P.x - wall.n[0] * d); P.y = fr(P.y - wall.n[1] * d); P.z = fr(P.z - wall.n[2] * d);
                if ((this.flag[i] & 0xF) === 1) {
                    MsRandF();   // a splash (unk5D88[10])
                    this.size[i] = fr(this.size[i] * T.mMagnify);
                    if (MsRandF() < K[2]) this.flag[i] = (this.flag[i] & ~0xF) | 3;
                    else { this.life[i] = 0; continue; }
                }
                this.plane[i] = wall;
            } else {
                if (V.y >= 0) {
                    const [rh, roof] = this.w.col.checkRoof(P.x, P.y, P.z, IGNORE_WATER_THROUGH);
                    if (roof && roof.isLegal()) {
                        if (roof.actor) this.tell(roof.actor, i);
                        if (P.y + this.size[i] > rh) {
                            P.y = fr(rh - this.size[i]);
                            V.set(0, 0, 0);
                            this.flag[i] = (this.flag[i] & ~0xF) | 1;
                            continue;
                        }
                    }
                }
                this.flag[i] = (this.flag[i] & ~0xF) | 1;
            }
        }

        let r20 = -1, r26 = -1;
        const pol = this.w.pollution;
        for (let i = 0; i < N; ++i) {
            const st = this.flag[i] & 0xF, T = this.types[this.type[i]];
            if (st === 1) this.life[i] -= 1;
            else if (st === 2) {
                if (this.life[i] > 256) this.life[i] = 256;
                this.life[i] -= this.vanish(this.plane[i]!);
                if (pol) pol.clean(this.pos[i].x, this.pos[i].y, this.pos[i].z, fr(T.mCleanSize * 10), this.w.map);
                if (this.flags & 0x40) {
                    if (r20 < 0) r20 = i;
                    else if (V3.sub(this.pos[i], this.pos[r20]).length() < K[6] * (this.size[i] + this.size[r20])) {
                        this.size[r20] = this.size[i]; this.life[r20] = this.life[i]; this.life[i] = 0;
                    } else r20 = i;
                }
            } else if (st === 3) {
                if (this.life[i] > 256) this.life[i] = 256;
                this.life[i] -= this.vanish(this.plane[i]!);
                if (pol) pol.clean(this.pos[i].x, this.pos[i].y, this.pos[i].z, fr(T.mCleanSize * 32), this.w.map);
                if (this.flags & 0x40) {
                    if (r26 < 0) r26 = i;
                    else if (V3.sub(this.pos[i], this.pos[r26]).length() < K[6] * (this.size[i] + this.size[r26])) {
                        this.size[r26] = this.size[i]; this.life[r26] = this.life[i]; this.life[i] = 0;
                    } else r26 = i;
                }
            }
        }
        this.garbageCollect();
        this.tick++;
    }
    private garbageCollect() {
        let j = 0;
        for (let i = 0; i < this.count; ++i) {
            if (this.life[i] <= 0) continue;
            if (i !== j) {
                this.life[j] = this.life[i]; this.flag[j] = this.flag[i]; this.attack[j] = this.attack[i];
                const p = this.pos[j]; this.pos[j] = this.pos[i]; this.pos[i] = p;
                const v = this.vel[j]; this.vel[j] = this.vel[i]; this.vel[i] = v;
                this.size[j] = this.size[i]; this.type[j] = this.type[i]; this.hit[j] = this.hit[i]; this.plane[j] = this.plane[i];
            }
            ++j;
        }
        for (let i = j; i < this.count; i++) { this.hit[i] = null; this.plane[i] = null; }
        this.count = j;
    }
}

// ---------------------------------------------------------------- FLUDD (TWaterGun's nozzles)
const NOZZLE = {
    mNum: ['f', 1], mAttack: ['s16', 1], mDirTremble: ['f', 0], mEmitPow: ['f', 40], mEmitCtrl: ['f', 0], mPowTremble: ['f', 0], mSize: ['f', 40],
    mSizeTremble: ['f', 0], mHitRadius: ['f', 50], mHitHeight: ['f', 80], mType: ['u8', 0], mNumMin: ['f', 1], mAttackMin: ['s16', 1],
    mDirTrembleMin: ['f', 0], mEmitPowMin: ['f', 0], mSizeMin: ['f', 1], mSizeMinPressure: ['f', 0], mSizeMaxPressure: ['f', 1],
} satisfies PSchema;
type Nozzle = { [K in keyof typeof NOZZLE]: number };
/** TWaterGun's nozzles by index (0 Spray: TNozzleDeform, 1 Rocket, 2 Underwater, 3 Yoshi, 4 Hover, 5 Turbo), and how many emitters each has. */
const NOZZLES: [string, number, 'deform' | 'trigger' | 'base'][] = [
    ['nozzleDeform', 1, 'deform'], ['nozzleTrgRocket', 1, 'trigger'], ['nozzleDiving', 2, 'deform'], ['nozzleYoshiDeform', 1, 'deform'],
    ['nozzleTrgHover', 2, 'trigger'], ['nozzleTrgTurbo', 1, 'trigger'],
];
export class Fludd {
    nozzles: Nozzle[];
    bomb: Nozzle;
    emitNum: number[] = [0, 0, 0, 0, 0, 0];
    info: EmitInfo;
    constructor(public water: Water, files: Files) {
        this.nozzles = NOZZLES.map(([n]) => new Params(`/Mario/watergun/${n}.prm`, files).read(NOZZLE));
        this.bomb = new Params('/Mario/watergun/nozzleDeformBomb.prm', files).read(NOZZLE);
        this.info = { num: 1, alive: 255, attack: 1, dir: [0, 1, 0], pos: [0, 0, 0], v: [0, 0, 0], dirTremble: 0, pow: 0, powTremble: 0, size: 17, sizeTremble: 0, hitRadius: 50, hitHeight: 80, flag: 0, type: 0 };
    }
    /**
     * A movement tick of Mario's FLUDD (TWaterGun::emit): s the ghost's FLUDD record, at the Mario
     * position p moving at vel; burst: the tick of an accepted spam spray.
     */
    emit(s: { spraying: boolean; nozzle: number; power: number; offset: number[]; yaw: number; pitch: number }, p: V3, vel: V3, burst: boolean) {
        if (!s.spraying && !burst) return 0;
        const n = s.nozzle in NOZZLES ? s.nozzle : 0;
        const [, emitters, kind] = NOZZLES[n] || NOZZLES[0];
        const N = burst ? this.bomb : this.nozzles[n];
        const cp = Math.cos(s.pitch);
        const dir = [fr(Math.sin(s.yaw) * cp), fr(Math.sin(s.pitch)), fr(Math.cos(s.yaw) * cp)];
        const side = [Math.cos(s.yaw), 0, -Math.sin(s.yaw)];
        let made = 0;
        for (let e = 0; e < (burst ? 1 : emitters); e++) {
            const I = this.info;
            const off = emitters === 2 ? (e === 0 ? -28 : 28) : 0;
            I.alive = this.water.types[N.mType].mAlive;
            I.pos = [fr(p.x + s.offset[0] + side[0] * off), fr(p.y + s.offset[1]), fr(p.z + s.offset[2] + side[2] * off)];
            I.v = [fr(vel.x * 0.125), 0, fr(vel.z * 0.125)];
            I.dir = dir;
            I.dirTremble = N.mDirTremble; I.powTremble = N.mPowTremble; I.size = N.mSize; I.sizeTremble = N.mSizeTremble; I.type = N.mType;
            I.hitRadius = N.mHitRadius; I.hitHeight = N.mHitHeight;
            // pressure from the recorded power (the emit power is pressure * (mEmitPow - mEmitPowMin) + mEmitPowMin)
            const span = N.mEmitPow - N.mEmitPowMin;
            const u = burst ? 1 : Math.max(0, Math.min(1, span ? (s.power - N.mEmitPowMin) / span : 1));
            let num: number;
            if (burst) num = N.mNum;
            else if (kind === 'base') num = N.mNum;
            else num = fr(u * (N.mNum - N.mNumMin) + N.mNumMin);
            this.emitNum[n] = fr(this.emitNum[n] + num);
            const k = Math.trunc(this.emitNum[n]);
            if (k === 0) continue;
            this.emitNum[n] = fr(this.emitNum[n] - k);
            I.num = k;
            I.attack = Math.trunc(u * (N.mAttack - N.mAttackMin) + N.mAttackMin);
            I.pow = burst ? N.mEmitPow : s.power;
            if (kind === 'deform') {
                I.dirTremble = fr(u * (N.mDirTremble - N.mDirTrembleMin) + N.mDirTrembleMin);
                const l = u < N.mSizeMinPressure ? 0 : u < N.mSizeMaxPressure ? (u - N.mSizeMinPressure) / (N.mSizeMaxPressure - N.mSizeMinPressure) : 1;
                I.size = fr(l * (N.mSize - N.mSizeMin) + N.mSizeMin);
            }
            I.flag = 0x40;
            made += this.water.emitRequest(I);
        }
        return made;
    }
}
export { JMASSin, JMASCos };
