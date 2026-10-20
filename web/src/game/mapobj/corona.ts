// Corona Mountain's map objects (MoveBG/MapObjTrap.cpp, and TMuddyBoat of MapObjMare.cpp):
// - the spike lamps (LampTrapSpike): a slow cycle of the spikes creeping out (a jab up to frame 6),
//   shooting up, staying up for 360 frames, going down and staying down for 120; Mario touching the
//   spikes' hit cylinder (2300 above the lamp) while they're out is hurt, and Mario standing on the
//   lamp while the spikes are more than half out is burnt.
// - the iron-plate lamps (LampTrapIron): burning hot (standing on one burns Mario, its hit cylinder
//   2300 above too) until sprayed 60 times; then cool for 1200 frames and the fire comes back.
// - the mud boat (MuddyBoat; also Noki Bay's): it floats on the waves and only moves once Mario,
//   standing on it, sprays: spraying backwards pushes it forwards (0.04 a frame, 0.01 backwards),
//   sideways turns it; stream cubes Mario is in add to its speed; the speed and turn die down.
//   Touching a wall or shallow ground breaks it (its break animation), and 600 frames later it's
//   back where it started.
//
// Not here: particles (the fire, the plates' put-out puff, ripples, smoke: told as world effects
// where the game emits one once), the boat's float sound's speed info.

import { fr, V3, mtx, MsWrap, MsMtxSetXYZRPH } from '../math.js';
import { World, HitActor, LF, HF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_MOVE } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { DONT_MOVE_XZ, WallCheck } from '../collision.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, MOF, STATE_NORMAL } from './base.js';
import { MTXConcat, normalize, setRootMtx, marioGroundPlane, marioTouchGround4cm, marioWaterGun, sendToMario, inStreamCube, mapObjWave } from './lib.js';
import { marioIsOn } from './bianco.js';

/** plane->getActor() == this && SMS_IsMarioTouchGround4cm() */
const marioStandsOn = (o: MapObjBase) => { const p = marioGroundPlane(o.world); return !!p && p.actor === o && marioTouchGround4cm(o.world); };

// ---------------------------------------------------------------- TLampTrapSpike
/** unk138: the spikes' states */
const SPIKE_UP = 0, SPIKE_DOWN = 1, SPIKE_STAY_UP = 2, SPIKE_STAY_DOWN = 3, SPIKE_CREEP = 4, SPIKE_BACK = 5;

/** TLampTrapSpikeHit: the spikes' hit cylinder (トゲあたり), 2300 above the lamp */
export class LampTrapSpikeHit extends HitActor {
    constructor(public world: World, public unk68: LampTrapSpike, name: string) {
        super(name);
        this.initHitActor(AT.LAMPTRAPSPIKE, 3, HC.PLAYER, 500, 300, 500, 300);
        world.addToGroup('アイテムグループ', this);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68.receiveMessage(sender, msg); }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        this.pos.set(this.unk68.pos);
        this.pos.y = fr(this.pos.y + 2300);
        const s = this.unk68.unk138;
        if (s === SPIKE_STAY_UP || s === SPIKE_UP || s === SPIKE_DOWN)
            for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) sendToMario(this.world, this, MSG.ATTACK);
    }
}

