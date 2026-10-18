// Mario as the game code sees him (gpMarioAddress / SMS_GetMarioPos / TMario's hit checks), from
// a ghost: where he is each movement tick (the ghost's QF), which way he faces, his animation (the
// status the game code asks about follows from it and from the ground under him), and FLUDD.
// Mario's own reactions (damage, being thrown back) aren't simulated: the ghost already shows
// what really happened. What he does to others is: TMario::checkCollision's messages.

import { V3 } from './math.js';
import { AT } from './actortypes.js';
import { HitActor, TakeActor, HC, MSG, World, LiveActor } from './engine.js';
import type { BGCheckData } from './collision.js';

/** The ghost's samples at a QF (the viewer's ghostSampleAt, plus FLUDD from the inputs). */
export interface MarioSample {
    x: number; y: number; z: number;
    /** s16 angle (the ghost's yaw) */
    yaw: number;
    anim: number;
    /** 0..1 through the animation */
    phase: number;
    yoshi: boolean;
    /** FLUDD this tick: spraying (mode bit 0x10), nozzle (TWaterGun: 0 spray, 1 rocket, 4 hover, 5 turbo...), power, emit offset and direction. */
    fludd: { spraying: boolean; nozzle: number; power: number; offset: [number, number, number]; yaw: number; pitch: number } | null;
}
export interface MarioTrack { at(qf: number): MarioSample | null; }

// Mario's animations (MarioAnimation ids, as the ghost records them) that mean a status.
const HIP_DROP = new Set([58, 60, 61]);
const DIVE = new Set([75, 76, 77, 202]);

/** TMario::TDeParams defaults (params.szs mario/... where present). */
const DE = { damageRadius: 42, damageHeight: 110, attackHeight: 50, trampleRadius: 100, pushupRadius: 100, pushupHeight: 200, hipdropRadius: 250, holdRadius: 100 };

export class MarioProxy extends TakeActor {
    vel = new V3(); prev = new V3();
    faceAngle = 0;
    anim = -1; phase = 0;
    onYoshi = false;
    /** status the game code asks about */
    jumping = false; hipDrop = false; diving = false;
    /** MARIO_FLAG_* (the ones enemies ask about) */
    marioFlags = 0x8000;   // HAS_FLUDD
    groundPlane: BGCheckData; groundHeight = 0;
    fludd: MarioSample['fludd'] = null;
    /** emitted water this tick (TWaterGun::getEmittedWaterCount != 0) */
    emitted = false;
    present = false;
    track: MarioTrack | null = null;
    constructor(public w: World) {
        super('マリオ');
        this.initHitActor(AT.MARIO, 5, HC.PLAYER | HC.MAP_OBJECT | HC.ITEM | HC.ENEMY | HC.BOSS | HC.NPC,
            DE.trampleRadius, DE.attackHeight, DE.damageRadius, DE.damageHeight);
        this.groundPlane = w.illegal;
    }
    isJumping() { return this.jumping; }
    checkFlag(f: number) { return (this.marioFlags & f) !== 0; }

    /** The tick's sample: where he is, how fast he's going, his status and attack area. */
    update(qf: number) {
        const s = this.track ? this.track.at(qf) : null;
        this.present = !!s;
        if (!s) { this.onHitFilter(0x1); return; }
        this.offHitFilter(0x1);
        this.prev.set(this.pos);
        this.pos.set(s.x, s.y, s.z);
        this.vel.set(this.pos.x - this.prev.x, this.pos.y - this.prev.y, this.pos.z - this.prev.z);
        if (this.vel.length() > 300) this.vel.zero();   // (a warp)
        this.faceAngle = s.yaw;
        this.rot.y = (s.yaw * 360) / 65536;
        this.anim = s.anim; this.phase = s.phase;
        this.onYoshi = s.yoshi;
        this.fludd = s.fludd;
        this.emitted = !!(s.fludd && s.fludd.spraying && s.fludd.power > 0);
        const [h, d] = this.w.checkGround(s.x, s.y + 100, s.z);
        this.groundPlane = d; this.groundHeight = h;
        const air = s.y > h + 4;
        this.hipDrop = HIP_DROP.has(s.anim) && air;
        this.diving = DIVE.has(s.anim);
        this.jumping = air;
        // MARIO_FLAG_IN_SHALLOW_WATER / IN_WATER: standing in water (the ground is a water surface just below him)
        this.marioFlags &= ~0x30000;
        if (d.isWaterSurface() && s.y <= h + 1) this.marioFlags |= 0x10000;
        // the attack area for his status (setJumpingAttackArea / hip drop / setNormalAttackArea)
        if (this.hipDrop) this.setHitParams(DE.hipdropRadius, DE.attackHeight, DE.damageRadius, DE.damageHeight);
        else if (this.jumping) {
            if (this.vel.y < 0) this.setHitParams(DE.trampleRadius, DE.attackHeight, DE.damageRadius, DE.damageHeight);
            else this.setHitParams(DE.pushupRadius, DE.pushupHeight, DE.damageRadius, DE.damageHeight);
        } else this.setHitParams(DE.holdRadius, DE.attackHeight, DE.damageRadius, DE.damageHeight);
    }

