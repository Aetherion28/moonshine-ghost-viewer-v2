// Moonshine's experimental MSTR trace (.msgt): native game state captured on a console every
// frame and every Mario movement update. Decoded as the r8 decoder pack documents it
// (README.txt, FORMAT-v1.txt, FORMAT-v2.txt, inspect_trace.py, capture_source/), with the same
// checks as its reference reader, inspect_trace.py: a file that reader rejects is rejected here.
//
// Framing (all big-endian): a 64-byte header of sixteen u32s (MSTR, version 1/2, 64, game code,
// boot nonce, run, start scene (area << 8 | episode), capability bits, 0x80000, six zeros, FNV-1a
// of the first 60 bytes); chunks of eight u32s (run, sequence from 1, payload bytes, FNV-1a of the
// payload, first and last frame, 0, 0) then the payload; a DONE footer (DONE, run, chunk count,
// bytes before the footer, capabilities | producer_error << 24, 0, 0, 0). Records never cross a
// chunk: kind u16, payload length u16, frame u32, movement tick u32, payload.
//
// This file reads and reconstructs; mstrghost.ts turns a trace into the viewer's ghost object.

export const MSTR_MAGIC = 0x4d535452, MSTR_DONE = 0x444f4e45;

export const enum K {
    SESSION = 1, FRAME = 2, MARIO = 3, CAMERA = 4, FLAGS = 5, ACTOR = 6, ACTOR_END = 7, FLUDD = 8, YOSHI = 9,
    SOUND = 10, PARTICLE = 11, END = 12, WORLD_SUMMARY = 13, INPUT = 14, RNG = 15, WATER = 16, IDENTITY = 17,
    RNG_BLOCK = 18, CONTACT = 19, INPUT_DELTA = 20, CAMERA_META = 21, STAGE_START = 22, PROVENANCE = 28,
}
export const KIND_NAMES: Record<number, string> = {
    1: 'session', 2: 'frame', 3: 'Mario', 4: 'camera', 5: 'flags', 6: 'actor', 7: 'actor_removed', 8: 'FLUDD', 9: 'Yoshi',
    10: 'sound', 11: 'particle', 12: 'end', 13: 'world_summary', 14: 'controller', 15: 'RNG_call', 16: 'water_request',
    17: 'identity', 18: 'RNG_block', 19: 'contact', 20: 'controller_delta', 21: 'camera_metadata',
    22: 'stage_start', 23: 'visual', 24: 'pad_mirrors', 25: 'pad_mirrors_delta', 26: 'world_witness', 27: 'continuation', 28: 'run_provenance',
};
/** Capability bits (header word 7 and the footer). */
export const CAP = {
    SESSION: 1, FRAME: 2, MARIO: 4, CAMERA: 8, FLAGS: 16, ACTOR_BASE: 32, FLUDD: 64, YOSHI: 128, SOUND: 256, PARTICLE: 512,
    INPUT: 1024, RNG_CALLS: 2048, WATER: 4096, EXTENDED_STATE: 8192, CONTACTS: 16384, CAMERA_META: 32768,
};
/** Bytes of the controller observation (kinds 14 / 20): cue, pad index, PADStatus[11] + pad, validity, TMarioGamePad[240], TMarioControllerWork[36]. */
export const INPUT_BYTES = 300;

export class MstrError extends Error { }

export function fnv1a(b: Uint8Array, h = 2166136261): number {
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
    return h >>> 0;
}

export interface MstrHeader {
    version: number;
    /** header word 3: the game code's first four characters, e.g. GMSP */
    gameCode: string;
    bootNonce: number; run: number;
    /** (area << 8) | episode, zero-based */
    startScene: number;
    capabilities: number;
}

export interface MstrRecord {
    kind: number; frame: number; tick: number;
    /** the payload (a view into the file) */
    body: Uint8Array;
}