export class LampTrapSpike extends MapObjBase {
    unk138 = SPIKE_STAY_DOWN; unk13C = 0; unk140: LampTrapSpikeHit | null = null;
    constructor(w: World, name = 'トゲランプ') { super(w, name); }
    initMapObj() { super.initMapObj(); this.onHitFilter(HF.NO_COLLISION); }
    loadAfter() { super.loadAfter(); this.unk140 = new LampTrapSpikeHit(this.world, this, 'トゲあたり'); }
    control() {
        let burn = false;
        const thing = this.unk138, a = this.mactor;
        const fc = () => (a ? a.getFrameCtrl(ANM_BCK) : null);
        const setBck = (n: string) => { if (a) a.setBck(n); };
        switch (thing) {
            case SPIKE_UP: {
                const c = fc();
                if (this.unk13C === 0) { setBck('lamptrapspike_up'); const c2 = fc(); if (c2) { c2.frame = 6; c2.rate = ANM_FRAME_RATE; } }
                if (!a || a.curAnmEndsNext(ANM_BCK)) { this.unk13C = 0; this.unk138 = SPIKE_STAY_UP; }
                if (c && c.frame > fr(c.end * 0.5)) burn = true;
                break;
            }
            case SPIKE_DOWN: {
                const c = fc();
                if (this.unk13C === 0) { setBck('lamptrapspike_down'); const c2 = fc(); if (c2) { c2.frame = 0; c2.rate = fr(ANM_FRAME_RATE * 0.8); } }
                if (!a || a.curAnmEndsNext(ANM_BCK)) { this.unk13C = 0; this.unk138 = SPIKE_STAY_DOWN; }
                if (c && c.frame > fr(c.end * 0.5)) burn = true;
                break;
            }
            case SPIKE_STAY_UP:
                if (this.unk13C === 0) {
                    setBck('lamptrapspike_up');
                    const c = fc(); if (c) { c.frame = c.end; c.rate = 0; }
                    this.world.sound(SE.OBJ_MVING_FENCT_SET, this.pos);
                }
                if (this.unk13C >= 360) { this.unk13C = 0; this.unk138 = SPIKE_DOWN; }
                burn = true;
                break;
            case SPIKE_STAY_DOWN:
                if (this.unk13C === 0) { setBck('lamptrapspike_down'); const c = fc(); if (c) { c.frame = c.end; c.rate = 0; } }
                if (this.unk13C >= 120) { this.unk13C = 0; this.unk138 = SPIKE_CREEP; }
                burn = false;
                break;
            case SPIKE_CREEP: {
                const c = fc();
                if (this.unk13C === 0) { setBck('lamptrapspike_up'); const c2 = fc(); if (c2) { c2.frame = 0; c2.rate = fr(ANM_FRAME_RATE * 0.1); } }
                if (c && c.checkPass(6)) c.rate = 0;
                if (this.unk13C >= 240) { this.unk13C = 0; this.unk138 = SPIKE_UP; }
                break;
            }
            default: { // SPIKE_BACK
                const c = fc();
                if (this.unk13C === 0) { setBck('lamptrapspike_up'); const c2 = fc(); if (c2) { c2.frame = 6; c2.rate = -ANM_FRAME_RATE; } }
                if (c && c.checkPass(0)) { this.unk13C = 0; this.unk138 = SPIKE_UP; }
                break;
            }
        }
        if (this.unk138 === thing) { this.unk13C = (this.unk13C + 1) | 0; if (this.unk13C === 0) this.unk13C = 1; }
        super.control();
        if (burn && marioStandsOn(this)) sendToMario(this.world, this, MSG.BURN);
    }
    perform(cue: number) { super.perform(cue); if (this.unk140) this.unk140.perform(cue); }
}

// ---------------------------------------------------------------- TLampTrapIron
/** TLampTrapIronHit: the plate's hit cylinder (鉄板あたり), 2300 above the lamp, burning while it's lit */
export class LampTrapIronHit extends HitActor {
    constructor(public world: World, public unk68: LampTrapIron, name: string) {
        super(name);
        this.initHitActor(AT.LAMPTRAPIRON, 3, HC.PLAYER, 500, 300, 500, 300);
        world.addToGroup('アイテムグループ', this);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68.receiveMessage(sender, msg); }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        this.pos.set(this.unk68.pos);
        this.pos.y = fr(this.pos.y + 2300);
        if (this.unk68.unk13C > 0)
            for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) sendToMario(this.world, this, MSG.BURN);
    }
}

export class LampTrapIron extends MapObjBase {
    static mHitPointMax = 60; static mFireTimerMax = 1200;
    /** unk13C: the fire's hit points (sprays left); unk140: the frames it stays out */
    unk138: LampTrapIronHit | null = null; unk13C = 0; unk140 = 0;
    constructor(w: World, name = '鉄板ランプ') { super(w, name); }
    initMapObj() { super.initMapObj(); this.onHitFilter(HF.NO_COLLISION); this.unk140 = 0; this.unk13C = LampTrapIron.mHitPointMax; }
    loadAfter() { super.loadAfter(); this.unk138 = new LampTrapIronHit(this.world, this, '鉄板あたり'); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.WATER)) {
            if (this.unk13C > 0) {
                --this.unk13C;
                if (this.unk13C === 0) { this.unk140 = LampTrapIron.mFireTimerMax; this.emit('lampTrapIronOut'); }
            }
            return true;
        }
        return super.receiveMessage(sender, msg);
    }
    control() {
        super.control();
        if (this.unk140 <= 0) { if (marioStandsOn(this)) sendToMario(this.world, this, MSG.BURN); }
        else { --this.unk140; if (this.unk140 === 0) this.unk13C = LampTrapIron.mHitPointMax; }
    }
    // (CalcAnim: the teppanFire particles while it's lit)
    perform(cue: number) { super.perform(cue); if (this.unk138) this.unk138.perform(cue); }
}

