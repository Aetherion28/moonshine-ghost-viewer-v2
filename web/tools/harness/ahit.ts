import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const want = +process.argv[3];
const f = new Float32Array(1), u = new Uint32Array(f.buffer); const fl = (w: number) => { u[0] = w; return f[0]; };
let n = 0;
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (id, _p, ext, w, cr, fr, tick) => { if (id !== want) return; const k = [w[0x50/4],w[0x54/4],w[0x58/4],w[0x5c/4],w[4],w[5],w[6]].join(); if (k === (globalThis as any).__k) return; (globalThis as any).__k = k; console.log('tick', tick, 'ext', ext, 'pos', fl(w[4]), fl(w[5]), fl(w[6]), 'type', w[0x4c/4].toString(16), 'ar', fl(w[0x50/4]), 'ah', fl(w[0x54/4]), 'dr', fl(w[0x58/4]), 'dh', fl(w[0x5c/4]), 'er', fl(w[0x60/4]), 'hf', w[0x64/4].toString(16)); } });