export interface MstrSummary {
    header: MstrHeader;
    complete: boolean; producerError: number;
    chunks: number; payloadBytes: number;
    frames: number; movementUpdates: number; rngCalls: number;
    records: Record<string, number>;
}

/**
 * Walks every record in order, validating as inspect_trace.py does (framing, checksums, record
 * order, native byte blocks, controller deltas, contact/camera sizes, RNG blocks, actor deltas).
 * visit (optional) sees each record after it validated. Throws MstrError on anything the reference
 * reader rejects.
 */
/** An LZ4 block (lz4 block format) at src[p, p + len) into out from o; the bytes written. */
function lz4Block(src: Uint8Array, p: number, len: number, out: Uint8Array, o: number): number {
    const end = p + len, o0 = o;
    while (p < end) {
        const tok = src[p++];
        let lit = tok >>> 4;
        if (lit === 15) { let b; do { b = src[p++]; lit += b; } while (b === 255 && p < end); }
        if (p + lit > end || o + lit > out.length) return -1;
        out.set(src.subarray(p, p + lit), o); p += lit; o += lit;
        if (p >= end) break;
        const off = src[p] | (src[p + 1] << 8); p += 2;
        if (!off || off > o - o0 + o0 || o - off < 0) return -1;
        let m = (tok & 15) + 4;
        if ((tok & 15) === 15) { let b; do { b = src[p++]; m += b; } while (b === 255 && p < end); }
        if (o + m > out.length) return -1;
        for (let i = 0; i < m; i++, o++) out[o] = out[o - off];
    }
    return o - o0;
}