// ---------------------------------------------------------------- TMuddyBoat (MapObjMare.cpp)
const MUDDY_BROKEN = 2, MUDDY_GONE = 3;
export class MuddyBoat extends MapObjBase {
    /** unk138/13C: forward/backward push; unk140 the speed, unk144 its damping; unk148 the turn push, unk14C the turn, unk150 its damping */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0; unk14C = 0; unk150 = 0;
    /** the wall check radii (middle, front, back) and the front/back offsets */
    unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 0; unk164 = 0;
    unk168 = 0; unk16C = 0; unk170 = new V3(); unk17C = new V3();
    constructor(w: World, name = 'どろの船') { super(w, name); }
    getSDLModelFlag() { return 0; }
    initMapObj() {
        super.initMapObj();
        this.unk138 = fr(0.04); this.unk144 = fr(0.998); this.unk148 = fr(0.002); this.unk150 = fr(0.997); this.unk13C = fr(0.01); this.unk168 = 600;
        if (this.world.map === 0x34) { this.unk158 = 126; this.unk154 = 185; this.unk15C = 150; this.unk160 = 170; this.unk164 = 185; }
        else { this.unk158 = 100; this.unk154 = 170; this.unk15C = 150; this.unk160 = 180; this.unk164 = 100; }
        this.unk17C.set(3, 2, 5);
    }
    /** moveByWater: Mario on it spraying pushes it along its Z and turns it */
    moveByWater() {
        const g = marioWaterGun(this.world);
        if (!g.emitting) return;
        const dir = normalize(new V3(fr(-g.mtx[0]), 0, fr(-g.mtx[8])));
        const m = this.rootMtx();
        const fwd = new V3(m[2], 0, m[10]);
        const dot = fr(dir.dot(fwd));
        const mp = this.world.mario.pos;
        const normal = normalize(new V3(fr(mp.x - this.pos.x), 0, fr(mp.z - this.pos.z)));
        if (normal.x !== 0 || normal.z !== 0) normalize(normal);
        const delta = V3.sub(dir, fwd);
        const tv = new V3().cross(fwd, delta);
        const turn = fr(fr(tv.y) * fr(fwd.dot(normal)));
        const k = fr(this.unk148 * fr(1 - Math.abs(dot)));
        this.unk14C = turn > 0 ? fr(this.unk14C + k) : fr(this.unk14C - k);
        this.unk140 = fr(this.unk140 + fr(dot * (dot > 0 ? this.unk138 : this.unk13C)));
        this.offLiveFlag(LF.UNK10);
    }
    calcRootMatrix() { }
    kill() {
        this.unk140 = 0; this.unk14C = 0;
        this.emit('amiAttack', this.unk170);
        this.world.sound(SE.OBJ_DORO_BROKEN, this.pos);
        // MTXCopy(getAnmMtx(0), getBaseTRMtx()): setRootMtx keeps them together here
        this.offMapObjFlag(MOF.NO_ANIMATIONS);
        this.onLiveFlag(LF.UNK10);
        this.startAnim(1);
        this.startAnim(2);
        this.state = MUDDY_BROKEN;
    }
    touchWall(p: V3, r: WallCheck) {
        const wall = r.results[0], k = fr(50 + r.radius);
        this.unk170.set(fr(r.center[0] - fr(wall.n[0] * k)), fr(100 + fr(this.pos.y - this.yOffset)), fr(r.center[2] - fr(wall.n[2] * k)));
        p.set(this.pos);
        this.kill();
        this.posDelta.zero();
    }
    bindToWall(c: V3, radius: number, p: V3) {
        const r: WallCheck = { center: [c.x, c.y, c.z], radius, maxResults: 4, flags: DONT_MOVE_XZ, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) { this.touchWall(p, r); return true; }
        return false;
    }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const pos = this.pos.clone(), m = this.rootMtx();
        pos.x = fr(pos.x + fr(m[2] * this.unk140));
        pos.z = fr(pos.z + fr(m[10] * this.unk140));
        // (the cube Mario is in)
        const cube = inStreamCube(this.world, this.world.mario.pos);
        if (cube) {
            const sm = mtx(); MsMtxSetXYZRPH(sm, 0, 0, 0, cube.r.x, cube.r.y, cube.r.z);
            const d = fr(fr(m[2] * sm[2]) + fr(m[10] * sm[10]));
            this.unk140 = fr(this.unk140 + fr(0.0001 * fr(d * cube.unk40)));
        }
        const [height, ground] = this.world.checkGroundIgnoreWaterSurface(pos.x, pos.y, pos.z);
        const bottom = fr(this.pos.y - this.yOffset);
        if (height > fr(bottom - 100) || ground.isIllegal()) { pos.set(this.pos); this.kill(); this.posDelta.zero(); return; }
        const c = new V3(fr(pos.x + fr(m[2] * this.unk160)), bottom, fr(pos.z + fr(m[10] * this.unk160)));
        if (this.bindToWall(c, this.unk158, pos)) return;
        c.set(fr(pos.x - fr(m[2] * this.unk164)), fr(this.pos.y - this.yOffset), fr(pos.z - fr(m[10] * this.unk164)));
        if (this.bindToWall(c, this.unk15C, pos)) return;
        c.set(pos.x, fr(this.pos.y - this.yOffset), pos.z);
        if (this.bindToWall(c, this.unk154, pos)) return;
        this.posDelta.set(V3.sub(pos, this.pos));
    }
    control() {
        super.control();
        if (marioIsOn(this)) this.moveByWater();
        switch (this.state) {
            case STATE_NORMAL:
                this.unk140 = fr(this.unk140 * this.unk144);
                this.world.sound(SE.OBJ_DORO_FLOAT, this.pos);
                if (this.unk14C === 0) break;
                this.rot.y = fr(this.rot.y + this.unk14C);
                this.rot.y = MsWrap(this.rot.y, 0, 360);
                this.unk14C = fr(this.unk14C * this.unk150);
                if (Math.abs(this.unk14C) < fr(0.0001)) this.unk14C = 0;
                break;
            case MUDDY_BROKEN:
                if (!this.animIsFinished()) break;
                this.stateTimer = this.unk168;
                this.onMapObjFlag(MOF.NO_ANIMATIONS);
                this.sleep();
                this.state = MUDDY_GONE;
                break;
            case MUDDY_GONE: {
                if (this.isStateTimerEngaged()) break;
                this.awake();
                this.makeObjDead();
                this.makeObjDefault();
                this.makeObjAppeared();
                const s = new V3(fr(2 * this.scale.x), fr(2 * this.scale.y), fr(3 * this.scale.z));
                this.unk170.set(this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z);
                this.world.effect('enmDisapA', this.unk170, s);
                this.world.effect('enmDisapB', this.unk170, s);
                this.world.sound(SE.SMOKE_EFFECT, this.pos);
                this.state = STATE_NORMAL;
                break;
            }
        }
    }
    /** calc: the root matrix on the waves (yaw only, by the initial scale), and the ripples while it moves */
    calc() {
        const wv = mapObjWave(this.world);
        let waveY = fr(this.pos.y - this.yOffset);
        waveY = fr(waveY + (wv ? wv.getWaveHeight(this.pos.x, this.pos.z) : 0));
        const m = mtx(); MsMtxSetXYZRPH(m, this.pos.x, waveY, this.pos.z, 0, this.rot.y, 0);
        const S = mtx(), is = this.initialScale; S[0] = is.x; S[5] = is.y; S[10] = is.z;
        MTXConcat(m, S, m);
        setRootMtx(this, m);
        if (this.unk140 !== 0) {
            this.unk170.set(this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z);
            const s = new V3(fr(3 * this.scale.x), fr(2 * this.scale.y), fr(3 * this.scale.z));
            this.world.effect('hamonB', this.unk170, s);
            this.world.effect('hamonA', this.unk170, s);
            this.unk16C = 0;
        }
    }
}

// ---------------------------------------------------------------- registry
register('LampTrapSpike', (w, n) => new LampTrapSpike(w, n));
register('LampTrapIron', (w, n) => new LampTrapIron(w, n));
register('MuddyBoat', (w, n) => new MuddyBoat(w, n));
