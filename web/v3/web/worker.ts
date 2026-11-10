// v3 in the browser: a Web Worker that plays a trace in the game's own code (from the user's disc) and
// reports how far the game's state matches the recording (web/verify.ts).
//
// To the worker:   { type: 'start', trace: ArrayBuffer, disc: DiscSource, slice?: instructions a slice }
//                  { type: 'cancel' }
// From the worker: { type: 'progress', ... } (VerifyProgress), { type: 'done', report: VerifyReport }
import { openDiscSource } from './discs.ts';
import { verify, type VerifyProgress, type VerifyReport } from './verify.ts';
export type { VerifyProgress, VerifyReport } from './verify.ts';

const post = (m: VerifyProgress | { type: 'done'; report: VerifyReport }) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let cancelled = false, running = false;

self.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === 'cancel') { cancelled = true; return; }
    if (m.type !== 'start' || running) return;
    running = true; cancelled = false;
    verify(m.trace, () => openDiscSource(m.disc), {
        slice: m.slice || 50e6, progress: post, cancelled: () => cancelled, breathe: () => new Promise((res) => setTimeout(res, 0)),
    }).then((report) => post({ type: 'done', report })).finally(() => { running = false; });
};