export function readMstr(buf: ArrayBuffer, visit?: (r: MstrRecord) => void): MstrSummary {
    const bytes = new Uint8Array(buf), dv = new DataView(buf);
    const fail = (m: string): never => { throw new MstrError(m); };
    if (bytes.length < 64) fail('Truncated capture at 0x0');
    const w = (i: number) => dv.getUint32(i * 4);
    if (w(0) !== MSTR_MAGIC || (w(1) < 1 || w(1) > 3) || w(2) !== 64 || w(8) !== 0x80000 || fnv1a(bytes.subarray(0, 60)) !== w(15))
        fail('Invalid MSTR header');
    const header: MstrHeader = {
        version: w(1), gameCode: String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]),
        bootNonce: w(4), run: w(5), startScene: w(6), capabilities: w(7),
    };
    const version = header.version;
    const counts: Record<string, number> = {};
    const states = new Map<number, BlobState>();
    let frames = 0, ticks = 0, chunks = 0, payload = 0, rngCalls = 0, scene: number | null = null;
    let input: Uint8Array | null = null;
    let at = 64;
    for (; ;) {
        if (at + 32 > bytes.length) fail(`Truncated capture at 0x${at.toString(16)}`);
        const v = (i: number) => dv.getUint32(at + i * 4);
        if (v(0) === MSTR_DONE) {
            if (v(1) !== header.run || v(2) !== chunks || v(3) !== at || at + 32 !== bytes.length) fail('Invalid final capture boundary');
            const err = v(4) >>> 24;
            if ((v(4) & 0xffffff) !== header.capabilities) fail('Capture capabilities changed');
            return { header, complete: err === 0, producerError: err, chunks, payloadBytes: payload, frames, movementUpdates: ticks, rngCalls, records: counts };
        }
        const [run, seq, n, digest, first, last, r0, r1] = [v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7)];
        // v3: a chunk may be stored LZ4-compressed (r0 = 1) in blocks of r1 bytes: each block a u32 raw size and
        // a u32 stored size (high bit: LZ4 block format, else the raw bytes); n is the decompressed size
        const packed = header.version >= 3 && r0 === 1;
        if (run !== header.run || seq !== chunks + 1 || !(n > 0 && n <= 0x80000) || (packed ? !(r1 > 0 && r1 <= 0x80000) : (r0 || r1)) || first > last) fail('Invalid chunk boundary');
        let cbytes = bytes, cdv = dv, start = at + 32, stored = n;
        if (packed) {
            const out = new Uint8Array(n);
            let p = start, o = 0;
            while (o < n) {
                if (p + 8 > bytes.length) fail(`Truncated capture at 0x${p.toString(16)}`);
                const raw = dv.getUint32(p), sz = dv.getUint32(p + 4), len = sz & 0x7fffffff;
                p += 8;
                if (raw > r1 || o + raw > n || p + len > bytes.length) fail('Invalid compressed block');
                if (sz & 0x80000000) { if (lz4Block(bytes, p, len, out, o) !== raw) fail('Invalid compressed block'); }
                else { if (len !== raw) fail('Invalid stored block'); out.set(bytes.subarray(p, p + len), o); }
                p += len; o += raw;
            }
            stored = p - start;
            cbytes = out; cdv = new DataView(out.buffer); start = 0;
        }
        if (start + n > cbytes.length) fail(`Truncated capture at 0x${start.toString(16)}`);
        const data = cbytes.subarray(start, start + n);
        if (fnv1a(data) !== digest) fail(`Chunk ${seq} checksum mismatch`);
        let pos = 0, firstFrame = -1, lastFrame = -1;
        while (pos < n) {
            if (n - pos < 12) fail('Truncated record header');
            const o = start + pos;
            const kind = cdv.getUint16(o), size = cdv.getUint16(o + 2), frame = cdv.getUint32(o + 4), tick = cdv.getUint32(o + 8);
            pos += 12;
            if ((!KIND_NAMES[kind] && !(header.version >= 3 && kind >= 22 && kind < 64)) || size > n - pos || frame < frames || tick < ticks) fail(`Invalid record boundary/order (kind ${kind} size ${size} frame ${frame}/${frames} tick ${tick}/${ticks})`);
            const body = cbytes.subarray(start + pos, start + pos + size);
            const bv = new DataView(cbytes.buffer, cbytes.byteOffset + start + pos, size);
            if (kind === K.FRAME) {
                if (size !== 32) fail('Bad frame record');
                const s = bv.getUint32(0);
                if (s !== scene) { states.clear(); scene = s; input = null; }
            }
            if (kind === K.MARIO || kind === K.CAMERA || kind === K.FLAGS || kind === K.FLUDD || kind === K.YOSHI) applyBlob(body, bv, version, states, kind);
            if (kind === K.INPUT) {
                if (version >= 2 && size !== INPUT_BYTES) fail('Invalid full controller record');
                input = body.slice();
            }
            if (kind === K.INPUT_DELTA) {
                if (version < 2 || !input || size < 16 || bv.getUint32(0) !== INPUT_BYTES) fail('Invalid controller delta');
                applyInputDelta(input!, body, bv);
            }
            if (kind === K.CONTACT && (size !== 88 || bv.getUint32(0) > 3)) fail('Invalid contact record');
            if (kind === K.CAMERA_META && size !== 88) fail('Invalid camera metadata');
            if (kind === K.RNG) rngCalls++;
            if (kind === K.RNG_BLOCK) rngCalls += checkRngBlock(body, bv, version);
            if (kind === K.ACTOR) checkActor(bv, size);
            frames = frame; ticks = tick;
            if (firstFrame < 0) firstFrame = frame;
            lastFrame = frame;
            { const kn = KIND_NAMES[kind] || 'kind' + kind; counts[kn] = (counts[kn] || 0) + 1; }
            if (visit) visit({ kind, frame, tick, body });
            pos += size;
        }
        if (firstFrame < 0 || firstFrame !== first || lastFrame !== last) fail('Chunk frame range mismatch');
        chunks++; payload += n; at = packed ? at + 32 + stored : start + n;
    }
}

// ------------------------------------------------------------ native byte blocks (kinds 3/4/5/8/9)