    receiveMessage(_sender: HitActor, _msg: number) { return true; }

    // ---------------------------------------------------------------- TMario::checkCollision
    private trampleExec(a: HitActor) {
        if (!this.jumping || this.diving) return false;
        return a.receiveMessage(this, MSG.TRAMPLE);
    }
    hitNormal(a: HitActor) {
        if (this.jumping && this.vel.y < 0 && a.pos.y < this.pos.y) {
            if (this.hipDrop) { a.receiveMessage(this, MSG.HIP_DROP); return; }
            if (this.trampleExec(a)) return;
        }
        // (MARIO_FLAG_UNK200: the super hip drop's quake; CATCH / OIL_SLIP / JUMP_CATCH: the dive catch)
        if (this.diving) { a.receiveMessage(this, MSG.PUNCH); a.receiveMessage(this, MSG.TRAMPLE); }
        if (this.fludd && this.fludd.nozzle === 0 && this.emitted) {
            const wa = this.w.water!.staticHitActor;
            wa.pos.set(this.pos); wa.pos.y += 80; wa.unk68 = 0;
            a.receiveMessage(wa, MSG.SPRAYED_BY_WATER);
        }
    }
    hitHipDrop(a: HitActor) { if (this.hipDrop && a.pos.y < this.pos.y) a.receiveMessage(this, MSG.HIP_DROP); }
    hitPushup(a: HitActor) { if (this.jumping && this.vel.y > 0) a.receiveMessage(this, MSG.PUSH_UP); this.hitNormal(a); }
    hitBrakable(a: HitActor) { if (this.jumping && this.vel.y < 0 && a.pos.y < this.pos.y && this.hipDrop) a.receiveMessage(this, MSG.HIP_DROP); }
    hitNpc(a: HitActor) {
        const npc = a as any;
        if (this.jumping && !this.hipDrop && this.vel.y < 0 && a.pos.y < this.pos.y && (!npc.isBeTrampledNpc || npc.isBeTrampledNpc())) this.trampleExec(a);
    }
    checkCollision() {
        if (!this.present) return;
        const T = AT as Record<string, number>;
        const normal = new Set(['HINOKURI2', 'BOSS_EEL', 'BOSS_TELESA', 'BATHTUB_KILLER', 'ENEMY_UNK1', 'HAMU_KURI', 'NAME_KURI', 'PAKKUN', 'ELEC_NOKONOKO', 'TELESA',
            'POPO', 'HANE_HAMU_KURI', 'DANGO_HAMU_KURI', 'FIRE_HAMU_KURI', 'PUKU_PUKU', 'DORO_HAMU_KURI', 'IGAIGA', 'GOROGORO', 'HANA_SAMBO', 'SAMBO_HEAD', 'DPT_CANNON',
            'ENEMY_UNK1D', 'ENEMY_UNK1F', 'EFFECT_OBJ', 'HAUNT_LEG', 'KUKKU', 'BEE_HIVE', 'DORO_HANE_KURI', 'CASINORULET', 'ITEM_UNK8', 'ITEM_UNKA', 'ITEM_UNKC',
            'GESSO', 'FIRE_WANWAN', 'POI_HANA', 'YUMBO', 'AMENBO', 'CHUU_HANA', 'NOZZLE_BOX', 'MARIO'].map((k) => T[k]));
        const hip = new Set(['BOSS_PAKKUN_HEAD'].map((k) => T[k]));
        const brak = new Set(['MAP_OBJECT_UNK2', 'BREAKABLE_BLOCK'].map((k) => T[k]));
        const push = new Set(['FOOTBALL', 'FRUIT_DURIAN'].map((k) => T[k]));
        for (const a of this.collisions.slice()) {
            if (a.isHitCategory(HC.NPC)) { this.hitNpc(a); continue; }
            const t = a.actorType;
            if (normal.has(t)) this.hitNormal(a);
            else if (hip.has(t)) this.hitHipDrop(a);
            else if (brak.has(t)) this.hitBrakable(a);
            else if (push.has(t)) this.hitPushup(a);
            else if (t === T.KUMOKUN) { this.hitNormal(a); this.hitHipDrop(a); }
            else if (t === T.AMI_NOKO) this.hitHipDrop(a);
            else if (t === T.TAMA_NOKO || t === T.BOMB_HEI || t === T.MAME_GESSO) this.hitNormal(a);
            else if (t === T.WOOD_BARREL || t === T.BARREL_OIL) this.hitBrakable(a);
        }
    }
    /** The player group's movement: Mario's tick (TMario::perform: ... checkCollision). */
    perform(cue: number) { if (cue & 0x1) this.checkCollision(); }
    /** SMS_GetMarioGroundPlane */
    getGroundPlane() { return this.groundPlane; }
    /** For LiveActor-shaped queries */
    asLive(): LiveActor | null { return null; }
}
