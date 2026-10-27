// THP movies (the dolphin SDK's THPPlayer, libs/THPPlayer/src/THPPlayer.c, THPRead.c,
// libs/dolphin/src/thp/THPAudio.c) read from the player's disc and decoded in the browser:
//
// - the header (THPHeader: "THP\0", version 0x11000, the frame rate, the frame count, the first
//   frame's size and offset), the component table (THPFrameCompInfo: video 0, audio 1) and their
//   infos (THPVideoInfo: width, height, type; THPAudioInfo: channels, frequency, samples, tracks);
// - each frame: the next frame's size, the previous one's, each component's size, then the
//   components' data in order: the video a JPEG image, the audio one THPAudioRecordHeader a track
//   (the channels' 4-bit DSP ADPCM with their coefficients and history, THPAudioDecode).
//
// THP's JPEG scan data has no byte stuffing (an 0xFF in it is data, not a marker), so before a
// browser decodes a frame its scan gets the 0x00 after each 0xFF that baseline JPEG wants.

export interface ThpInfo {
    version: number; fps: number; frames: number; firstFrameSize: number; firstFrameOffset: number; lastFrameOffset: number;
    comps: number[]; width: number; height: number; videoType: number;
    audio: { channels: number; frequency: number; samples: number; tracks: number } | null;
}

export function parseThpHeader(b: Uint8Array): ThpInfo {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b[0] !== 0x54 || b[1] !== 0x48 || b[2] !== 0x50) throw new Error('not a THP movie');
    const version = dv.getUint32(4);
    const info: ThpInfo = {
        version, fps: dv.getFloat32(0x10), frames: dv.getUint32(0x14), firstFrameSize: dv.getUint32(0x18),
        firstFrameOffset: dv.getUint32(0x28), lastFrameOffset: dv.getUint32(0x2C), comps: [], width: 0, height: 0, videoType: 0, audio: null,
    };
    let o = dv.getUint32(0x20);
    const n = dv.getUint32(o);
    for (let i = 0; i < n && i < 16; i++) info.comps.push(b[o + 4 + i]);
    o += 4 + 16;
    const v11 = version >= 0x11000;
    for (const c of info.comps) {
        if (c === 0) { info.width = dv.getUint32(o); info.height = dv.getUint32(o + 4); info.videoType = v11 ? dv.getUint32(o + 8) : 0; o += v11 ? 12 : 8; }
        else if (c === 1) { info.audio = { channels: dv.getUint32(o), frequency: dv.getUint32(o + 4), samples: dv.getUint32(o + 8), tracks: v11 ? dv.getUint32(o + 12) : 1 }; o += v11 ? 16 : 12; }
        else break;
    }
    return info;
}

/** a frame's parts: the next frame's size, the JPEG and the audio record (of track `track`) */
export function splitThpFrame(info: ThpInfo, f: Uint8Array, track = 0) {
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const next = dv.getUint32(0);
    let p = 8 + info.comps.length * 4;
    let video: Uint8Array | null = null, audio: Uint8Array | null = null;
    info.comps.forEach((c, i) => {
        const size = dv.getUint32(8 + i * 4);
        if (c === 0) video = f.subarray(p, p + size);
        else if (c === 1) { const t = Math.min(track, (info.audio ? info.audio.tracks : 1) - 1); audio = f.subarray(p + size * t, p + size * (t + 1)); }
        p += size;
    });
    return { next, video: video as Uint8Array | null, audio: audio as Uint8Array | null };
}

/** a THP frame's JPEG made standard: the scan's 0xFF bytes stuffed (0xFF 0x00), ended by EOI */
export function thpJpeg(j: Uint8Array): Uint8Array {
    let p = 2;
    // the markers up to and including SOS
    while (p + 4 <= j.length) {
        if (j[p] !== 0xFF) { p++; continue; }
        const m = j[p + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
        const len = (j[p + 2] << 8) | j[p + 3];
        p += 2 + len;
        if (m === 0xDA) break;
    }
    let end = j.length;
    for (let k = j.length - 2; k >= Math.max(p, j.length - 64); k--) if (j[k] === 0xFF && j[k + 1] === 0xD9) { end = k; break; }
    let ff = 0;
    for (let k = p; k < end; k++) if (j[k] === 0xFF) ff++;
    const out = new Uint8Array(p + (end - p) + ff + 2);
    out.set(j.subarray(0, p), 0);
    let o = p;
    for (let k = p; k < end; k++) { const v = j[k]; out[o++] = v; if (v === 0xFF) out[o++] = 0; }
    out[o++] = 0xFF; out[o++] = 0xD9;
    return out;
}

/** THPAudioDecode: a record's channels as float PCM (a mono record decodes to both) */
export function thpAudioDecode(a: Uint8Array): { left: Float32Array; right: Float32Array } {
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const nextCh = dv.getUint32(0), n = dv.getUint32(4);
    const coef = (ch: number, i: number) => dv.getInt16(8 + ch * 32 + i * 2);
    const left = new Float32Array(n), right = new Float32Array(n);
    const decode = (data: number, ch: number, out: Float32Array) => {
        let yn1 = dv.getInt16(0x48 + ch * 4), yn2 = dv.getInt16(0x4A + ch * 4);
        let ptr = data, nib = 2, pred = (a[ptr] >> 4) & 7, scale = a[ptr] & 15;
        ptr++;
        for (let i = 0; i < n; i++) {
            if (!(nib & 15)) { pred = (a[ptr] >> 4) & 7; scale = a[ptr] & 15; ptr++; nib += 2; }
            let s: number;
            if (nib & 1) { s = ((a[ptr] & 15) << 28) >> 28; ptr++; } else s = ((a[ptr] & 0xF0) << 24) >> 28;
            nib++;
            // yn = c1 * yn2 + c0 * yn1 + (s << scale << 11), << 5, rounded to even at bit 16, clamped
            let yn = coef(ch, pred * 2 + 1) * yn2 + coef(ch, pred * 2) * yn1 + s * 2 ** scale * 2048;
            yn *= 32;
            const lo = ((yn % 65536) + 65536) % 65536;
            if (lo > 0x8000) yn += 0x10000; else if (lo === 0x8000 && (Math.floor(yn / 65536) & 1)) yn += 0x10000;
            yn = Math.max(-2147483648, Math.min(2147483647, yn));
            const v = Math.floor(yn / 65536) << 16 >> 16;
            out[i] = v / 32768;
            yn2 = yn1; yn1 = v;
        }
    };
    decode(0x50, 0, left);
    if (nextCh) decode(0x50 + nextCh, 1, right); else right.set(left);
    return { left, right };
}