/** One reconstructed native object prefix: its address, its bytes, which literal offsets were seen. */
export interface BlobState { pointer: number; data: Uint8Array; seen: Set<number>; }

function applyBlob(payload: Uint8Array, bv: DataView, version: number, states: Map<number, BlobState>, kind: number) {
    const fail = (m: string): never => { throw new MstrError(m); };
    if (payload.length < 16) fail('Truncated native byte block');
    const pointer = bv.getUint32(0), offset = bv.getUint32(4), total = bv.getUint32(8), field = bv.getUint32(12);
    const delta = (field & 0x80000000) !== 0, n = field & 0x7fffffff;
    if (!(total > 0 && total <= 8192) || !(n > 0 && n <= 512) || offset + n > total || (pointer & 3) || !(pointer >= 0x80000000 && pointer <= 0x81800000 - total))
        fail('Invalid native byte block');
    let st = states.get(kind);
    if (!st || st.pointer !== pointer || st.data.length !== total) { st = { pointer, data: new Uint8Array(total), seen: new Set() }; states.set(kind, st); }
    const data = st.data;
    if (delta) {
        if (version < 2 || (n & 3) || !st.seen.has(offset)) fail('Delta lacks a literal baseline');
        const masks = Math.ceil(n / 128);
        if (payload.length < 16 + 4 * masks) fail('Truncated delta mask');
        let p = 16 + 4 * masks;
        for (let i = 0; i < masks; i++) {
            const m = bv.getUint32(16 + 4 * i), bits = Math.min(32, n / 4 - 32 * i);
            if (bits < 32 && (m >>> bits) !== 0) fail('Delta mask exceeds block');
        }
        for (let i = 0; i < n / 4; i++) {
            if (bv.getUint32(16 + 4 * (i >> 5)) & (1 << (i & 31))) {
                if (p + 4 > payload.length) fail('Truncated delta word');
                data.set(payload.subarray(p, p + 4), offset + 4 * i); p += 4;
            }
        }
        if (p !== payload.length) fail('Extra delta words');
    } else {
        if (payload.length !== 16 + n) fail('Literal block length mismatch');
        data.set(payload.subarray(16), offset); st.seen.add(offset);
    }
}

function applyInputDelta(input: Uint8Array, body: Uint8Array, bv: DataView) {
    const fail = (m: string): never => { throw new MstrError(m); };
    const masks = [bv.getUint32(4), bv.getUint32(8), bv.getUint32(12)];
    if (masks[2] >>> 11) fail('Controller mask exceeds extent');
    let cursor = 16;
    for (let word = 0; word < 75; word++) {
        if (masks[word >> 5] & (1 << (word & 31))) {
            if (cursor + 4 > body.length) fail('Truncated controller word');
            input.set(body.subarray(cursor, cursor + 4), word * 4); cursor += 4;
        }
    }
    if (cursor !== body.length) fail('Extra controller words');
}

/** MSL rand(): next = seed * 1103515245 + 12345 (mod 2^32), result = (next >> 16) & 32767. */
export const lcgNext = (s: number) => (Math.imul(s, 1103515245) + 12345) >>> 0;

function checkRngBlock(body: Uint8Array, bv: DataView, version: number): number {
    const fail = (m: string): never => { throw new MstrError(m); };
    if (version < 2 || body.length < 16) fail('Invalid RNG block');
    let seed = bv.getUint32(0);
    const last = bv.getUint32(4), count = bv.getUint32(8), callers = bv.getUint32(12);
    if (!(count > 0 && count <= 512) || !(callers > 0 && callers <= 64) || body.length !== 16 + callers * 4 + count) fail('Invalid RNG callers');
    for (let i = 16 + callers * 4; i < body.length; i++) if (body[i] >= callers) fail('Invalid RNG callers');
    for (let i = 0; i < count - 1; i++) seed = lcgNext(seed);
    if (seed !== last) fail('RNG sequence mismatch');
    return count;
}

