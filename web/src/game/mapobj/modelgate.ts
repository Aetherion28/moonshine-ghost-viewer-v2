// TModelGate (MoveBG/ModelGate.cpp; scene.bin's JellyGate): Delfino Plaza's paint-portal gates
// (Gate, GateToRicco, GateToMamma, GateToMonte, GateToMare), one of /scene/map/map/gate's five
// models by its name (unk71). Shut (unk70 bit 0 clear) until its painting flag is set (or
// startOpen): then FLUDD's water hitting its face (within 200 of the centre joint, in front up to
// unkFC) charges it (unkD0 to 1, the BRK's frame), Mario near (within 1000) keeps it charged, a
// charged gate's box (unk104..unk114 in the centre joint's space) grabs a jumping Mario (the
// warp: he is taken, HIT_MESSAGE_TAKE), an uncharged one pushes him out (SMS_MarioMoveRequest).
// Charge drains while it emits its wind (unkCA ticks) and after.
//
// Not here: the THP movie textures, particles, sounds, the TEV-stage cycling (unkB8 is never set),
// the screen's directional blur (screenBlur: unkE0 is never set, so it is always 0), drawing.

import { fr, V3, Mtx, mtx, MsMtxSetXYZRPH, mtxMultVec, mtxInverse, matan, MsRandF } from '../math.js';
import { World, Stream, Actor, HitActor, TakeActor, MActor, AnmData, HF, HC, MSG, CUE_MOVE, CUE_CALC_ANIM, ANM_BPK, ANM_BTK, ANM_BRK } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { MTXConcat, getWaterPos } from './lib.js';

const gateMActorNames = ['05_gate01', '05_gate02rico', '05_gate03manma', '05_gate04monte', '05_gate05mare'];
const gateNames = ['Gate', 'GateToRicco', 'GateToMamma', 'GateToMonte', 'GateToMare'];
export const GATE_STATE = { UNK0: 0, UNK1: 1, UNK2: 2 };
/** TFlagManager's save flags (not kept by the sim: a world field, unset by default) */
const saveFlag = (w: World, name: string) => !!(w as any)[name];
const s16 = (v: number) => (v << 16) >> 16;

