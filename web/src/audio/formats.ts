// The game's audio data (JAudio 1, JSystem/JAudio in the decomp: JAIBasic.cpp, JASBNKParser.cpp,
// JASWSParser.cpp, JASVload.cpp, JAIData.cpp): the init data (mSound.aaf), instrument banks
// (IBNK), wave systems (WSYS) and their wave archives (.aw), the sequence archive's header, and the
// sound info tables. Everything is big-endian; offsets in a bank or wave system are from its start.

export type Bytes = Uint8Array;
const dv = (b: Bytes) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const str = (b: Bytes, o: number, n: number) => { let s = ''; for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]); return s; };

// ---------------------------------------------------------------- mSound.aaf (JAIBasic::checkInitDataOnMemory)
export interface InitData {
    /** the sound info tables (SE, sequences, streams): JaiSeInf / JaiSqInf / JaiStInf */
    seTable: Bytes | null; seqTable: Bytes | null; streamTable: Bytes | null;
    separateTables: boolean;
    /** banks: the IBNK, the wave bank it plays from */
    banks: { data: Bytes; waveBank: number }[];
    /** wave banks: the WSYS, when it's loaded (0: at boot, stays) */
    waveBanks: { data: Bytes; loadTiming: number }[];
    /** the sequence archive's header (Vload's VLArc) */
    seqArcHeader: Bytes | null;
    /** sound scenes: per scene, per SE category, how many play at once (JAICategoryInfo) */
    soundScenes: { maxPlaying: number; maxSame: number }[][] | null;
}
export function parseAAF(b: Bytes): InitData {
    const v = dv(b), u = (i: number) => v.getUint32(i * 4);
    const out: InitData = { seTable: null, seqTable: null, streamTable: null, separateTables: false, banks: [], waveBanks: [], seqArcHeader: null, soundScenes: null };
    const blob = (off: number, size: number) => b.subarray(off, off + size);
    let i = 0;
    for (let guard = 0; guard < 4096; guard++) {
        const cmd = u(i++);
        if (cmd === 0) break;
        switch (cmd) {
            case 1:
                if (u(i + 2) !== 0) {
                    out.seTable = blob(u(i), u(i + 1)); i += 2;
                    out.seqTable = blob(u(i), u(i + 1)); i += 2;
                    out.streamTable = blob(u(i), u(i + 1)); i += 2;
                    out.separateTables = true;
                } else { out.seTable = blob(u(i), u(i + 1)); i += 3; }
                break;
            case 2:
                while (u(i) !== 0) { out.banks.push({ data: b.subarray(u(i)), waveBank: u(i + 2) }); i += 3; }
                i++;
                break;
            case 3:
                while (u(i) !== 0) { out.waveBanks.push({ data: b.subarray(u(i)), loadTiming: u(i + 2) }); i += 3; }
                i++;
                break;
            case 4: out.seqArcHeader = blob(u(i), u(i + 1)); i += 3; break;
            case 5: i += 3; break;   // the stream list
            case 6: {
                const t = blob(u(i), u(i + 1)), tv = dv(t), n = tv.getUint32(0);
                out.soundScenes = [];
                for (let s = 0; s < n; s++) {
                    const o = tv.getUint32(4 + s * 4), cats: { maxPlaying: number; maxSame: number }[] = [];
                    for (let c = 0; c < 16; c++) cats.push({ maxPlaying: t[o + c * 2], maxSame: t[o + c * 2 + 1] });
                    out.soundScenes.push(cats);
                }
                i += 3;
                break;
            }
            case 7: case 8: i += 3; break;
            default: while (u(i++) !== 0) { /* unknown: skip to the next 0 */ } break;
        }
    }
    return out;
}

// ---------------------------------------------------------------- sound info tables (JAIData::initInfoDataWork)
export interface SoundInfo { swBit: number; priority: number; track: number; offsetNo: number; pitch: number; volume: number; fxmix: number; }
export class SoundTable {
    soundMax: number[] = []; first: number[] = []; categoryMax = 0;
    constructor(public data: Bytes) {
        const v = dv(data);
        for (let i = 0; i < 18; i++) {
            this.soundMax.push(v.getUint16(i * 4 + 6));
            this.first.push(v.getUint16(i * 4 + 8));
            if (i < 16 && this.soundMax[i]) this.categoryMax = i + 1;
        }
    }
    /** JAIData::getInfoPointer: the sound's info (category from the ID: SE (id >> 12) & 0xFF, sequences 16, streams 17) */
    info(id: number): SoundInfo | null {
        const type = (id & 0xC0000000) >>> 0;
        const cat = type === 0 ? (id >>> 12) & 0xFF : type === 0x80000000 ? 16 : 17;
        const idx = id & 0x3FF;
        if (cat >= 18 || idx >= this.soundMax[cat]) return null;
        const o = 0x50 + (this.first[cat] + idx) * 0x10, v = dv(this.data);
        if (o + 0x10 > this.data.length) return null;
        return { swBit: v.getUint32(o), priority: this.data[o + 4], track: this.data[o + 5], offsetNo: v.getUint16(o + 6), pitch: v.getFloat32(o + 8), volume: this.data[o + 0xC], fxmix: this.data[o + 0xD] };
    }
}

