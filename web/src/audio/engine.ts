// JAudio's sequencer and voices (JSystem/JAudio/JASystem in the decomp): the BMS interpreter
// (JASSeqParser.cpp / JASTrack.cpp: tracks, registers, ports, interrupts, timed parameters),
// the logical channels (JASChannel.cpp: instrument pitch and volume, the oscillators of
// JASOscillator.cpp, gate times and release, pan by the channel calc tables) and a software mixer
// in place of the DSP. The sequencer runs on JAudio's own clock: every subframe (DAC rate / 80,
// about 400 a second) the root tracks tick (TTrack::rootCallback) and every channel's
// oscillators and mixer volumes update (update interval 1).
//
// Runs the same in an AudioWorklet (the viewer) and in node (tests).

import { Bank, Inst, InstEffect, Osc, Perc, VeloRegion, WaveInfo, decodeWave } from './formats.js';

export const DAC_RATE = 32028.5;
export const SUBFRAME_RATE = DAC_RATE / 80;

// Driver::C5BASE_PITCHTABLE: 2^((i - 60) / 12)
const C5 = Float32Array.from({ length: 128 }, (_, i) => Math.pow(2, (i - 60) / 12));
const c5 = (i: number) => C5[i < 0 ? 0 : i > 127 ? 127 : i];
const extend8to16 = (x: number) => ((x & 0x80) ? (x | 0xFF00) : x & 0xFF);
const s16 = (x: number) => (x << 16) >> 16;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Player::pitchToCent: the track's pitch (bend) param times its range (register 7) into a frequency ratio */
const pitchToCent = (p: number, range: number) => Math.pow(2, (p * 4 * range) / 12);

// JMath::TRandomFast (the instruments' random effects)
let rnd = 0;
const randU = () => { rnd = (Math.imul(rnd, 0x19660D) + 0x3C6EF35F) >>> 0; return ((rnd >>> 9) / 0x800000); };
const randS = () => randU() * 2 - 0.9999999;
// Player::getRandomS32 (the BMS random register op)
let rV0 = 0x1000, rV1 = 0x5555;
const randS32 = () => { const r = (Math.imul(rV1, -0x6789abce) + 1 + (Math.imul(rV0, 0x13579bde) >> 4)) | 0; rV0 = rV1; rV1 = r; return r; };

// ---------------------------------------------------------------- oscillators (JASOscillator.cpp)
const relSampleCell = [1.0, 0.970489, 0.781274, 0.54628098, 0.39979199, 0.28931499, 0.21210399, 0.15747599, 0.112613, 0.081789598, 0.0579852, 0.0436415, 0.0308237, 0.0237129, 0.0152593, 0.00915555, 0.0];
const relSqRoot = [1.0, 0.878906, 0.765625, 0.660156, 0.5625, 0.472656, 0.390625, 0.316406, 0.25, 0.191406, 0.140625, 0.097656198, 0.0625, 0.0351562, 0.015625, 0.00390625, 0.0];
const relSquare = [1.0, 0.96824598, 0.935414, 0.90138799, 0.86602497, 0.82915598, 0.790569, 0.75, 0.707107, 0.66143799, 0.61237198, 0.559017, 0.5, 0.43301299, 0.353553, 0.25, 0.0];
const FORCE_STOP = Int16Array.from([0, 15, 0, 15, 0, 0]);
const TIME_UNIT = SUBFRAME_RATE / 600;   // envelope times are in 1/600 s
const P_REL = Int16Array.from([0x0, 0xa, 0x0, 0xf, 0x1, 0x0]);
const P_VIB = Int16Array.from([0, 0, 0, 0, 0x0C, 0x7FFF, 0, 0x0C, 0, 0, 0x0C, -0x4000, 0, 0x0C, 0, 0x0D, 0, 1]);
const P_TRE = Int16Array.from([0, 0, 0x7fff, 0, 0x14, 0, 0, 0x14, -0x7fff, 0, 0x14, 0, 0, 0x14, 0x7fff, 0x0d, 0, 1]);
const P_ADS = Int16Array.from([0, 0, 0x7fff, 0, 0, 0x7fff, 0, 0, 0, 0x000e, 0, 0]);
const oscDef = (o: Partial<Osc>): Osc => ({ target: 0, rate: 1, ads: null, rel: null, width: 1, vertex: 0, ...o });
const ENVELOPE_DEF = () => oscDef({ rel: P_REL });
const VIBRATO_DEF = () => oscDef({ target: 1, rate: 0.5, ads: P_VIB, rel: P_VIB, width: 0, vertex: 1 });
const TREMORO_DEF = () => oscDef({ target: 0, rate: 0.5, ads: P_TRE, rel: P_TRE, width: 0, vertex: 1 });
const ADSR_DEF = () => oscDef({});
const OSC_ENV = oscDef({ rel: Int16Array.from([0x1, 0xA, 0x0, 0xf, 0x0, 0x0]) });

export class Oscillator {
    osc: Osc | null = null;
    state = 1; mode = 0; idx = 0; rate = 0; phase = 0; target = 0; change = 0; direct = 0; initRate = 0;
    init() { this.osc = null; this.state = 1; this.mode = 0; this.idx = 0; this.rate = 0; this.phase = 0; this.target = 0; this.change = 0; this.direct = 0; this.initRate = 0; }
    initStart() {
        this.state = 2; this.direct = 0;
        if (!this.osc || !this.osc.ads) { this.phase = 0; return; }
        this.idx = 0; this.rate = 0; this.target = 0; this.direct = 0;
        this.rate -= this.osc.rate;
    }
    getOffset(): number {
        const o = this.osc;
        if (!o) { this.phase = 1; return 1; }
        switch (this.state) {
            case 0: return 1;
            case 3: return o.vertex + this.phase * o.width;
            case 1: this.state = 2;
            // fallthrough
            default: {
                const table = this.state === 4 ? o.rel : this.state === 5 ? FORCE_STOP : o.ads;
                if (!table && this.state !== 6) { this.phase = 1; return 1; }
                this.rate -= this.state === 5 ? 1 : o.rate;
                return this.calc(table);
            }
        }
    }
    getOffsetNoCount() {
        const o = this.osc;
        if (!o) { this.phase = 1; return 1; }
        if (this.state === 0) return 1;
        if (this.state === 1) this.state = 2;
        return this.phase * o.width + o.vertex;
    }
    forceStop() { if (this.state === 5) return false; this.idx = 0; this.rate = 0; this.target = this.phase; this.state = 5; return true; }
    release() {
        const o = this.osc!;
        if (this.state === 5) return false;
        if (o.ads !== o.rel) { this.idx = 0; this.rate = 0; this.target = this.phase; }
        if (!o.rel && this.direct === 0) this.direct = 0x10;
        if (this.direct !== 0) {
            this.state = 6;
            this.mode = (this.direct >> 14) & 3;
            this.rate = Math.max(1, (this.direct & 0x3FFF) * TIME_UNIT);
            this.initRate = this.rate;
            this.target = 0;
            this.change = this.mode === 0 ? (this.target - this.phase) / this.rate : this.target - this.phase;
        } else this.state = 4;
        return true;
    }
    private calc(table: Int16Array | null): number {
        const o = this.osc!;
        let guard = 0;
        while (this.rate <= 0 && guard++ < 256) {
            const i = this.idx * 3;
            this.phase = this.target;
            if (this.state === 6) { this.state = 0; break; }
            if (!table || i + 2 >= table.length) { this.state = 0; break; }
            const m = table[i], time = table[i + 1], val = table[i + 2];
            if (m === 13) { this.idx = val; continue; }
            if (m === 15) { this.state = 0; break; }
            if (m === 14) { this.state = 3; return o.vertex + this.phase * o.width; }
            this.mode = m;
            if (time === 0) { this.target = val / 32768; this.idx++; continue; }
            this.rate = time * TIME_UNIT;
            this.initRate = this.rate;
            this.target = val / 32768;
            this.change = this.mode === 0 ? (this.target - this.phase) / this.rate : this.target - this.phase;
            this.idx++;
        }
        if (o.width === 0) return o.vertex;
        let p: number;
        const ch = this.change;
        if (this.initRate === 0) { p = this.target; this.phase = p; }
        else if (this.mode === 0 || ch === 0) { p = this.target - this.change * this.rate; this.phase = p; }
        else if (this.mode === 1 || this.mode === 2 || this.mode === 3) {
            const t = this.mode === 3 ? relSampleCell : this.mode === 1 ? relSquare : relSqRoot;
            let f = ch < 0 ? 16 * (1 - this.rate / this.initRate) : 16 * (this.rate / this.initRate);
            let k = Math.floor(f), prop = f - k;
            if (k >= 16) { k = 15; prop = 1; }
            if (k < 0) { k = 0; prop = 0; }
            const va = Math.abs(ch * (prop * (t[k + 1] - t[k]) + t[k]));
            p = this.change < 0 ? this.target + va : this.target - (this.change - va);
            this.phase = p;
        } else { p = this.target - ch * this.rate; this.phase = p; }
        return p * o.width + o.vertex;
    }
}

