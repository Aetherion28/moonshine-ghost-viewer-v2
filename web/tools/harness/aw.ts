import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const id = +process.argv[3], lo = +process.argv[4], hi = +process.argv[5];
const u = new Uint32Array(1), f = new Float32Array(u.buffer); const F = (w: number) => { u[0] = w; return f[0]; };
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (aid: number, _p: number, ext: number, w: Uint32Array, _c: boolean, fr: number, tick: number) => { if (aid !== id || tick < lo || tick > hi) return; console.log(fr, tick, 'pos', [4,5,6].map(n=>F(w[n])).join(','), 'rot', [12,13,14].map(n=>F(w[n])).join(','), 'scale', [9,10,11].map(n=>F(w[n])).join(',')); } } as any);
