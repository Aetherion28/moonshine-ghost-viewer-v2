// Writes a Moonshine .smsghost (SGHF v7: header, a segment a stage, 16-byte pose samples, the SGTI
// input section, section version 3, with 24-byte records: the post-PADClamp PADStatus and the
// FLUDD / Yoshi observation) from the viewer's live play (runner.ts LiveRunner). Laid out exactly
// as legacy/ghost.js parseSmsGhost reads it. No camera (SGCA, v8): the replay then steers Mario
// against the sim camera, as the live play did, so it replays bit-exact. No splits, no RNG tape
// (the live stage runs from seed 0, as a replay without a tape does).

import type { PadStatus } from './player/pad.js';

/** One frame of the live play: at its last tick's QF (the run's QF, a multiple of 4). */
export interface GhostFrame {
    qf: number; pad: PadStatus;
    x: number; y: number; z: number; yaw: number; anim: number; phase: number;   // phase 0..4095
    /** the sample's Yoshi field (1-4 on Yoshi: his colour + 1, else 0) */
    yoshi: number;
    /** the 8-byte FLUDD / Yoshi observation */
    obs: Uint8Array;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array, z0: number, z1: number) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ (i >= z0 && i < z1 ? 0 : b[i])) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * One stage of the run: its route and frames (run QFs: the first stage's from its tick 0, later ones
 * after it); startQf: the run QF of the stage's tick 0 (the first stage's is 0).
 */
export interface GhostSegment { area: number; episode: number; frames: GhostFrame[]; startQf?: number; }

/**
 * The run, a segment a stage. A segment's first sample is its first frame's pose copied back to the
 * stage's tick 0 (the first segment's QF 0: Moonshine holds the first observable pose from the run's
 * start, ghost.cpp startEpochSamples; a later one's startQf, so a replay starts that stage as long
 * before its first frame as the live run did: runner.ts stageStartCopy). Then one sample a frame.
 * A later segment without a startQf starts at its first frame (its anchor is that QF), as Moonshine's
 * do. A plain frame list is one segment of the header's route.
 */