// ---------------------------------------------------------------- waves
/** A wave: its info and samples (decoded when first played). */
export interface WaveRef { info: WaveInfo; pcm: Int16Array | null; }
export interface WaveSource { wave(bank: number, id: number): WaveRef | null; }

// ---------------------------------------------------------------- channels (JASChannel.cpp)
class ChannelMgr {
    volume = 1; pitch = 1; pan = 0.5; fxmix = 0; dolby = 0;
    calc = [0xD, 0xD, 0xD];
}
// Driver::calc_sw_table: per calc type, how the (sound, effect, channel) parts add: 0 no, 1 add, 2 weighted
const CALC_SW: number[][] = [[0, 0, 0], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 1], [0, 1, 2], [0, 1, 0], [0, 2, 1], [0, 2, 2], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 1, 0],
    [1, 1, 1], [1, 1, 2], [1, 2, 0], [1, 2, 1], [1, 2, 2], [1, 0, 0], [2, 0, 1], [2, 0, 2], [2, 1, 0], [2, 1, 1], [2, 1, 2], [2, 2, 0], [2, 2, 1], [2, 2, 2]];
type PanM = { sound: number; effect: number; channel: number };
function calcPan(p: PanM, w: PanM, type: number) {
    const t = CALC_SW[type] || CALC_SW[0];
    let v = 0;
    const part = (mode: number, x: number, k: number) => { if (mode === 1) v += x - 0.5; else if (mode === 2) v += (x - 0.5) * k; };
    part(t[0], p.sound, w.sound); part(t[1], p.effect, w.effect); part(t[2], p.channel, w.channel);
    return v + 0.5;
}
function calcEffect(p: PanM, w: PanM, type: number) {
    const t = CALC_SW[type] || CALC_SW[0];
    let v = 0;
    const part = (mode: number, x: number, k: number) => { if (mode === 1) v += x; else if (mode === 2) v += x * k; };
    part(t[0], p.sound, w.sound); part(t[1], p.effect, w.effect); part(t[2], p.channel, w.channel);
    return v;
}

let generation = 1;
export class Channel {
    gen = generation++;
    mgr: ChannelMgr;
    wave: WaveRef | null = null;
    /** 2: a DSP oscillator (programs 0xF0+) */
    type = 0; oscWave = 0;
    velo = 0; key = 0;
    /** unk48: the wave's base step; unk50: the note's; unk54: volume; unk4C: the instrument volume */
    base = 1; step = 1; vol = 1; instVol = 1;
    pan: PanM = { sound: 0.5, effect: 0.5, channel: 0.5 };
    fx: PanM = { sound: 0, effect: 0, channel: 0 };
    power: PanM = { sound: 0, effect: 0.5, channel: 0.5 };
    oscs = [new Oscillator(), new Oscillator(), new Oscillator(), new Oscillator()];
    /** unk8C / unk90: the oscillators' pitch and volume this update */
    oscPitch = 1; oscVol = 1;
    /** unk30 / unk34: the gate time and what's left of it (-1: until note off) */
    gate = -1; left = -1;
    released = false; alive = true;
    /** key sweep (setKeySweepTarget) */
    sweepTo = 0; sweepLeft = 0;
    // the mixer's state
    pos = 0; outVol = 0; outPan = 0.5; outStep = 0; prevL = 0; prevR = 0;
    constructor(mgr: ChannelMgr) { this.mgr = mgr; }
    effectOsc(i: number, e: number) {
        const o = this.oscs[i].osc!;
        switch (o.target) {
            case 1: this.oscPitch *= e; break;
            case 0: this.oscVol *= e; break;
            case 2: this.pan.effect = e; break;
            case 3: this.fx.effect = e; break;
        }
    }
    setOscInit(i: number, osc: Osc) { this.oscs[i].osc = osc; this.oscs[i].initStart(); }
    /** stop (updatecallLogicalChannel 0): release the oscillators */
    stop(release = 0) {
        if (release) this.oscs[0].direct = release;
        for (const o of this.oscs) if (o.osc) o.release();
        this.released = true; this.left = -1; this.gate = -1;
    }
    /** updatecallDSPChannel(0): the oscillators, the gate and the mixer values for the coming subframe */
    update() {
        if (!this.alive) return;
        this.oscPitch = 1; this.oscVol = 1; this.pan.effect = 0.5; this.fx.effect = 0;
        for (let i = 0; i < 4; i++) {
            if (!this.oscs[i].osc) continue;
            this.effectOsc(i, this.oscs[i].getOffset());
            if (i === 0 && this.oscs[0].state === 0) { this.alive = false; return; }
        }
        if (this.sweepLeft > 0) {
            this.step += (this.sweepTo - this.step) / this.sweepLeft;
            this.sweepLeft--;
        }
        if (!this.released && this.left > 0) {
            this.left--;
            if (this.left === 0) this.stop();
        }
        this.updateEffectorParam();
    }
    updateEffectorParam() {
        const m = this.mgr;
        this.pan.channel = m.pan; this.fx.channel = m.fxmix;
        const pan = m.calc[0] === 0 ? 0.5 : calcPan(this.pan, this.power, m.calc[0]);
        this.outVol = m.volume * this.vol * this.oscVol;
        this.outPan = clamp01(pan);
        this.outStep = m.pitch * this.step * this.oscPitch;
    }
}

// ---------------------------------------------------------------- tracks (JASTrack.cpp / JASSeqParser.cpp)
interface Move { cur: number; target: number; amount: number; time: number; }
const ARGLIST: [number, number][] = [[0, 0], [2, 8], [2, 8], [1, 2], [0, 0], [0, 0], [1, 0], [1, 2], [0, 0], [1, 1], [0, 0], [2, 0], [2, 0xC], [1, 0], [1, 0], [1, 3], [2, 5], [2, 0xC],
    [2, 0xC], [0, 0], [1, 0], [1, 0], [1, 0], [2, 8], [5, 0x155], [1, 0], [1, 0], [1, 0], [1, 1], [2, 4], [1, 0], [2, 8], [1, 0], [0, 0], [0, 0], [0, 0], [2, 4], [0, 0], [0, 0], [1, 1],
    [0, 0], [0, 0], [1, 2], [5, 0], [4, 0x55], [1, 2], [1, 2], [3, 0], [1, 0], [1, 0], [3, 0x28], [1, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 1], [0, 0], [0, 0], [1, 1], [1, 1], [0, 0]];
const UPD_VOL = 1, UPD_PITCH = 2, UPD_FX = 4, UPD_PAN = 8, UPD_DOLBY = 0x10, UPD_TEMPO = 0x40;
const OSC_UPD = [UPD_VOL, UPD_PITCH, UPD_PAN, UPD_FX, UPD_DOLBY];

