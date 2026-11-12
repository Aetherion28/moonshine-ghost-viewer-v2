// v3 in the browser: a Web Worker that plays a trace in the game's own code (from the user's disc) and
// reports how far the game's state matches the recording (web/verify.ts).
//
// To the worker:   { type: 'start', trace: ArrayBuffer, disc: DiscSource, slice?: instructions a slice }
//                  { type: 'cancel' }
//                  (live: true asks for the game's state at every frame as well; gx: true for what the game sends
//                  its GPU, each video frame of a stage)
// From the worker: { type: 'progress', ... } (VerifyProgress), { type: 'done', report: VerifyReport },
//                  with live: { type: 'intro', ... } (VerifyIntro) once, { type: 'live', ... } (LiveBatch) before each progress
//                  with gx: { type: 'gxframe', ... } (GxFrame, gxframe.ts) for each video frame, its buffers handed over
import { openDiscSource } from './discs.ts';
import { verify, type VerifyProgress, type VerifyReport, type VerifyIntro, type LiveSample } from './verify.ts';
export type { VerifyProgress, VerifyReport, VerifyIntro } from './verify.ts';
import type { GxFrame } from './gxframe.ts';
export type { GxFrame } from './gxframe.ts';

/** the game's state over the frames since the last batch: Mario and the camera six numbers a frame, the actors three each from `actorAt[k]` to `actorAt[k + 1]` */
export interface LiveBatch { type: 'live'; attempt: number; frames: Int32Array; ticks: Int32Array; mario: Float32Array; camera: Float32Array; actorAt: Uint32Array; actors: Float32Array }

const out = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void };
const post = (m: VerifyProgress | VerifyIntro | { type: 'done'; report: VerifyReport }) => out.postMessage(m);
let pending: LiveSample[] = [], pendingAttempt = 0;
function flush() {
    if (!pending.length) return;
    const n = pending.length, total = pending.reduce((a, s) => a + s.actors.length, 0);
    const b: LiveBatch = { type: 'live', attempt: pendingAttempt, frames: new Int32Array(n), ticks: new Int32Array(n), mario: new Float32Array(n * 6), camera: new Float32Array(n * 6), actorAt: new Uint32Array(n + 1), actors: new Float32Array(total) };
    let at = 0;
    pending.forEach((s, k) => { b.frames[k] = s.frame; b.ticks[k] = s.tick; b.mario.set(s.mario, k * 6); b.camera.set(s.camera, k * 6); b.actorAt[k] = at; b.actors.set(s.actors, at); at += s.actors.length; });
    b.actorAt[n] = at; pending = [];
    out.postMessage(b, [b.frames.buffer, b.ticks.buffer, b.mario.buffer, b.camera.buffer, b.actorAt.buffer, b.actors.buffer]);
}
/** A frame of GPU commands goes as it is: its bytes are in two buffers (the stream, the patches) and the registers' three. */
function postGx(f: GxFrame) {
    const bufs = new Set<ArrayBufferLike>([f.fifo.buffer]);
    for (const p of f.patches) bufs.add(p.data.buffer);
    if (f.regs) { bufs.add(f.regs.cp.buffer); bufs.add(f.regs.bp.buffer); bufs.add(f.regs.xf.buffer); }
    out.postMessage(f, [...bufs] as Transferable[]);
}
let cancelled = false, running = false;

self.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === 'cancel') { cancelled = true; return; }
    if (m.type !== 'start' || running) return;
    running = true; cancelled = false;
    verify(m.trace, () => openDiscSource(m.disc), {
        slice: m.slice || 50e6, progress: (p) => { flush(); post(p); }, cancelled: () => cancelled, breathe: () => new Promise((res) => setTimeout(res, 0)),
        intro: m.live ? post : undefined,
        live: m.live ? (s, attempt) => { if (attempt !== pendingAttempt) { flush(); pendingAttempt = attempt; } pending.push(s); } : undefined,
        gx: m.gx ? postGx : undefined,
    }).then((report) => { flush(); post({ type: 'done', report }); }).finally(() => { running = false; });
};
