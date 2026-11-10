// v3: a trace (.msgt, the newest format only: container 3, stage-start schema 3) as the ordered list of
// events a replay follows. Moonshine writes its records in the order things happen in the game, so the
// order here is the order the game must reproduce:
//   STAGE   as TMarDirector::setup is about to be called (the flag manager's image, the RNG seed, ...)
//   FRAME   before each director->direct() (the gameLoop hook): the RNG seed, the director's state, ...
//   PAD     the frame's pad as direct() is called (and whether Moonshine froze the stage or hid the pad)
//   TICK    before each TMario::perform with the movement cue: the pad Mario reads, Mario's first 0x574 bytes
//   RAND    a rand() call: its caller (the return address) and the seed it left
//   LIT     a GPU result read at one of three sites (occlusion at the camera and the silhouette, the bath
//           water's height): the value the game used
import { readMstr, applyBlob, applyInputDelta, K, lcgNext, MstrError, type BlobState } from '../../src/ghost/mstr.ts';

export const enum Ev { STAGE = 1, FRAME = 2, PAD = 3, TICK = 4, RAND = 5, LIT = 6 }
export const EV_NAMES = ['?', 'stage', 'frame', 'pad', 'tick', 'rand', 'literal'];

/** offsets in the 300-byte controller observation */
export const IN = { cue: 0, flags: 4, raw: 8, valid: 20, pad: 24, work: 264, size: 300 };
export const MARIO_BYTES = 0x574, CAMERA_BYTES = 0x350;

export interface TraceStage {
    ev: number;
    /** words[2] scene, [3] previous / [4] current / [5] next scene (area, episode, u16 each), [6] the RNG seed,
     *  [9..11] the stage heap's used head / free tail / size, [14] TV format, [15] the application's movie */
    words: Uint32Array;
    /** the TFlagManager object's 0x380 bytes */
    flags: Uint8Array;
    npcPhase: number; observations: number;
    /** Moonshine's settings in effect (the session record before it) */
    session: Uint8Array | null;
}
export interface TraceFrame {
    ev: number; frame: number;
    scene: number; context: number; retrace: number; osTick: number; seed: number; tick: number;
    /** the director's state (-1: no stage director) */
    state: number;
    menuShown: boolean; setupDone: boolean; setupThreadDone: boolean;
    /** Moonshine's settings, when they changed at this frame */
    session: Uint8Array | null;
    /** the flag manager, camera, FLUDD and Yoshi objects as the frame began (null: not recorded yet) */
    flags: Uint8Array | null;
}
/** `mirrors`: JUTGamePad's port-0 statics as the pad was read (mPadButton[0] 48 bytes, mPadMStick[0] 16, mPadSStick[0] 16) */
export interface TracePad { ev: number; frame: number; frozen: boolean; suppressed: boolean; input: Uint8Array; mirrors: Uint8Array | null }
export interface TraceTick {
    ev: number; frame: number; tick: number; input: Uint8Array; mirrors: Uint8Array | null;
    marioPtr: number; mario: Uint8Array | null;
    cameraPtr: number; camera: Uint8Array | null;
}

export interface Trace {
    gameId: string; discRevision: number; container: number; capabilities: number; complete: boolean;
    n: number;
    kind: Uint8Array;
    /** STAGE / FRAME / PAD / TICK: the index in its list. RAND / LIT: the caller */
    a: Uint32Array;
    /** RAND: the seed after the call. LIT: the value */
    b: Uint32Array;
    /** LIT: the seed at the read */
    c: Uint32Array;
    stages: TraceStage[]; frames: TraceFrame[]; pads: TracePad[]; ticks: TraceTick[];
    runFlags: number;
}

export class TraceFormatError extends Error { }