/** TTrack::TOuterParam: what the game sets on a track from outside (a sound's volume, pan...) */
export class OuterParam { switch_ = 0; volume = 1; pitch = 1; pan = 0.5; fxmix = 0; dolby = 0; tempo = 1; update = 0; }

export class Track {
    parent: Track | null = null;
    children: (Track | null)[] = new Array(16).fill(null);
    data: Uint8Array; pc = 0; wait = 0;
    stack: number[] = new Array(8).fill(0); loopTimers = new Array(8).fill(0); loopIndex = 0;
    intrPrev = -1; intrWait = 0;
    regs = new Uint16Array(64); addr = [0, 0, 0, 0];
    ports = new Uint16Array(16); importFlag = new Uint8Array(16); exportFlag = new Uint8Array(16);
    intrEnabled = 1; intrReq = 0; intrMask = 0; intrTable = new Array(8).fill(0); timerCount = 0; timerLeft = 0; timerReload = 0;
    timed: Move[] = Array.from({ length: 18 }, () => ({ cur: 1, target: 1, amount: 0, time: 0 }));
    notes: (Channel | null)[] = new Array(8).fill(null); noteGen = new Array(8).fill(0);
    baseTime = 0; connectCase = 0; lastNote = 0; beforeTie = false;
    transpose = 0; transposeTotal = 0;
    tempo = 0x78; timeBase = 0x30; tickRate = 1; tickCounter = 0; timeRelate = 1;
    volumeMode = 0; mute = 0; seqState = 0;
    oscData: Osc[] = [ENVELOPE_DEF(), VIBRATO_DEF()]; oscMode = [0xF, 0xE]; oscillators = [new Oscillator(), new Oscillator()];
    adsTable = Int16Array.from(P_ADS); relTable = Int16Array.from(P_REL);
    mgr = new ChannelMgr();
    outer: OuterParam | null = null;
    panSwitchExt = [0, 0, 0]; panSwitchParent = [0, 0, 0];
    kind = 0; tempoChild = 0; updateFlags = 0;
    route = 0;
    constructor(public player: Player, data: Uint8Array) { this.data = data; }

    // -------------------------------------------------- the byte stream
    rb() { return this.data[this.pc++] ?? 0; }
    r16() { return (this.rb() << 8) | this.rb(); }
    r24() { return (this.rb() << 16) | (this.rb() << 8) | this.rb(); }
    g8(o: number) { return this.data[o] ?? 0; }
    g16(o: number) { return (this.g8(o) << 8) | this.g8(o + 1); }
    g24(o: number) { return (this.g8(o) << 16) | (this.g8(o + 1) << 8) | this.g8(o + 2); }
    g32(o: number) { return ((this.g8(o) << 24) | (this.g8(o + 1) << 16) | (this.g8(o + 2) << 8) | this.g8(o + 3)) >>> 0; }

    // -------------------------------------------------- registers
    get bankProg() { return this.regs[6]; }
    readReg(r: number): number {
        switch (r) {
            case 32: return this.regs[6] >> 8;
            case 33: return this.regs[6] & 0xFF;
            case 34: return ((this.readReg(0) << 8) | this.readReg(1)) & 0xFFFF;
            case 44: { let v = 0; for (let i = 15; i >= 0; i--) { v <<= 1; const c = this.children[i]; if (c && c.seqState) v |= 1; } return v & 0xFFFF; }
            case 45: { let v = 0; for (let i = 7; i >= 0; i--) { v <<= 1; v |= this.channel(i) ? 0 : 1; } return v; }
            case 48: return this.loopIndex ? this.loopTimers[this.loopIndex - 1] : 0;
            default: return this.regs[r & 63];
        }
    }
    readReg32(r: number): number {
        if (r >= 0x28 && r <= 0x2B) return this.addr[r - 0x28];
        if (r === 0x23) return ((this.readReg(4) << 16) | this.readReg(5)) >>> 0;
        return this.readReg(r);
    }
    exch(r: number) { return r < 0x40 ? this.readReg32(r) : this.ports[(r - 0x40) & 15]; }
    writeReg(r: number, value: number) {
        value &= 0xFFFF;
        let flag: number, reg = r;
        switch (r) {
            case 0: case 1: case 2: value &= 0xFF; flag = extend8to16(value); break;
            case 32: case 33: return;
            case 34: { const top = value >> 8; this.regs[0] = top; this.regs[3] = extend8to16(top); flag = value; value &= 0xFF; reg = 1; break; }
            default: flag = value; break;
        }
        this.regs[reg & 63] = value;
        this.regs[3] = flag & 0xFFFF;
    }
    channel(i: number): Channel | null {
        const c = this.notes[i];
        if (!c) return null;
        if (c.gen !== this.noteGen[i] || !c.alive) { this.notes[i] = null; return null; }
        return c;
    }

    // -------------------------------------------------- set up
    initTrack(pc: number, parent: Track | null) {
        this.pc = pc; this.wait = 0; this.loopIndex = 0; this.intrPrev = -1;
        if (!parent) { this.tempo = 0x78; this.timeBase = 0x30; this.timeRelate = 1; this.volumeMode = 0; this.mute = 0; }
        else { this.tempo = parent.tempo; this.tempoChild = 0; this.tickRate = parent.tickRate; this.timeBase = parent.timeBase; this.timeRelate = parent.timeRelate; this.volumeMode = parent.volumeMode; this.mute = parent.mute; }
        this.notes.fill(null); this.baseTime = 0; this.connectCase = 0; this.lastNote = 0; this.beforeTie = false;
        this.seqState = 1; this.parent = parent;
        this.intrEnabled = 1; this.intrReq = 0; this.intrMask = 0; this.timerCount = 0; this.timerLeft = 0; this.timerReload = 0; this.intrTable.fill(0);
        for (const m of this.timed) { m.time = 0; m.cur = 1; m.target = 1; }
        for (const i of [1, 2, 4, 5, 13, 14, 15, 17]) { this.timed[i].cur = 0; this.timed[i].target = 0; }
        this.timed[3].cur = this.timed[3].target = 0.5; this.timed[16].cur = this.timed[16].target = 0.5;
        if ((this.kind & 2) || !parent) {
            this.regs.fill(0); this.regs[6] = 0xF0; this.regs[7] = 0x0C; this.regs[13] = 0x40;
            this.regs[8] = 0; this.regs[9] = 1; this.regs[10] = 1; this.regs[11] = 0x7FFF; this.regs[12] = 0x4000;
            this.panSwitchExt = [0, 0, 0]; this.panSwitchParent = [0, 0, 0]; this.mgr.calc = [0x1A, 0x1A, 0x1A];
        } else {
            const p = parent.regs;
            this.regs.fill(0); this.regs[6] = p[6]; this.regs[7] = p[7]; this.regs[13] = p[13];
            for (let i = 8; i <= 12; i++) this.regs[i] = p[i];
            this.panSwitchExt = parent.panSwitchExt.slice(); this.panSwitchParent = parent.panSwitchParent.slice(); this.mgr.calc = parent.mgr.calc.slice();
        }
        this.addr = [0, 0, 0, 0];
        this.children.fill(null);
        this.oscData = [ENVELOPE_DEF(), VIBRATO_DEF()];
        this.oscMode = [0xF, 0xE];
        this.oscillators[0].osc = this.oscData[0]; this.oscillators[1].osc = this.oscData[1];
        this.oscillators[1].initStart();
        this.transpose = 0; this.transposeTotal = 0;
        this.ports.fill(0); this.importFlag.fill(0); this.exportFlag.fill(0);
    }
    openTrack(i: number) {
        const old = this.children[i];
        if (old) old.closeTrack();
        const t = new Track(this.player, this.data);
        this.children[i] = t;
        return t;
    }
    startTrack(parent: Track, i: number, kind: number, pc: number) {
        this.route = ((((parent.route << 4) | i) & 0xFFFFFFF) | (((parent.route & 0xF0000000) >>> 0) + 0x10000000)) >>> 0;
        this.kind = kind;
        this.initTrack(pc, parent);
        this.updateTrackAll();
    }
    closeTrack() {
        if (!this.seqState) return;
        this.allNoteOff();
        this.seqState = 0;
        for (let i = 0; i < 16; i++) { const c = this.children[i]; if (c) { c.closeTrack(); this.children[i] = null; } }
        this.mute = 0;
    }
    allNoteOff() { for (let i = 0; i < 8; i++) this.noteOff(i, this.parent ? 0 : 10); this.notes.fill(null); }
    muteTrack(on: number) { this.mute = on; this.updateFlags |= UPD_VOL; for (const c of this.children) if (c) c.muteTrack(on); }