export class ModelGate extends TakeActor {
    unk70 = 0; unk71 = 0; unk72 = 0; unk74 = 0;
    unk78: MActor | null = null;
    unk7C: Mtx = mtx();
    unkAC = new V3();
    unkB8 = 0; unkB9 = 0; unkBA = 0; unkBC = 0; unkBE = 0;
    unkC4 = 0; unkC5 = 0; unkC6 = 0; unkC8 = 0; unkCA = 0; unkCC = 0; unkCE = 0;
    unkD0 = 0; unkD4 = 0; unkD8 = 0; unkDC = 0;
    unkE0 = 0; unkE4 = 0; unkE8 = 0; unkEC = 0; unkF0 = 0; unkF4 = 0; unkF8 = 0; unkFC = 0;
    unk100 = 0; unk104 = 0; unk108 = 0; unk10C = 0; unk110 = 0; unk114 = 0;
    /** its actor matrix (SMS_GetActorMtx), the model's base */
    baseTR: Mtx = mtx();
    constructor(public world: World, name = '<TModelGate>') { super(name); }
    load(s: Stream) { Actor.prototype.load.call(this, s); }
    /** getAnmMtx(unk72) as a Mtx */
    centerMtx(): Mtx {
        const out = mtx();
        const m = this.unk78 ? this.unk78.anmMtx(this.unk72, this.baseTR, this.scale) : null;
        if (!m) { out.set(this.baseTR); return out; }
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
        return out;
    }
    loadAfter() {
        const w = this.world;
        this.initHitActor(AT.MODEL_GATE, 5, HC.PLAYER, 300, 400, 300, 400);
        this.onHitFilter(HF.NO_COLLISION);
        this.unk70 = 0; this.unk71 = 0;
        for (let i = 0; i < 5; ++i) if (gateNames[i] === this.name) { this.unk71 = i; break; }
        const folder = 'map/map/gate';
        const m = this.unk78 = new MActor(`${folder}/${gateMActorNames[this.unk71]}.bmd`, new AnmData(folder, w.files));
        this.unk72 = m.jointIndex('center');
        this.unkB8 = 0; this.unkB9 = 0; this.unkBA = 0;
        this.unkBE = 0xF0; this.unkBC = this.unkBE;
        m.setAnimation(gateMActorNames[this.unk71], ANM_BTK);
        m.setAnimation(gateMActorNames[this.unk71], ANM_BRK);
        m.setFrameRate(0, ANM_BRK);
        this.unkC5 = 0x20; this.unkC6 = 0xFF; this.unkC4 = GATE_STATE.UNK1;
        this.unkC8 = 0x168; this.unkCA = 0; this.unkCC = 0; this.unkCE = 0x3C;
        this.unkD0 = 0; this.unkD4 = fr(0.1); this.unkD8 = fr(0.02); this.unkDC = fr(0.025);
        this.scale.set(1, 1, 1);
        w.addToGroup('マップグループ', this);
        w.conductor.others.push(this);
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        const c = this.centerMtx();
        const t = mtx(); t[11] = 250;
        MTXConcat(c, t, t);
        this.unkAC = mtxMultVec(t, new V3(0, 0, 0));
        mtxInverse(c, this.unk7C);
        this.unk74 = matan(c[10], c[2]);
        this.unkE0 = 0; this.unkE4 = 0; this.unkE8 = fr(0.01); this.unkEC = fr(0.02);
        this.unkF0 = 500; this.unkF4 = 1000; this.unkF8 = fr(0.7); this.unkFC = 0;
        this.unk100 = 200; this.unk104 = 150; this.unk108 = -1000; this.unk10C = 150; this.unk110 = 0; this.unk114 = 300;
        // (the particles it loads: not here)
        let opened = false;
        switch (this.unk71) {
            case 0: opened = saveFlag(w, 'MSF_M_PAINTED_ON_STATUE'); break;
            case 1: opened = saveFlag(w, 'MSF_M_PAINTED_ON_BOATHOUSE'); break;
            case 2: case 3: case 4: opened = saveFlag(w, 'MSF_M_PAINTED_ON_LIGHTHOUSE'); break;   // (the game's: three on the same flag)
        }
        if (opened) { this.unk70 |= 1; this.offHitFilter(HF.NO_COLLISION); }
        else { this.unk70 &= ~1; this.unk70 |= 2; this.onHitFilter(HF.NO_COLLISION); }
    }
    startOpen() {
        this.unk70 |= 1;
        this.unkC4 = GATE_STATE.UNK0;
        this.unk78!.setAnimation(gateMActorNames[this.unk71], ANM_BPK);
        this.offHitFilter(HF.NO_COLLISION);
        this.unk70 |= 2;
    }
    getTakingMtx(): Mtx | null { return null; }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.MARIO) && msg === MSG.ATTACK) { this.unkC8 = 0; this.unkC4 = GATE_STATE.UNK2; return true; }
        if (sender.isActorType(AT.WATER)) {
            const pos = mtxMultVec(this.unk7C, getWaterPos(this.world, sender));
            const dist = fr(fr(pos.x * pos.x) + fr(pos.y * pos.y));
            if (dist < 40000 && -100 < pos.z && pos.z < this.unkFC) {
                if (this.unk70 & 2) {
                    this.unkD0 = fr(this.unkD0 + this.unkD4);
                    if (this.unkD0 > 1) { this.unkCA = this.unkC8; this.unkD0 = 1; this.unk70 &= ~2; }
                }
                if (MsRandF() < this.unkF8) this.world.effect('gateHit', getWaterPos(this.world, sender));   // (ms_gatehit_a / _b)
                return true;
            }
        }
        return false;
    }
    perform(cue: number) {
        if (!(this.unk70 & 1)) return;
        const w = this.world, m = this.unk78!, mario = w.mario as any;
        if (cue & CUE_CALC_ANIM) m.frameUpdate();   // (unk78->perform)
        if (cue & CUE_MOVE) {
            if (!(this.unk70 & 2)) {
                if (V3.sub(mario.pos, this.pos).length() < 1000) {
                    this.unkD0 = fr(this.unkD0 + 0.01);
                    if (this.unkD0 > 1) { this.unkD0 = 1; this.unkCA = this.unkC8; }
                } else {
                    this.unkCA = s16(this.unkCA - 1);
                    if (this.unkCA <= 0) this.unkCA = 0;
                    this.unkD0 = fr(this.unkCA / 1000);
                }
            }
            const lp = mtxMultVec(this.unk7C, mario.pos);
            if (-this.unk104 < lp.x && lp.x < this.unk104 && this.unk108 < lp.y && lp.y < this.unk10C && this.unk110 < lp.z && lp.z < this.unk114) {
                if (this.unkCA > 0) {
                    if (mario.isJumping() && mario.receiveMessage(this, MSG.TAKE) === true) this.held = mario;
                } else {
                    const dx = fr(mario.pos.x - this.pos.x), dz = fr(mario.pos.z - this.pos.z);
                    const d = fr(Math.sqrt(fr(dx * dx + dz * dz)));
                    if (d < this.unk100) {
                        const p = mario.pos.clone();
                        p.x = fr(p.x + fr(10 * fr(dx / d))); p.z = fr(p.z + fr(10 * fr(dz / d)));
                        if (typeof mario.moveRequest === 'function') mario.moveRequest(p);   // SMS_MarioMoveRequest
                    }
                }
            }
        }
        if (cue & CUE_CALC_ANIM) {
            switch (this.unkC4) {
                case GATE_STATE.UNK0: { const fc = m.getFrameCtrl(ANM_BPK); if (fc && (fc.state & 3)) this.unkC4 = GATE_STATE.UNK1; break; }
                case GATE_STATE.UNK1:
                    if (this.unkCA > 0) {
                        // (the wind particles and the gate's light / wave sounds)
                        this.unkCA = s16(this.unkCA - 1); this.unkCC = s16(this.unkCC + 1);
                    } else {
                        this.unkCA = 0; this.unkCC = 0;
                        this.unkD0 = fr(this.unkD0 - this.unkD8);
                        if (this.unkD0 < 0) this.unkD0 = 0;
                    }
                    break;
                default: this.unkD0 = fr(this.unkD0 - this.unkDC); break;
            }
            if (this.unkD0 > 1) this.unkD0 = 1;
            if (this.unkD0 < 0) this.unkD0 = 0;
            // (unkB8's TEV-stage cycling: never on)
            const brk = m.getFrameCtrl(ANM_BRK);
            if (brk) brk.frame = fr(this.unkD0 * brk.end);
        }
    }
}

register('JellyGate', (w, n) => new ModelGate(w, n));