// ---------------------------------------------------------------- the sequence archive (JASVload.cpp)
export class SeqArchive {
    count: number; fileName: string;
    constructor(public header: Bytes) {
        const v = dv(header);
        this.count = v.getUint32(0xC);
        this.fileName = str(header, 0x10, 0x10);
    }
    /** Vload::getRealHandle: the entry (following its redirects); its offset and size in the archive file */
    entry(i: number): { offset: number; size: number } | null {
        if (i < 0 || i >= this.count) return null;
        const v = dv(this.header);
        let o = 0x20 * (i + 1);
        for (let g = 0; g < 64 && v.getUint16(o + 0xE) !== 0xFFFF; g++) o = 0x20 * (v.getUint16(o + 0xE) + 1);
        return { offset: v.getUint32(o + 0x18), size: v.getUint32(o + 0x1C) };
    }
}

// ---------------------------------------------------------------- IBNK (JASBNKParser.cpp)
export interface Osc { target: number; rate: number; ads: Int16Array | null; rel: Int16Array | null; width: number; vertex: number; }
export interface InstEffect { kind: 'rand' | 'sense'; target: number; base: number; width: number; reg?: number; key?: number; lo?: number; hi?: number; }
export interface VeloRegion { velo: number; wave: number; volume: number; pitch: number; }
export interface Inst { volume: number; pitch: number; osc: Osc[]; effects: InstEffect[]; keymaps: { highKey: number; velos: VeloRegion[] }[]; }
export interface Perc { volume: number; pitch: number; pan: number; release: number; effects: InstEffect[]; velos: VeloRegion[]; }
export interface Bank { virtualId: number; insts: (Inst | null)[]; percs: ((Perc | null)[] | null)[]; }

function oscTable(v: DataView, o: number): Int16Array | null {
    if (!o) return null;
    // getOscTableEndPtr: rows of 3 until a mode above 0xA
    const out: number[] = [];
    for (let p = o; p + 6 <= v.byteLength; p += 6) {
        const m = v.getInt16(p);
        out.push(m, v.getInt16(p + 2), v.getInt16(p + 4));
        if (m > 0xA) break;
    }
    return Int16Array.from(out);
}
export function parseBank(b: Bytes): Bank {
    const v = dv(b), u32 = (o: number) => v.getUint32(o), f32 = (o: number) => v.getFloat32(o);
    const oscCache = new Map<number, Osc>();
    const osc = (o: number): Osc => {
        let r = oscCache.get(o);
        if (!r) { r = { target: b[o], rate: f32(o + 4), ads: oscTable(v, u32(o + 8)), rel: oscTable(v, u32(o + 0xC)), width: f32(o + 0x10), vertex: f32(o + 0x14) }; oscCache.set(o, r); }
        return r;
    };
    const rand = (o: number): InstEffect => ({ kind: 'rand', target: b[o], base: f32(o + 4), width: f32(o + 8) });
    const sense = (o: number): InstEffect => ({ kind: 'sense', target: b[o], reg: b[o + 1], key: b[o + 2], lo: f32(o + 4), hi: f32(o + 8), base: 0, width: 0 });
    const vmap = (o: number): VeloRegion => ({ velo: b[o], wave: v.getUint16(o + 6), volume: f32(o + 8), pitch: f32(o + 0xC) });
    const bank: Bank = { virtualId: u32(8), insts: [], percs: [] };
    for (let i = 0; i < 0x80; i++) {
        const io = u32(0x24 + i * 4);
        if (!io) { bank.insts.push(null); continue; }
        const inst: Inst = { volume: f32(io + 8), pitch: f32(io + 0xC), osc: [], effects: [], keymaps: [] };
        for (let j = 0; j < 2; j++) { const o = u32(io + 0x10 + j * 4); if (o) inst.osc.push(osc(o)); }
        for (let j = 0; j < 2; j++) { const o = u32(io + 0x18 + j * 4); if (o) inst.effects.push(rand(o)); }
        for (let j = 0; j < 2; j++) { const o = u32(io + 0x20 + j * 4); if (o) inst.effects.push(sense(o)); }
        const nk = u32(io + 0x28);
        for (let j = 0; j < nk; j++) {
            const ko = u32(io + 0x2C + j * 4), nv = u32(ko + 4), velos: VeloRegion[] = [];
            for (let k = 0; k < nv; k++) velos.push(vmap(u32(ko + 8 + k * 4)));
            inst.keymaps.push({ highKey: b[ko], velos });
        }
        bank.insts.push(inst);
    }
    for (let i = 0; i < 12; i++) {
        const po = u32(0x3B4 + i * 4);
        if (!po) { bank.percs.push(null); continue; }
        const per2 = u32(po) === 0x50455232;   // 'PER2'
        const set: (Perc | null)[] = [];
        for (let k = 0; k < 0x80; k++) {
            const mo = u32(po + 0x88 + k * 4);
            if (!mo) { set.push(null); continue; }
            const p: Perc = { volume: f32(mo), pitch: f32(mo + 4), pan: per2 ? v.getInt8(po + 0x288 + k) / 127 : 0.5, release: per2 ? v.getUint16(po + 0x308 + k * 2) : 0, effects: [], velos: [] };
            for (let j = 0; j < 2; j++) { const o = u32(mo + 8 + j * 4); if (o) p.effects.push(rand(o)); }
            const nv = u32(mo + 0x10);
            for (let j = 0; j < nv; j++) p.velos.push(vmap(u32(mo + 0x14 + j * 4)));
            set.push(p);
        }
        bank.percs.push(set);
    }
    return bank;
}