    // -------------------------------------------------- tempo and parameters
    updateTempo() {
        if (!this.parent) {
            this.tickRate = (this.timeBase * this.tempo) / DAC_RATE * 80 / 60;
            if (this.outer && (this.outer.switch_ & UPD_TEMPO)) this.tickRate *= this.outer.tempo;
        } else { this.tickRate = this.parent.tickRate; this.timeBase = this.parent.timeBase; }
        for (const c of this.children) if (c && c.seqState) c.updateTempo();
    }
    private panCalc(a: number, b: number, k: number, mode: number) { return mode === 0 ? a : mode === 1 ? b : a * (1 - k) + b * k; }
    private params(mask: number) {
        const T = this.timed, o = this.outer, kPar = this.regs[11] / 32767;
        let vol = T[0].cur; if (!this.volumeMode) vol *= vol; if (this.mute) vol = 0;
        if (o && (o.switch_ & UPD_VOL)) vol *= o.volume;
        let pitch = pitchToCent(T[1].cur, this.regs[7]);
        if (o && (o.switch_ & UPD_PITCH)) pitch *= o.pitch;
        let pan = T[3].cur; if (o && (o.switch_ & UPD_PAN)) pan = this.panCalc(pan, o.pan, kPar, this.panSwitchExt[0]);
        let fx = T[2].cur; if (o && (o.switch_ & UPD_FX)) fx = this.panCalc(fx, o.fxmix, kPar, this.panSwitchExt[1]);
        for (let i = 0; i < 2; i++) {
            if (this.oscMode[i] !== 0xE) continue;
            const off = this.oscillators[i].getOffsetNoCount();
            switch (this.oscillators[i].osc!.target) { case 1: pitch *= off; break; case 0: vol *= off; break; case 2: pan *= off; break; case 3: fx *= off; break; }
        }
        const m = this.mgr, P = this.parent;
        if (!P || (this.kind & 1)) {
            if (mask & UPD_VOL) m.volume = vol; if (mask & UPD_PITCH) m.pitch = pitch; if (mask & UPD_PAN) m.pan = pan; if (mask & UPD_FX) m.fxmix = fx;
        } else {
            const k = this.regs[12] / 32767;
            if (mask & UPD_VOL) m.volume = P.mgr.volume * vol;
            if (mask & UPD_PITCH) m.pitch = P.mgr.pitch * pitch;
            if (mask & UPD_PAN) m.pan = this.panCalc(pan, P.mgr.pan, k, this.panSwitchParent[0]);
            if (mask & UPD_FX) m.fxmix = this.panCalc(fx, P.mgr.fxmix, k, this.panSwitchParent[1]);
        }
    }
    updateTrackAll() { if (this.kind === 4) return; this.params(0xFFFF); }
    updateTrack(mask: number) {
        if (this.kind === 4) return;
        if ((mask & UPD_TEMPO) && !this.parent) this.updateTempo();
        this.params(mask);
    }
    updateSeq(mask: number, deep: boolean) {
        let m = mask | this.updateFlags;
        if (this.outer) { m |= this.outer.update; this.outer.update = 0; }
        this.updateFlags = 0;
        if (m) this.updateTrack(m);
        for (const c of this.children) if (c && c.seqState) { if (deep) c.updateSeq(m, deep); else c.updateFlags |= m; }
    }
    incSelfOsc() {
        for (let i = 0; i < 2; i++) if (this.oscMode[i] === 0xE) this.oscillators[i].getOffset();
        for (const c of this.children) if (c) c.incSelfOsc();
    }
    seqTimeToDspTime(t: number, gate: number) {
        let r = (t * gate) / 100;
        if (this.timeRelate) r /= this.tickRate;
        else r = (r * 120) / this.timeBase;
        return Math.trunc(r);
    }

    // -------------------------------------------------- notes (TTrack::noteOn / BankMgr::noteOn)
    noteOn(voice: number, key: number, velo: number, time: number) {
        if (this.channel(voice)) this.noteOff(voice, 0);
        const owner = this.kind === 4 && this.parent ? this.parent : this;
        const reg = this.readReg(6);
        const ch = this.player.makeChannel(owner.mgr, (reg >> 8) & 0xFF, reg & 0xFF, key & 0xFF, velo & 0xFF, time);
        if (!ch) return;
        this.notes[voice] = ch; this.noteGen[voice] = ch.gen;
        const pw = [this.regs[8], this.regs[9], this.regs[10]];
        let px = pw[0] + pw[1] + pw[2]; if (px === 0) px = 1;
        ch.power = { sound: pw[0] / px, effect: pw[1] / px, channel: pw[2] / px };
        for (let i = 0; i < 2; i++) {
            let m = this.oscMode[i];
            if (m === 0xF || m === 0xE) continue;
            if (m >= 8) { m -= 8; if (ch.oscs[m].osc) Object.assign(this.oscData[i], ch.oscs[m].osc); }
            else if (m >= 4) { m -= 4; const rel = this.oscData[i].rel; if (ch.oscs[m].osc) { Object.assign(this.oscData[i], ch.oscs[m].osc); this.oscData[i].rel = rel; } }
            ch.setOscInit(m, { ...this.oscData[i] });
            ch.effectOsc(m, ch.oscs[m].getOffset());
        }
        this.updateTrack(UPD_VOL | UPD_PITCH | UPD_PAN);
        ch.updateEffectorParam();
    }
    noteOff(voice: number, release: number) {
        const c = this.channel(voice);
        if (!c) return false;
        c.stop(release);
        this.notes[voice] = null;
        return true;
    }
    gateOn(voice: number, key: number, velo: number, time: number) {
        const c = this.channel(voice);
        if (!c || c.gate !== -1) return;
        c.gate = time; c.left = time;
        const k = c.type === 2 ? key : key + 0x3C - (c.wave ? c.wave.info.key : 60);
        c.velo = velo; c.key = key;
        c.step = c.base * c5(k);
        const v = velo / 127; c.vol = c.instVol * v * v;
    }