export function writeSmsGhost(run: GhostFrame[] | GhostSegment[], o: { area: number; episode: number; region: number; name?: string; author?: string }): ArrayBuffer {
    const segs: GhostSegment[] = (run.length && !('frames' in (run[0] as any)) ? [{ area: o.area, episode: o.episode, frames: run as GhostFrame[] }] : (run as GhostSegment[])).filter((g) => g.frames.length);
    if (!segs.length) throw new Error('nothing recorded');
    const frames = segs.flatMap((g) => g.frames);
    const startQf = 0, endQf = frames[frames.length - 1].qf;
    const samples: GhostFrame[] = [], segInfo: { first: number; count: number; start: number; end: number; area: number; episode: number }[] = [];
    segs.forEach((g, k) => {
        const first = samples.length;
        const s0 = k === 0 ? startQf : g.startQf !== undefined && g.startQf < g.frames[0].qf ? g.startQf : -1;
        if (s0 >= 0) samples.push({ ...g.frames[0], qf: s0 });
        samples.push(...g.frames);
        segInfo.push({ first, count: samples.length - first, start: s0 >= 0 ? s0 : g.frames[0].qf, end: g.frames[g.frames.length - 1].qf, area: g.area, episode: g.episode });
    });
    const nS = samples.length, nI = frames.length, nSeg = segInfo.length;
    const HDR = 0x100, segOff = HDR, sampleOff = segOff + 0x20 * nSeg, sampleSize = nS * 16;
    const sgti = sampleOff + sampleSize, size = sgti + 32 + nI * 24;
    const buf = new ArrayBuffer(size), b = new Uint8Array(buf), dv = new DataView(buf);
    const str = (off: number, s: string, max: number) => { const t = s.slice(0, max); for (let i = 0; i < t.length; i++) b[off + i] = t.charCodeAt(i) & 0x7f; return t.length; };
    const be24 = (off: number, v: number) => { v &= 0xffffff; b[off] = v >>> 16; b[off + 1] = (v >>> 8) & 0xff; b[off + 2] = v & 0xff; };
    str(0, 'SGHF', 4);
    dv.setUint16(4, 7); dv.setUint32(8, size);
    b[0x25] = o.region;
    b[0x2c] = segInfo[0].area; b[0x2d] = segInfo[0].episode; b[0x2e] = 0xff; b[0x2f] = 0; dv.setInt32(0x30, -1);
    dv.setUint32(0x34, endQf - startQf); dv.setUint32(0x38, startQf); dv.setUint32(0x3c, endQf); dv.setUint32(0x40, endQf - startQf);
    dv.setUint32(0x44, nS);
    const now = Math.floor(Date.now() / 1000); dv.setUint32(0x4c, Math.floor(now / 2 ** 32)); dv.setUint32(0x50, now >>> 0);
    b[0x5c] = str(0x60, o.author || 'gamepad', 24);
    b[0x5d] = str(0x78, o.name || 'Live play', 48);
    b[0x5e] = 0;
    dv.setUint16(0xb8, nSeg); dv.setUint32(0xbc, segOff); dv.setUint32(0xc4, sampleOff); dv.setUint32(0xc8, sampleSize);
    b[0xd0] = 0;
    // the segments
    segInfo.forEach((g, k) => {
        const r = segOff + k * 0x20;
        dv.setUint32(r, g.first); dv.setUint32(r + 4, g.count); dv.setUint32(r + 8, g.start); dv.setUint32(r + 12, g.end);
        dv.setInt32(r + 0x10, -1); b[r + 0x14] = g.area; b[r + 0x15] = g.episode; b[r + 0x16] = 0xff; b[r + 0x17] = 0;
    });
    // the samples: >h yaw, >H QF since the last (0 at a segment's first), 3 x s24 position in 1/8 units (truncated), u24 anim << 15 | phase8 << 7 | yoshi << 4 | held
    const firsts = new Set(segInfo.map((g) => g.first));
    for (let i = 0; i < nS; i++) {
        const s = samples[i], r = sampleOff + i * 16;
        dv.setInt16(r, (s.yaw << 16) >> 16);
        dv.setUint16(r + 2, firsts.has(i) ? 0 : s.qf - samples[i - 1].qf);
        be24(r + 4, Math.trunc(s.x * 8)); be24(r + 7, Math.trunc(s.y * 8)); be24(r + 10, Math.trunc(s.z * 8));
        const p8 = Math.round(((s.phase & 4095) * 255) / 4095);
        be24(r + 13, ((s.anim & 0x1ff) << 15) | (p8 << 7) | ((s.yoshi & 7) << 4));
    }
    // SGTI
    str(sgti, 'SGTI', 4); dv.setUint16(sgti + 4, 3); dv.setUint16(sgti + 6, 32); dv.setUint32(sgti + 8, nI); dv.setUint32(sgti + 12, 0);
    for (let i = 0; i < nI; i++) {
        const f = frames[i], p = f.pad, r = sgti + 32 + i * 24;
        dv.setUint32(r, f.qf); dv.setUint16(r + 4, p.button & 0xffff);
        dv.setInt8(r + 6, p.stickX); dv.setInt8(r + 7, p.stickY); dv.setInt8(r + 8, p.substickX); dv.setInt8(r + 9, p.substickY);
        b[r + 10] = p.triggerLeft; b[r + 11] = p.triggerRight; b[r + 12] = p.analogA; b[r + 13] = p.analogB; b[r + 14] = 0; b[r + 15] = 0;
        b.set(f.obs.subarray(0, 8), r + 16);
    }
    dv.setUint32(0x0c, crc32(b, 0x0c, 0x10));
    return buf;
}