const popcount = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

function checkActor(bv: DataView, size: number) {
    if (size < 28) throw new MstrError('Short actor delta');
    const extent = bv.getUint32(8), created = bv.getUint32(12), m = [bv.getUint32(16), bv.getUint32(20), bv.getUint32(24)];
    const words = extent >>> 2;
    let ok = (extent === 0xf4 || extent === 0x150) && (created === 0 || created === 1);
    // mask >> (extent / 4) must be zero, and a new actor carries every word
    for (let i = 0; i < 3 && ok; i++) {
        const lo = i * 32, keep = Math.max(0, Math.min(32, words - lo));
        if (keep < 32 && (m[i] >>> keep) !== 0) ok = false;
        if (created && m[i] !== (keep === 32 ? 0xffffffff : keep ? ((1 << keep) - 1) >>> 0 : 0)) ok = false;
    }
    if (ok && size !== 28 + 4 * (popcount(m[0]) + popcount(m[1]) + popcount(m[2]))) ok = false;
    if (!ok) throw new MstrError('Invalid actor delta');
}

// ------------------------------------------------------------ reconstruction

/** A record kind 19 contact: the triangle (72 native TBGCheckData bytes) Mario touched in a role. */
export interface MstrContact { role: number; pointer: number; valid: boolean; triangle: Uint8Array; }
/** Kind 21: the camera's mode and its in-between (interpolation) child. */
export interface MstrCameraMeta { pointer: number; mode: number; child: number; valid: number; inbetween: Uint8Array; }
/**
 * Kind 22: what the stage started with. npcSinkPhase (schema 2+) is TBaseNPC::initSinkNpc_'s static
 * sCheckPollutedStartCounter (0..29) as setup began, null when not recorded; observations (schema 3)
 * says which GPU results the kind-15 literal records carry: bit 0 Mario's occlusion at the camera and the
 * silhouette, bit 1 run provenance on every frame, bit 2 Bowser's bath-water height.
 */
export interface MstrStageStart { schema: number; npcSinkPhase: number | null; observations: number; }
/** Kind 17: the disc header's first two words, the trace schema, and Moonshine's regional ordinal. */
export interface MstrIdentity { disc0: number; disc1: number; schema: number; regional: number; gameId: string; discRevision: number; }

/** The state as it stands at one Mario movement update (records arrive before that update's perform). */
export interface MstrTickState {
    frame: number; tick: number; scene: number;
    /** frame record words: application context, VI retrace count, OS tick, libc seed, cumulative movement ticks */
    context: number; retrace: number; osTick: number; seed: number;
    /** the frame record's TMarDirector state as the frame began (word 6; -1 none) */
    directorState: number;
    /** the 300-byte controller observation (null before the first) */
    input: Uint8Array | null;
    mario: BlobState | undefined; camera: BlobState | undefined; fludd: BlobState | undefined; yoshi: BlobState | undefined; flags: BlobState | undefined;
    contacts: (MstrContact | null)[];
    cameraMeta: MstrCameraMeta | null;
}

export interface MstrRngCall { frame: number; tick: number; caller: number; seed: number; result: number; raw: boolean; }

/**
 * Replays a trace's records into native state. onTick fires once per Mario movement update, after
 * that update's records (input, contacts, camera metadata, Mario and camera blocks) arrived, i.e.
 * with the state the game had just before that perform() call. The blob states are live objects:
 * copy what you keep.
 */