    // -------------------------------------------------- the interpreter (TSeqParser::mainProc)
    private cond(c: number) {
        const v = this.readReg(3);
        switch (c & 0xF) { case 0: return true; case 1: return v === 0; case 2: return v !== 0; case 3: return v === 1; case 4: return v >= 0x8000; case 5: return v < 0x8000; }
        return false;
    }
    private tryInterrupt() {
        if (this.intrPrev !== -1 || !this.intrEnabled) return;
        let r = this.intrMask & this.intrReq;
        for (let i = 0; r; i++, r >>= 1) {
            if (r & 1) {
                this.intrReq &= ~(1 << i);
                const at = this.intrTable[i];
                this.intrPrev = this.pc; this.pc = at; this.intrWait = this.wait; this.wait = 0;
                return;
            }
        }
    }
    request(i: number) { if (this.intrMask & (1 << i)) this.intrReq |= 1 << i; }
    private timerProcess() {
        if (this.timerLeft === 0) return;
        if (--this.timerLeft !== 0) return;
        this.request(6);
        if (this.timerCount) { if (--this.timerCount) this.timerLeft = this.timerReload; }
        else this.timerLeft = this.timerReload;
    }
    /** TTrack::mainProc: one tick. -1: the track ends. */
    mainProc(): number {
        if (this.parent && this.tempoChild === 1) {
            const k = Math.min(1, this.tempo / this.parent.tempo);
            this.tickCounter += k;
            if (this.tickCounter < 1) return 0;
            this.tickCounter -= 1;
        }
        this.transposeTotal = this.transpose + (this.parent ? this.parent.transposeTotal : 0);
        this.request(7);
        this.timerProcess();
        let rc: number;
        do {
            this.tryInterrupt();
            if (this.wait === -1) { if (this.channel(0)) break; this.wait = 0; }
            if (this.wait > 0) {
                if (--this.wait !== 0) break;
                if (this.baseTime !== -1 && this.connectCase === 0) this.notes[0] = null;   // TNoteMgr::endProcess
            }
            rc = this.parse();
            if (rc === -1) return -1;
        } while (rc === -2);
        let mask = 0;
        for (let i = 0; i < 18; i++) {
            const p = this.timed[i];
            if (p.time > 0) {
                p.cur += p.amount; p.time -= 1;
                if (i <= 5 || i >= 11) mask |= 1 << i;
                else this.oscUpdate(i, p.cur);
            }
        }
        for (let i = 0; i < 2; i++) if (this.oscMode[i] === 0xE) mask |= OSC_UPD[this.oscData[i].target] || 0;
        this.updateFlags |= mask;
        this.updateSeq(0, false);
        for (let i = 0; i < 16; i++) {
            const c = this.children[i];
            if (c && c.seqState && c.mainProc() === -1) { c.closeTrack(); this.children[i] = null; }
        }
        return 0;
    }
    private oscUpdate(i: number, v: number) {
        switch (i) { case 6: this.oscData[0].width = v; break; case 7: this.oscData[0].rate = v; break; case 8: this.oscData[0].vertex = v; break; case 9: this.oscData[1].width = v; break; case 10: this.oscData[1].rate = v; break; case 11: this.oscData[1].vertex = v; break; }
    }
    /** TSeqParser::mainProc: commands until one waits (0), the track returns from an interrupt (-2) or ends (-1) */
    private parse(): number {
        for (let guard = 0; guard < 100000; guard++) {
            if (this.pc >= this.data.length) return -1;
            const f = this.rb();
            let rc = 0;
            if (!(f & 0x80)) rc = this.cmdNoteOn(f);
            else if ((f & 0xF0) === 0x80 && !(f & 7)) rc = this.cmdWaitShort(f);
            else if ((f & 0xF0) === 0x80 || f === 0xF9) rc = this.cmdNoteOff(f);
            else switch (f & 0xF0) {
                case 0x90: this.writeTimeParam(f & 0xF); break;
                case 0xA0: this.writeRegParam(f & 0xF); break;
                case 0xB0: rc = this.regCmd(f & 8 ? 1 : 0, f & 7); break;
                default: rc = this.cmd(f, 0); break;
            }
            if (rc === 0) continue;
            if (rc === 1) return 0;
            if (rc === 2) return -2;
            if (rc === 3) return -1;
        }
        return 0;
    }
    private cmdWaitShort(f: number) {
        let v = 0;
        for (let i = 0; i < (f === 0x80 ? 1 : 2); i++) v = (v << 8) | this.rb();
        this.wait = v;
        return v ? 1 : 0;
    }
    private cmdNoteOff(f: number) {
        if (f === 0xF9) {
            const b = this.rb(), v = this.exch(b & 7) & 0xFF;
            if (v > 7 || v === 0) { if (b & 0x80) this.rb(); return 0; }
            f = v + 0x80; if (b & 0x80) f |= 8;
        }
        let note = f & 0xF, release = 0;
        if (note & 8) { note -= 8; release = this.rb(); if (release > 100) release = (release - 98) * 20; }
        this.noteOff(note, release);
        return 0;
    }
    private cmdNoteOn(n: number) {
        let key = (n + this.transposeTotal) & 0xFF;
        const c = this.rb();
        if (c & 0x80) { key = (this.exch(key) + this.transposeTotal) & 0xFF; }
        const connect = (c >> 5) & 3, length = (c >> 3) & 3, voiceBits = c & 7;
        let sweepTo = 0;
        if (connect & 2) { sweepTo = key; key = this.lastNote; }
        let velo = this.rb();
        if (velo >= 0x80) velo = this.exch(velo - 0x80) & 0xFF;
        let time: number, voice: number, gate: number;
        if (voiceBits === 0) {
            voice = 0;
            gate = this.rb(); if (gate >= 0x80) gate = this.exch(gate - 0x80) & 0xFF;
            time = 0;
            for (let i = 0; i < length; i++) time = (time << 8) | this.rb();
            if (length === 1 && time >= 0x80) time = this.exch(time - 0x80);
        } else {
            voice = voiceBits;
            if (length) voice = this.exch(voice - 1) & 7;
            time = -1; gate = 100;
        }
        this.connectCase = connect;
        let dsp = time;
        if (this.beforeTie) {
            if (connect & 1) dsp = -1;
            if (dsp !== -1) dsp = this.seqTimeToDspTime(dsp, gate);
            this.gateOn(voice, key, velo, dsp);
        } else {
            if (dsp !== -1) dsp = this.seqTimeToDspTime(dsp, gate);
            if (connect & 1) dsp = -1;
            this.noteOn(voice, key, velo, dsp);
        }
        this.baseTime = time;
        this.beforeTie = !!(connect & 1);
        if (connect & 2) {
            if (dsp === -1) dsp = this.seqTimeToDspTime(time, gate);
            const ch = this.channel(0);
            if (ch) this.player.keySweep(ch, (sweepTo + this.transposeTotal) & 0xFF, dsp);
            key = sweepTo;
        }
        this.lastNote = key;
        if (time === -1) return 0;
        this.wait = time ? time : -1;
        return 1;
    }
    private writeTimeParam(p: number) {
        const which = this.rb();
        let v = 0;
        switch (p & 0xC) {
            case 0: v = s16(this.readReg(this.rb())); break;
            case 4: v = s16(this.rb()); break;
            case 8: { const b = this.rb(); v = s16(b & 0x80 ? b << 8 : (b << 8) | (b << 1)); break; }
            case 0xC: v = s16(this.r16()); break;
        }
        let t = 0;
        switch (p & 3) { case 0: t = -1; break; case 1: t = this.readReg(this.rb()); break; case 2: t = this.rb(); break; case 3: t = this.r16(); break; }
        const m = this.timed[which];
        if (!m) return;
        m.target = v / 32768;
        if (t <= 0) { m.cur = m.target; m.amount = 0; m.time = 1; }
        else { m.amount = (m.target - m.cur) / t; m.time = t; }
    }
    private writeRegParam(param: number) {
        let src = param & 0xC, op = param & 3, tblKind = 0;
        if ((param & 0xF) === 0xB) { src = 0; op = 0xB; }
        if ((param & 0xF) === 0xA) { op = 10; param = this.rb(); src = param & 0xC; tblKind = ((param >> 4) & 0xF) + 4; }
        if ((param & 0xF) === 0x9) { op = this.rb(); src = op & 0xC; op &= 0xF0; if (src === 8) src = 0x10; }
        let reg = this.rb();
        let base = 0;
        if (op === 10) base = this.readReg32(this.rb());
        let v = 0;
        switch (src) {
            case 0: v = s16(this.readReg(this.rb())); break;
            case 4: v = s16(this.rb()); break;
            case 8: { const b = this.rb(); v = s16(b & 0x80 ? b << 8 : (b << 8) | (b << 1)); break; }
            case 0xC: v = s16(this.r16()); break;
            case 0x10: v = -1; break;
        }
        const cur = s16(this.readReg(reg));
        switch (op) {
            case 0: break;
            case 1: if (src === 4) v = s16(extend8to16(v & 0xFF)); v = s16(cur + v); break;
            case 2: { const prod = ((cur & 0xFFFF) * v) >>> 0; this.writeReg(4, prod >>> 16); this.writeReg(5, prod); return; }
            case 3: this.regs[3] = (cur - v) & 0xFFFF; return;
            case 0xB: v = s16(cur - v); break;
            case 0x10: if (src === 4) v = s16(extend8to16(v & 0xFF)); v = s16(v < 0 ? (cur & 0xFFFF) >>> -v : (cur & 0xFFFF) << v); break;
            case 0x20: if (src === 4) v = s16(extend8to16(v & 0xFF)); v = s16(v < 0 ? cur >> -v : cur << v); break;
            case 0x30: v = s16(cur & v); break;
            case 0x40: v = s16(cur | v); break;
            case 0x50: v = s16(cur ^ v); break;
            case 0x60: v = s16(-cur); break;
            case 0x90: { const r = randS32() >>> 0, m = v & 0xFFFF; v = s16(m ? r % m : 0); break; }
            case 0xA: { base = this.loadTbl(base, v & 0xFFFF, tblKind); v = s16(base); break; }
        }
        let flag: number;
        switch (reg) {
            case 0: case 1: case 2: v &= 0xFF; flag = extend8to16(v); break;
            case 0x21: v = (v & 0xFF) | (this.regs[6] & 0xFF00); reg = 6; flag = v; break;
            case 0x20: v = ((v << 8) & 0xFF00) | (this.regs[6] & 0xFF); reg = 6; flag = v; break;
            case 0x2E: v = (this.regs[13] & 0xFF00) | (v & 0xFF); reg = 0xD; flag = v; break;
            case 0x2F: v = ((v << 8) & 0xFF00) | (this.regs[13] & 0xFF); reg = 0xD; flag = v; break;
            case 0x22: this.writeReg(0, (v >> 8) & 0xFF); v &= 0xFF; flag = v; reg = 1; break;
            case 0x28: case 0x29: case 0x2A: case 0x2B: this.addr[reg - 0x28] = base; return;
            default: flag = v; break;
        }
        this.regs[reg & 63] = v & 0xFFFF;
        this.regs[3] = flag & 0xFFFF;
        if (reg === 6) for (let i = 0; i < 2; i++) if (this.oscMode[i] !== 0xE) this.oscMode[i] = 0xF;
        if (reg === 7) this.updateFlags |= UPD_PITCH;
    }
    private loadTbl(base: number, i: number, kind: number) {
        switch (kind) {
            case 4: return this.g8(base + i);
            case 5: return this.g16(base + 2 * i);
            case 6: return this.g24(base + 3 * i);
            case 7: return this.g32(base + 4 * i);
            case 8: return this.g32(base + i);
        }
        return 0;
    }
    private regCmd(useReg: number, n: number) {
        let op = this.rb();
        if (useReg) op = this.exch(op) & 0xFF;
        let mask = 0;
        if (useReg === 0 || n !== 0) {
            let b = this.rb(), bit = 3;
            for (let i = 0; i < n + 1; i++) { if (b & 0x80) mask |= bit; b = (b << 1) & 0xFF; bit <<= 2; }
        }
        return this.cmd(op, mask);
    }
    private cmd(f: number, extra: number): number {
        const idx = f - 0xC0;
        if (idx < 0 || idx >= 0x40) return 0;
        const [n, fmt0] = ARGLIST[idx];
        let fmt = fmt0 | extra;
        const a: number[] = [];
        for (let i = 0; i < n; i++) {
            switch (fmt & 3) {
                case 0: a.push(this.rb()); break;
                case 1: a.push(this.r16()); break;
                case 2: a.push(this.r24()); break;
                case 3: a.push(this.exch(this.rb())); break;
            }
            fmt >>= 2;
        }
        return this.exec(idx, a);
    }
    private exec(i: number, a: number[]): number {
        switch (i) {
            case 0x01: case 0x02: {   // openTrack / openTrackBros
                const p = i === 1 ? this : this.parent;
                if (!p) return 0;
                const n = a[0] & 0xF, kind = a[0] & 0x20 ? 4 : (a[0] >> 6) & 3;
                p.openTrack(n).startTrack(p, n, kind, a[1]);
                return 0;
            }
            case 0x04: {   // call
                const fl = this.rb();
                let off: number;
                if (fl & 0x80) {
                    off = this.readReg(this.rb());
                    if (fl & 0x40) { const o = fl & 0x20 ? this.readReg(this.rb()) : this.r24(); off = this.g24(o + off * 3); }
                } else off = this.r24();
                if (this.cond(fl) && this.loopIndex < 8) { this.stack[this.loopIndex++] = this.pc; this.pc = off; }
                return 0;
            }
            case 0x06:   // ret
                if (this.cond(a[0])) { if (this.loopIndex === 0) return 3; this.pc = this.stack[--this.loopIndex]; }
                return 0;
            case 0x08: {   // jmp
                const fl = this.rb();
                let off = 0;
                if (fl & 0x80) {
                    const c = this.rb();
                    if (fl & 0x40) { const r = this.readReg(c); const o = fl & 0x20 ? this.readReg(this.rb()) : this.r24(); off = this.g24(o + r * 3); }
                    else off = this.readReg32(c);
                } else off = this.r24();
                if (this.cond(fl)) this.pc = off;
                return 0;
            }
            case 0x09: if (this.loopIndex < 8) { this.stack[this.loopIndex] = this.pc; this.loopTimers[this.loopIndex++] = a[0]; } return 0;   // loopS
            case 0x0A: {   // loopE
                if (this.loopIndex === 0) return 0;
                let t = this.loopTimers[this.loopIndex - 1];
                if (t) t--;
                if (t === 0) { this.loopIndex--; return 0; }
                this.loopTimers[this.loopIndex - 1] = t;
                this.pc = this.stack[this.loopIndex - 1];
                return 0;
            }
            case 0x0B: this.importFlag[a[0] & 15] = 0; this.writeReg(a[1], this.ports[a[0] & 15]); return 0;   // readPort
            case 0x0C: this.exportFlag[a[0] & 15] = 1; this.ports[a[0] & 15] = a[1]; return 0;   // writePort
            case 0x0D: this.writeReg(3, this.importFlag[a[0] & 15]); return 0;
            case 0x0E: this.writeReg(3, this.exportFlag[a[0] & 15]); return 0;
            case 0x0F: case 0x2A: this.wait = a[0]; return a[0] !== 0 ? 1 : 0;   // wait
            case 0x11: if (this.parent) this.parent.writePortDirect(a[0] & 0xF, a[1]); return 0;
            case 0x12: { const c = this.children[a[0] >> 4]; if (c) c.writePortDirect(a[0] & 0xF, a[1]); return 0; }
            case 0x14: this.lastNote = (a[0] + this.transposeTotal) & 0xFF; return 0;
            case 0x15: this.timeRelate = a[0] ? 1 : 0; return 0;
            case 0x16:   // simpleOsc
                if (a[0] === 0) this.oscData[1] = VIBRATO_DEF(); else if (a[0] === 1) this.oscData[0] = TREMORO_DEF(); else if (a[0] === 2) this.oscData[1] = TREMORO_DEF();
                this.oscillators[0].osc = this.oscData[0]; this.oscillators[1].osc = this.oscData[1];
                return 0;
            case 0x17:   // simpleEnv
                if (a[0] === 0) { this.oscData[0] = ENVELOPE_DEF(); this.oscData[0].ads = this.table(a[1]); this.oscillators[0].osc = this.oscData[0]; }
                else if (a[0] === 1) this.oscData[0].rel = this.table(a[1]);
                return 0;
            case 0x18: {   // simpleADSR
                this.oscData[0] = ADSR_DEF(); this.oscillators[0].osc = this.oscData[0];
                this.adsTable[1] = s16(a[0]); this.adsTable[4] = s16(a[1]); this.adsTable[7] = s16(a[2]); this.adsTable[8] = s16(a[3]); this.relTable[1] = s16(a[4]);
                this.oscData[0].ads = Int16Array.from(this.adsTable); this.oscData[0].rel = Int16Array.from(this.relTable);
                return 0;
            }
            case 0x19: this.transpose = (a[0] << 24) >> 24; this.transposeTotal = this.transpose + (this.parent ? this.parent.transpose : 0); return 0;
            case 0x1A: { const c = this.children[a[0] & 15]; if (c) { c.closeTrack(); this.children[a[0] & 15] = null; } return 0; }
            case 0x1B: if (this.outer) { this.outer.switch_ = a[0]; this.outer.update = 0xFFFF; } return 0;
            case 0x1C: this.updateTrack(a[0]); return 0;
            case 0x1F: this.intrMask |= 1 << a[0]; this.intrTable[a[0] & 7] = a[1]; return 0;
            case 0x20: this.intrMask &= ~(1 << a[0]); return 0;
            case 0x21: this.intrEnabled = 1; this.intrPrev = -1; return 0;
            case 0x22: this.intrEnabled = 0; return 0;
            case 0x23:   // retI
                this.intrEnabled = 1;
                if (this.intrPrev !== -1) { this.wait = this.intrWait; this.pc = this.intrPrev; this.intrPrev = -1; }
                return 2;
            case 0x24: this.timerCount = a[0]; this.timerLeft = a[1]; this.timerReload = a[1]; return 0;
            case 0x27: this.writeReg(3, 0xFFFF); return 0;   // syncCPU (no game callback)
            case 0x28: for (let k = 0; k < 8; k++) this.noteOff(k, 0); return 0;   // flushAll
            case 0x29: for (const c of this.player.channels) if (c.mgr === this.mgr) c.stop(); return 0;   // flushRelease
            case 0x2B: this.regs[8] = a[0]; this.regs[9] = a[1]; this.regs[10] = a[2]; this.regs[11] = Math.trunc(a[3] * 327.67); this.regs[12] = Math.trunc(a[4] * 327.67); return 0;
            case 0x2F: {   // panSwSet
                const ext = [0, 0, 0, 1, 1, 2, 2], par = [0, 1, 2, 0, 2, 0, 2];
                for (let k = 0; k < 3; k++) { this.panSwitchExt[k] = ext[a[k] >> 5] ?? 0; this.panSwitchParent[k] = par[a[k] >> 5] ?? 0; this.mgr.calc[k] = a[k] & 0x1F; }
                this.updateFlags |= UPD_PAN;
                return 0;
            }
            case 0x30: { const k = (a[0] >> 4) & 0xF, v = a[0] & 0xF; if (k < 2) { this.oscMode[k] = v; if (v === 0xE) this.oscillators[k].initStart(); } return 0; }
            case 0x32: {   // oscFull
                const p = a[0], k = (p & 0x10) >> 4, tgt = p & 0xF;
                if (p & 0x80) { this.oscData[k] = ENVELOPE_DEF(); this.oscData[k].target = tgt; if (tgt === 1) this.oscData[k].vertex = 1; this.oscillators[k].osc = this.oscData[k]; }
                if (p & 0x40) this.oscData[k].ads = this.table(a[1]);
                if (p & 0x20) this.oscData[k].rel = this.table(a[2]);
                return 0;
            }
            case 0x33: this.volumeMode = a[0]; return 0;
            case 0x3A: this.writeReg(3, 0); return 0;   // checkWave
            case 0x3B: {   // printf: skip the string and its arguments
                let count = 0;
                for (let k = 0; k < 128; k++) {
                    const ch = this.rb();
                    if (!ch) break;
                    if (ch === 0x5C) { if (!this.rb()) break; continue; }
                    if (ch === 0x25) { if (!this.rb()) break; count++; }
                }
                for (let k = 0; k < count; k++) this.rb();
                return 0;
            }
            case 0x3D: this.tempo = a[0]; if (!this.parent) this.updateTempo(); else this.tempoChild = 1; return 0;
            case 0x3E: this.timeBase = a[0]; if (!this.parent) this.updateTempo(); return 0;
            case 0x3F: {   // finish
                let mask = 0;
                for (let k = 0; k < 18; k++) { const p = this.timed[k]; if (p.time > 0) { p.cur += p.amount; p.time -= 1; if (k <= 5 || k >= 11) mask |= 1 << k; else this.oscUpdate(k, p.cur); } }
                this.updateSeq(mask, true);
                return 3;
            }
            default: return 0;   // connect names, bus connections, filters, pause status: not modelled
        }
    }
    private table(off: number): Int16Array {
        const out: number[] = [];
        for (let p = off; p + 6 <= this.data.length; p += 6) { const m = s16(this.g16(p)); out.push(m, s16(this.g16(p + 2)), s16(this.g16(p + 4))); if (m > 0xA) break; }
        return Int16Array.from(out);
    }
    writePortDirect(port: number, v: number) {
        this.importFlag[port] = 1; this.ports[port] = v & 0xFFFF;
        if (port <= 1) this.request(port === 0 ? 3 : 4);
    }
    /** TTrack::routeTrack: a descendant by its route (depth in the top nibble, child numbers low first) */
    routeTrack(route: number): Track | null {
        let t: Track | null = this, n = route >>> 28;
        for (let i = 0; i < n && t; i++, route >>>= 4) t = t.children[route & 0xF];
        return t;
    }
    writePortApp(route: number, v: number) {
        const t = this.routeTrack(route);
        if (!t) return false;
        const p = (route >>> 16) & 0xFF;
        if (p >= 16) return false;
        t.writePortDirect(p, v);
        return true;
    }
    readPortApp(route: number): number | null {
        const t = this.routeTrack(route);
        if (!t) return null;
        const p = (route >>> 16) & 0xFF;
        t.exportFlag[p & 15] = 0;
        return t.ports[p & 15];
    }
    /** TTrack::rootCallback: a subframe of a root track. false: it has ended. */
    tickRoot(): boolean {
        if (!this.seqState) return false;
        this.tickCounter += this.tickRate;
        if (this.tickCounter < 1) this.updateSeq(0, true);
        else while (this.tickCounter >= 1) {
            this.tickCounter -= 1;
            if (this.mainProc() === -1) { this.updateSeq(0, true); this.closeTrack(); return false; }
        }
        this.incSelfOsc();
        return true;
    }
}

