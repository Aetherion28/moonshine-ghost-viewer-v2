// alf <trace> <actor> <from> <to>: an actor's recorded live flag (word 60 of a 0x150 record) whenever it changes
import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const id = +process.argv[3], lo = +process.argv[4], hi = +process.argv[5]; let last = -1;
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (aid: number, _p: number, ext: number, w: Uint32Array, _c: boolean, fr: number, tick: number) => { if (aid !== id || tick < lo || tick > hi) return; const v = w.length > 60 ? w[60] >>> 0 : -1; if (v !== last) { console.log(tick, 'live', v.toString(16), 'len', w.length); last = v; } } } as any);