export function replayMstr(buf: ArrayBuffer, o: {
    onTick?: (s: MstrTickState) => void;
    onFrame?: (s: MstrTickState) => void;
    onRng?: (c: MstrRngCall) => void;
    onIdentity?: (id: MstrIdentity) => void;
    onSession?: (b: Uint8Array, frame: number) => void;
    onActor?: (id: number, pointer: number, extent: number, words: Uint32Array, created: boolean, frame: number, tick: number) => void;
    onActorEnd?: (id: number, frame: number, tick: number) => void;
    /** kind 22: the stage-start record (schema 1: 960 bytes, 2: + the NPC goop-check phase, 3: + the observations word) */
    onStageStart?: (s: MstrStageStart, frame: number, tick: number) => void;
    /** kind 28: the run's cumulative attribute flags (ghost_run_flags.h) as of this frame */
    onProvenance?: (runFlags: number, frame: number) => void;
} = {}): MstrSummary {
    const st: MstrTickState = {
        frame: 0, tick: 0, scene: -1, context: 0, retrace: 0, osTick: 0, seed: 0, directorState: -1, input: null,
        mario: undefined, camera: undefined, fludd: undefined, yoshi: undefined, flags: undefined, contacts: [null, null, null, null], cameraMeta: null,
    };
    const blobs = new Map<number, BlobState>();
    const actors = new Map<number, { pointer: number; extent: number; words: Uint32Array }>();
    let version = 2, pendingTick = -1;
    const flushTick = () => {
        if (pendingTick < 0 || !o.onTick) { pendingTick = -1; return; }
        st.mario = blobs.get(K.MARIO); st.camera = blobs.get(K.CAMERA); st.fludd = blobs.get(K.FLUDD); st.yoshi = blobs.get(K.YOSHI); st.flags = blobs.get(K.FLAGS);
        o.onTick(st); pendingTick = -1;
    };
    // the reader validates; this second pass applies (cheap compared with the checks)
    const sum = readMstr(buf, (r) => {
        const bv = new DataView(r.body.buffer, r.body.byteOffset, r.body.byteLength);
        // a new movement tick starts with its controller observation
        if ((r.kind === K.INPUT || r.kind === K.INPUT_DELTA || r.kind === K.FRAME) && pendingTick >= 0) flushTick();
        st.frame = r.frame; st.tick = r.tick;
        switch (r.kind) {
            case K.FRAME: {
                const scene = bv.getUint32(0);
                if (scene !== st.scene) { blobs.clear(); actors.clear(); st.scene = scene; st.input = null; st.contacts = [null, null, null, null]; st.cameraMeta = null; }
                st.context = bv.getUint32(4); st.retrace = bv.getUint32(8); st.osTick = bv.getUint32(12); st.seed = bv.getUint32(16);
                st.directorState = r.body.length >= 28 ? bv.getUint32(24) | 0 : -1;
                if (o.onFrame) { st.mario = blobs.get(K.MARIO); st.camera = blobs.get(K.CAMERA); o.onFrame(st); }
                break;
            }
            case K.MARIO: case K.CAMERA: case K.FLAGS: case K.FLUDD: case K.YOSHI:
                applyBlob(r.body, bv, version, blobs, r.kind); break;
            case K.INPUT: st.input = r.body.slice(); pendingTick = r.tick; break;
            case K.INPUT_DELTA: applyInputDelta(st.input!, r.body, bv); pendingTick = r.tick; break;
            case K.CONTACT: st.contacts[bv.getUint32(0)] = { role: bv.getUint32(0), pointer: bv.getUint32(4), valid: bv.getUint32(8) !== 0, triangle: r.body.slice(16, 88) }; break;
            case K.CAMERA_META: st.cameraMeta = { pointer: bv.getUint32(0), mode: bv.getUint32(4) | 0, child: bv.getUint32(8), valid: bv.getUint32(12), inbetween: r.body.slice(16, 88) }; break;
            case K.IDENTITY: if (o.onIdentity) o.onIdentity(identityOf(bv)); break;
            case K.STAGE_START: if (o.onStageStart) {
                const n = r.body.length;
                o.onStageStart({ schema: bv.getUint32(0), npcSinkPhase: n >= 964 ? bv.getUint32(960) : null, observations: n >= 968 ? bv.getUint32(964) : 0 }, r.frame, r.tick);
            } break;
            case K.PROVENANCE: if (o.onProvenance && r.body.length >= 8) o.onProvenance(bv.getUint32(4), r.frame); break;
            case K.SESSION: if (o.onSession) o.onSession(r.body, r.frame); break;
            case K.RNG: if (o.onRng) o.onRng({ frame: r.frame, tick: r.tick, caller: bv.getUint32(0), result: bv.getUint32(4), seed: bv.getUint32(8), raw: true }); break;
            case K.RNG_BLOCK: if (o.onRng) {
                // the first seed is already call 0's post-seed (FORMAT-v2: do not advance it first)
                let seed = bv.getUint32(0);
                const count = bv.getUint32(8), callers = bv.getUint32(12), idx = 16 + callers * 4;
                for (let i = 0; i < count; i++) {
                    if (i) seed = lcgNext(seed);
                    o.onRng({ frame: r.frame, tick: r.tick, caller: bv.getUint32(16 + 4 * r.body[idx + i]), seed, result: (seed >>> 16) & 32767, raw: false });
                }
            } break;
            case K.ACTOR: {
                const id = bv.getUint32(0), pointer = bv.getUint32(4), extent = bv.getUint32(8), created = bv.getUint32(12) === 1;
                let a = actors.get(id);
                if (!a || created) { a = { pointer, extent, words: new Uint32Array(extent >>> 2) }; actors.set(id, a); }
                let p = 28;
                for (let n = 0; n < (extent >>> 2); n++) if (bv.getUint32(16 + 4 * (n >> 5)) & (1 << (n & 31))) { a.words[n] = bv.getUint32(p); p += 4; }
                if (o.onActor) o.onActor(id, pointer, extent, a.words, created, r.frame, r.tick);
                break;
            }
            case K.ACTOR_END: { const id = bv.getUint32(0); actors.delete(id); if (o.onActorEnd) o.onActorEnd(id, r.frame, r.tick); break; }
        }
    });
    flushTick();
    version = sum.header.version;
    return sum;
}