// ---------------------------------------------------------------- the player
export interface PlayerData {
    banks: (Bank | null)[];
    /** vir2phy: the bank's virtual id → its index */
    bankByVirtual: Map<number, number>;
    /** the wave bank each bank plays from */
    waveBankOf: number[];
    waves: WaveSource;
}

export class Player {
    channels: Channel[] = [];
    roots = new Set<Track>();
    maxVoices = 96;
    constructor(public d: PlayerData) { }
    /** BankMgr::noteOn: a channel for the instrument (bank, program), key and velocity; time: its gate (-1: until note off) */
    makeChannel(mgr: ChannelMgr, bank: number, prog: number, key: number, velo: number, time: number): Channel | null {
        const ch = new Channel(mgr);
        ch.velo = velo; ch.key = key;
        if (prog > 0xEF) {   // noteOnOsc: the DSP's own oscillator
            ch.type = 2; ch.oscWave = prog - 0xF0;
            ch.base = 16736.016 / DAC_RATE; ch.step = ch.base * c5(key);
            ch.instVol = 1; const v = velo / 127; ch.vol = v * v;
            ch.pan.sound = 0.5; ch.fx.sound = 0;
            ch.setOscInit(0, OSC_ENV);
        } else {
            const phys = this.d.bankByVirtual.get(bank);
            const b = phys === undefined ? null : this.d.banks[phys];
            if (!b) return null;
            let vol = 1, pitch = 1, effVol = 1, effPitch = 1, pan = 0.5, effPan = 0.5, fixed = false, release = 0;
            let oscs: Osc[] = [], effects: InstEffect[] = [], vr: VeloRegion | null = null;
            if (prog < 0x80) {
                const inst: Inst | null = b.insts[prog];
                if (!inst) return null;
                vol *= inst.volume; pitch *= inst.pitch; oscs = inst.osc; effects = inst.effects;
                const km = inst.keymaps.find((k) => key <= k.highKey);
                if (!km) return null;
                vr = km.velos.find((r) => velo <= r.velo) || null;
            } else if (prog >= 0xE4) {
                const set = b.percs[prog - 0xE4], p: Perc | null | undefined = set ? set[key] : null;
                if (!p) return null;
                fixed = true; vol *= p.volume; pitch *= p.pitch; pan = p.pan; release = p.release; effects = p.effects;
                oscs = [oscDef({})];
                vr = p.velos.find((r) => velo <= r.velo) || null;
            } else return null;
            if (!vr) return null;
            for (const e of effects) {
                let y: number;
                if (e.kind === 'rand') y = randS() * e.width + e.base;
                else {
                    const src = e.reg === 1 ? velo : e.reg === 2 ? key : 0, split = e.key!;
                    if (split === 0x7F || split === 0) y = e.lo! + (src * (e.hi! - e.lo!)) / 127;
                    else if (src < split) y = e.lo! + (1 - e.lo!) * (src / split);
                    else y = (e.hi! - 1) * ((src - split) / (0x7F - split)) + 1;
                }
                switch (e.target) { case 0: effVol *= y; break; case 1: effPitch *= y; break; case 2: effPan = y; break; }
            }
            vol *= vr.volume; pitch *= vr.pitch;
            const w = this.d.waves.wave(this.d.waveBankOf[phys!] ?? 0, vr.wave);
            if (!w || !w.pcm) return null;
            ch.wave = w;
            ch.base = pitch * (w.info.rate / DAC_RATE);
            ch.step = ch.base * effPitch;
            if (!fixed) ch.step *= c5(key + 0x3C - w.info.key);
            ch.instVol = vol;
            const v = velo / 127; ch.vol = vol * v * v * effVol;
            ch.pan.sound = clamp01(pan); ch.pan.effect = effPan;
            for (let i = 0; i < oscs.length && i < 4; i++) ch.setOscInit(i, oscs[i]);
            ch.oscs[0].direct = release;
        }
        ch.gate = time === 0 ? -1 : time; ch.left = ch.gate;
        for (let i = 0; i < 4; i++) if (ch.oscs[i].osc) ch.effectOsc(i, ch.oscs[i].getOffset());
        ch.updateEffectorParam();
        if (this.channels.length >= this.maxVoices) {
            // the oldest released voice goes first, else the oldest
            let k = this.channels.findIndex((c) => c.released);
            if (k < 0) k = 0;
            this.channels[k].alive = false; this.channels.splice(k, 1);
        }
        this.channels.push(ch);
        return ch;
    }
    keySweep(ch: Channel, key: number, time: number) {
        const k = ch.type === 2 || !ch.wave ? key : key + 0x3C - ch.wave.info.key;
        const to = c5(k) * ch.base;
        if (time <= 0) { ch.step = to; ch.sweepLeft = 0; return; }
        ch.sweepTo = to; ch.sweepLeft = time;
    }
    /** a sequence from its data: a new root track */
    start(data: Uint8Array, outer?: OuterParam): Track {
        const t = new Track(this, data);
        t.kind = 3; t.route = 0;
        t.outer = outer || new OuterParam();
        t.initTrack(0, null);
        t.tickCounter = 0; t.tickRate = 1;
        t.updateTrackAll();
        this.roots.add(t);
        return t;
    }
    stop(t: Track) { t.closeTrack(); this.roots.delete(t); }
    /** one subframe: the sequences tick, then the channels update */
    subframe() {
        for (const t of this.roots) if (!t.tickRoot()) this.roots.delete(t);
        for (const c of this.channels) c.update();
        this.channels = this.channels.filter((c) => c.alive);
    }
}