export function readTrace(buf: ArrayBuffer): Trace {
    let cap = 1 << 16, n = 0;
    let kind = new Uint8Array(cap), a = new Uint32Array(cap), b = new Uint32Array(cap), c = new Uint32Array(cap);
    const push = (k: number, x: number, y = 0, z = 0) => {
        if (n === cap) {
            cap *= 2;
            const k2 = new Uint8Array(cap), a2 = new Uint32Array(cap), b2 = new Uint32Array(cap), c2 = new Uint32Array(cap);
            k2.set(kind); a2.set(a); b2.set(b); c2.set(c); kind = k2; a = a2; b = b2; c = c2;
        }
        kind[n] = k; a[n] = x; b[n] = y; c[n] = z; return n++;
    };
    const stages: TraceStage[] = [], frames: TraceFrame[] = [], pads: TracePad[] = [], ticks: TraceTick[] = [];
    const blobs = new Map<number, BlobState>();
    let input: Uint8Array | null = null, scene = -1, session: Uint8Array | null = null, sessionNew = false;
    let mirrors: Uint8Array | null = null;
    let pending: TraceTick | null = null, gameId = '', discRevision = 0, runFlags = 0;
    const snap = (k: number, bytes: number) => { const s = blobs.get(k); return s && s.data.length === bytes ? { ptr: s.pointer, data: s.data.slice() } : null; };
    const flush = () => {
        if (!pending) return;
        const m = snap(K.MARIO, MARIO_BYTES), cam = snap(K.CAMERA, CAMERA_BYTES);
        if (m) { pending.marioPtr = m.ptr; pending.mario = m.data; }
        if (cam) { pending.cameraPtr = cam.ptr; pending.camera = cam.data; }
        pending = null;
    };
    let version = 3;
    const sum = readMstr(buf, (r) => {
        const bv = new DataView(r.body.buffer, r.body.byteOffset, r.body.byteLength);
        switch (r.kind) {
            case K.FRAME: {
                flush();
                const s = bv.getUint32(0);
                if (s !== scene) { blobs.clear(); scene = s; input = null; }
                const w7 = bv.getUint32(28);
                const f: TraceFrame = {
                    ev: 0, frame: r.frame, scene: s, context: bv.getUint32(4), retrace: bv.getUint32(8), osTick: bv.getUint32(12), seed: bv.getUint32(16),
                    tick: bv.getUint32(20), state: bv.getUint32(24) | 0, menuShown: (w7 & 1) !== 0, setupDone: (w7 & 2) !== 0, setupThreadDone: (w7 & 4) !== 0,
                    session: null, flags: null,
                };
                f.ev = push(Ev.FRAME, frames.length); frames.push(f);
                break;
            }
            case K.MARIO: case K.CAMERA: case K.FLAGS: case K.FLUDD: case K.YOSHI:
                applyBlob(r.body, bv, version, blobs, r.kind);
                if (r.kind === K.FLAGS && frames.length) { const s = snap(K.FLAGS, 0x380); if (s) frames[frames.length - 1].flags = s.data; }
                break;
            case K.INPUT: case K.INPUT_DELTA: {
                flush();
                if (r.kind === K.INPUT) input = r.body.slice(); else { input = input!.slice(); applyInputDelta(input, r.body, bv); }
                const flags = new DataView(input.buffer).getUint32(IN.flags);
                if (flags & 0x80000000) { const p: TracePad = { ev: 0, frame: r.frame, frozen: (flags & 1) !== 0, suppressed: (flags & 2) !== 0, input, mirrors }; p.ev = push(Ev.PAD, pads.length); pads.push(p); }
                else { const t: TraceTick = { ev: 0, frame: r.frame, tick: r.tick, input, mirrors, marioPtr: 0, mario: null, cameraPtr: 0, camera: null }; t.ev = push(Ev.TICK, ticks.length); ticks.push(t); pending = t; }
                break;
            }
            case 24: if (r.body.length === 88) mirrors = r.body.slice(8, 88); break;   // pad mirrors
            case 25: if (mirrors) {   // pad mirrors, the changed words
                mirrors = mirrors.slice();
                const mask = bv.getUint32(8);
                for (let w = 0, p = 12; w < 20; w++) if (mask & (1 << w)) { mirrors.set(r.body.subarray(p, p + 4), w * 4); p += 4; }
            } break;
            case K.SESSION:
                session = r.body.slice(); sessionNew = true;
                if (frames.length && frames[frames.length - 1].frame === r.frame) { frames[frames.length - 1].session = session; sessionNew = false; }
                break;
            case K.STAGE_START: {
                if (r.body.length !== 968 || bv.getUint32(0) !== 3) throw new TraceFormatError('this trace was recorded by an older Moonshine: v3 needs stage-start schema 3');
                const words = new Uint32Array(16); for (let i = 0; i < 16; i++) words[i] = bv.getUint32(i * 4);
                if (!(words[1] & 1)) throw new TraceFormatError('the trace has no flag image at its stage start');
                const st: TraceStage = { ev: 0, words, flags: r.body.slice(64, 960), npcPhase: bv.getUint32(960), observations: bv.getUint32(964), session };
                st.ev = push(Ev.STAGE, stages.length); stages.push(st);
                break;
            }
            case K.IDENTITY: {
                const d0 = bv.getUint32(0), d1 = bv.getUint32(4);
                gameId = String.fromCharCode(d0 >>> 24, (d0 >>> 16) & 0xFF, (d0 >>> 8) & 0xFF, d0 & 0xFF, d1 >>> 24, (d1 >>> 16) & 0xFF); discRevision = d1 & 0xFF;
                break;
            }
            case K.PROVENANCE: if (r.body.length >= 8) runFlags |= bv.getUint32(4); break;
            case K.RNG: push(Ev.LIT, bv.getUint32(0), bv.getUint32(4), bv.getUint32(8)); break;
            case K.RNG_BLOCK: {
                let seed = bv.getUint32(0);
                const count = bv.getUint32(8), callers = bv.getUint32(12), idx = 16 + callers * 4;
                for (let i = 0; i < count; i++) { if (i) seed = lcgNext(seed); push(Ev.RAND, bv.getUint32(16 + 4 * r.body[idx + i]), seed); }
                break;
            }
        }
    });
    flush();
    version = sum.header.version;
    if (version !== 3) throw new TraceFormatError(`trace container ${version}: v3 needs container 3`);
    if (!stages.length) throw new TraceFormatError('the trace has no stage-start record');
    if (stages[0].ev > frames[0]?.ev) { /* the stage start is written with the first frame when capture began at setup */ }
    void MstrError; void sessionNew;
    return { gameId, discRevision, container: version, capabilities: sum.header.capabilities, complete: sum.complete, n, kind, a, b, c, stages, frames, pads, ticks, runFlags };
}