function identityOf(bv: DataView): MstrIdentity {
    const disc0 = bv.getUint32(0), disc1 = bv.getUint32(4);
    const id = String.fromCharCode(disc0 >>> 24, (disc0 >>> 16) & 0xff, (disc0 >>> 8) & 0xff, disc0 & 0xff, disc1 >>> 24, (disc1 >>> 16) & 0xff);
    // 0x80000004: maker code (2), disc number (1), disc revision (1), as boot.bin has them
    return { disc0, disc1, schema: bv.getUint32(8), regional: bv.getUint32(12), gameId: id, discRevision: disc1 & 0xff };
}

// ------------------------------------------------------------ typed reads of the native blocks

const dvOf = (b: BlobState) => new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);

/**
 * TMario fields, at the decomp's offsets (include/Player/Mario.hpp; position and rotation are the
 * capture's compile-time checked +0x10 / +0x30). The block is the first 0x574 bytes of TMario.
 */
export const MARIO = {
    pos: 0x10, rot: 0x30, input: 0x74, status: 0x7c, prevStatus: 0x80, statusState: 0x84, statusTimer: 0x86,
    intendedMag: 0x8c, intendedYaw: 0x90, faceAngle: 0x94, modelFaceAngle: 0x9a, vel: 0xa4, forwardVel: 0xb0,
    slideVelX: 0xb4, slideVelZ: 0xb8, floorPosition: 0xe8, slopeAngle: 0xf4, animationId: 0xfa, flag: 0x118, health: 0x120,
    prevPosition: 0x29c, upperState: 0x380,
};
export interface MarioView {
    pos: [number, number, number]; rot: [number, number, number]; input: number; status: number; prevStatus: number;
    statusState: number; statusTimer: number; intendedMag: number; intendedYaw: number; faceAngle: [number, number, number];
    modelFaceAngle: number; vel: [number, number, number]; forwardVel: number; slideVel: [number, number];
    floorY: number; slopeAngle: number; animationId: number; flag: number; health: number;
}
export function marioView(b: BlobState): MarioView {
    const d = dvOf(b), M = MARIO, f = (o: number) => d.getFloat32(o), v3 = (o: number): [number, number, number] => [f(o), f(o + 4), f(o + 8)];
    return {
        pos: v3(M.pos), rot: v3(M.rot), input: d.getUint32(M.input), status: d.getUint32(M.status), prevStatus: d.getUint32(M.prevStatus),
        statusState: d.getUint16(M.statusState), statusTimer: d.getUint16(M.statusTimer), intendedMag: f(M.intendedMag), intendedYaw: d.getInt16(M.intendedYaw),
        faceAngle: [d.getInt16(M.faceAngle), d.getInt16(M.faceAngle + 2), d.getInt16(M.faceAngle + 4)], modelFaceAngle: d.getInt16(M.modelFaceAngle),
        vel: v3(M.vel), forwardVel: f(M.forwardVel), slideVel: [f(M.slideVelX), f(M.slideVelZ)], floorY: f(M.floorPosition + 4),
        slopeAngle: d.getInt16(M.slopeAngle), animationId: d.getUint16(M.animationId), flag: d.getUint32(M.flag), health: d.getInt16(M.health),
    };
}