// ---------------------------------------------------------------- the mixer (in place of the DSP)
export class Mixer {
    private acc = 0;
    /** Driver::setMixerLevel's channel level (0.802 * 16384 of 32767), with an output gain past it (1.6: a guess,
     *  set from the real data so the loudest stage music and SEs peak near 0.8) */
    gain = 0.802 * 16384 / 32767 * 1.6;
    constructor(public players: { player: Player; gain: number }[], public rate: number) { }
    /** n stereo samples at the output rate (added to L and R) */
    render(L: Float32Array, R: Float32Array, n: number) {
        const sub = this.rate / SUBFRAME_RATE;
        let i = 0;
        while (i < n) {
            if (this.acc <= 0) { for (const p of this.players) p.player.subframe(); this.acc += sub; }
            const m = Math.min(n - i, Math.ceil(this.acc));
            for (const p of this.players) this.mix(p.player, L, R, i, m, p.gain);
            i += m; this.acc -= m;
        }
    }
    /** a subframe without output: the sequences and voices move on (seeking) */
    static skip(p: Player) {
        p.subframe();
        for (const c of p.channels) c.pos += c.outStep * 80;
    }
    private mix(P: Player, L: Float32Array, R: Float32Array, at: number, n: number, gain: number) {
        const ratio = DAC_RATE / this.rate, g = this.gain * gain / 32768;
        for (const c of P.channels) {
            if (!c.alive) continue;
            const tl = c.outVol * Math.sin((1 - c.outPan) * Math.PI / 2) * g, tr = c.outVol * Math.sin(c.outPan * Math.PI / 2) * g;
            const dl = (tl - c.prevL) / n, dr = (tr - c.prevR) / n;
            let vl = c.prevL, vr = c.prevR;
            const step = c.outStep * ratio;
            if (c.type === 2) {
                // the DSP's oscillators: a sine for 0, a square otherwise (approximation)
                for (let k = 0; k < n; k++) {
                    const ph = c.pos - Math.floor(c.pos);
                    const s = (c.oscWave === 0 ? Math.sin(ph * 2 * Math.PI) : ph < 0.5 ? 1 : -1) * 16384;
                    L[at + k] += s * vl; R[at + k] += s * vr; vl += dl; vr += dr;
                    c.pos += step / 32;
                }
            } else {
                const w = c.wave!, pcm = w.pcm!, info = w.info, end = info.loop ? Math.min(info.loopEnd, pcm.length) : pcm.length;
                for (let k = 0; k < n; k++) {
                    let p = c.pos;
                    if (p >= end - 1) {
                        if (info.loop && end - info.loopStart > 1) { p = info.loopStart + ((p - info.loopStart) % (end - info.loopStart)); c.pos = p; }
                        else { c.alive = false; break; }
                    }
                    const j = p | 0, f = p - j;
                    const nx = j + 1 < end ? pcm[j + 1] : info.loop ? pcm[info.loopStart] : 0;
                    const s = pcm[j] + (nx - pcm[j]) * f;
                    L[at + k] += s * vl; R[at + k] += s * vr; vl += dl; vr += dr;
                    c.pos = p + step;
                }
            }
            c.prevL = tl; c.prevR = tr;
        }
    }
}

/** The waves of the loaded wave systems, decoded from their archives the first time they play. */
export class WaveStore implements WaveSource {
    private cache = new Map<string, WaveRef>();
    constructor(public systems: { waves: Map<number, WaveInfo> }[], public aw: Map<string, Uint8Array>) { }
    wave(bank: number, id: number): WaveRef | null {
        const k = bank + ':' + id;
        let r = this.cache.get(k);
        if (r) return r;
        const ws = this.systems[bank];
        const info = ws && ws.waves.get(id);
        if (!info) return null;
        const file = this.aw.get(info.aw.toLowerCase());
        if (!file) return null;
        r = { info, pcm: decodeWave(file, info) };
        this.cache.set(k, r);
        return r;
    }
}