// ---------------------------------------------------------------- WSYS (JASWSParser.cpp)
/** Driver::Wave_ */
export interface WaveInfo {
    /** 0 ADPCM4, 1 ADPCM2, 2 PCM8, 3 PCM16 */
    format: number; key: number; rate: number; offset: number; size: number;
    loop: boolean; loopStart: number; loopEnd: number; samples: number;
    /** the .aw file it's in */
    aw: string;
}
export class WaveSystem {
    /** wave id (the ctrl wave's low half) → its info */
    waves = new Map<number, WaveInfo>();
    awFiles: string[] = [];
    constructor(b: Bytes) {
        const v = dv(b), u32 = (o: number) => v.getUint32(o);
        const arcBank = u32(0x10), ctrlGroup = u32(0x14);
        const groups = u32(ctrlGroup + 8);
        for (let g = 0; g < groups; g++) {
            const scene = u32(ctrlGroup + 0xC + g * 4), ctrl = u32(scene + 0xC), n = u32(ctrl + 4);
            const arc = u32(arcBank + 8 + g * 4), name = str(b, arc, 0x70);
            this.awFiles.push(name);
            for (let w = 0; w < n; w++) {
                const wo = u32(arc + 0x74 + w * 4), id = v.getUint16(u32(ctrl + 8 + w * 4) + 2);
                this.waves.set(id, {
                    format: b[wo + 1], key: b[wo + 2], rate: v.getFloat32(wo + 4), offset: u32(wo + 8), size: u32(wo + 0xC),
                    loop: u32(wo + 0x10) !== 0, loopStart: u32(wo + 0x14), loopEnd: u32(wo + 0x18), samples: u32(wo + 0x1C), aw: name,
                });
            }
        }
    }
}

// ---------------------------------------------------------------- wave decoding (the DSP's ADPCM: DSPADPCM_FILTER)
const ADPCM_COEF: number[][] = [0x0, 0x08000000, 0x00000800, 0x04000400, 0x1000f800, 0x0e00fa00, 0x0c00fc00, 0x1200f600,
    0x1068f738, 0x12c0f704, 0x1400f400, 0x0800f800, 0x0400fc00, 0xfc000400, 0xfc000000, 0xf8000000]
    .map((w) => [((w >>> 16) << 16) >> 16, (w << 16) >> 16]);
const clamp16 = (x: number) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);
/** The wave's samples (16-bit) from its archive: ADPCM4 (9-byte frames of 16), ADPCM2 (5-byte frames of 16), PCM8, PCM16. */
export function decodeWave(aw: Bytes, w: WaveInfo): Int16Array {
    const n = w.samples, out = new Int16Array(n);
    const src = aw.subarray(w.offset, w.offset + w.size);
    if (w.format === 0 || w.format === 1) {
        const four = w.format === 0, frameBytes = four ? 9 : 5;
        let h1 = 0, h2 = 0, s = 0;
        for (let f = 0; s < n && f * frameBytes < src.length; f++) {
            const o = f * frameBytes, hdr = src[o];
            const scale = 1 << (hdr >> 4), [c1, c2] = ADPCM_COEF[hdr & 0xF];
            for (let k = 0; k < 16 && s < n; k++) {
                let nib: number;
                if (four) { const byte = src[o + 1 + (k >> 1)]; nib = k & 1 ? byte & 0xF : byte >> 4; if (nib >= 8) nib -= 16; }
                else { const byte = src[o + 1 + (k >> 2)]; nib = (byte >> (6 - (k & 3) * 2)) & 3; if (nib >= 2) nib -= 4; nib <<= 2; }
                // ((nibble * scale) << 11 + c1 * h1 + c2 * h2) >> 11 (no rounding: the encoder counts on the floor)
                const smp = clamp16(((nib * scale) * 2048 + c1 * h1 + c2 * h2) >> 11);
                out[s++] = smp; h2 = h1; h1 = smp;
            }
        }
    } else if (w.format === 2) {
        for (let i = 0; i < n && i < src.length; i++) out[i] = ((src[i] << 24) >> 24) * 256;
    } else {
        const v = dv(src);
        for (let i = 0; i < n && i * 2 + 1 < src.length; i++) out[i] = v.getInt16(i * 2);
    }
    return out;
}