/**
 * CPolarSubCamera fields (decomp include/Camera/Camera.hpp; the pack's README: mode s32 +0x50,
 * in-between +0x6C, +0x1EC a view matrix, rendered eye +0x124, target +0x148, up +0x30).
 * unk258 is the yaw TMario::checkController adds to the stick (MarioMove.cpp: mIntendedYaw).
 */
export const CAMERA = { up: 0x30, fovy: 0x48, aspect: 0x4c, mode: 0x50, inbetween: 0x6c, eye: 0x124, target: 0x148, view: 0x1ec, yaw: 0x258 };
export interface CameraView { eye: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fovy: number; aspect: number; mode: number; yaw: number; }
export function cameraView(b: BlobState): CameraView {
    const d = dvOf(b), C = CAMERA, f = (o: number) => d.getFloat32(o), v3 = (o: number): [number, number, number] => [f(o), f(o + 4), f(o + 8)];
    return { eye: v3(C.eye), target: v3(C.target), up: v3(C.up), fovy: f(C.fovy), aspect: f(C.aspect), mode: d.getInt32(C.mode), yaw: d.getInt16(C.yaw) };
}

/** The JUT PADStatus inside a controller observation (+8): what SGHF stores per input. */
export interface PadView { button: number; stickX: number; stickY: number; substickX: number; substickY: number; triggerL: number; triggerR: number; analogA: number; analogB: number; err: number; cue: number; valid: number; }
export function padView(input: Uint8Array): PadView {
    const d = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return {
        cue: d.getUint32(0), button: d.getUint16(8), stickX: d.getInt8(10), stickY: d.getInt8(11), substickX: d.getInt8(12), substickY: d.getInt8(13),
        triggerL: d.getUint8(14), triggerR: d.getUint8(15), analogA: d.getUint8(16), analogB: d.getUint8(17), err: d.getInt8(18), valid: d.getUint32(20),
    };
}

/** A contact's triangle: TBGCheckData (0x48): bgType u16 +0, vertices +0x10, normal +0x34, d +0x40. */
export function contactTriangle(c: MstrContact) {
    const d = new DataView(c.triangle.buffer, c.triangle.byteOffset, 72), f = (o: number) => d.getFloat32(o);
    return {
        bgType: d.getUint16(0), minY: f(0x8), maxY: f(0xc),
        p: [[f(0x10), f(0x14), f(0x18)], [f(0x1c), f(0x20), f(0x24)], [f(0x28), f(0x2c), f(0x30)]],
        n: [f(0x34), f(0x38), f(0x3c)], d: f(0x40),
    };
}
