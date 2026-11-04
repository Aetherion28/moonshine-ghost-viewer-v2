import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const X = +process.argv[3], Z = +process.argv[4], R = +process.argv[5];
const f = new Float32Array(1), u = new Uint32Array(f.buffer); const fl = (w: number) => { u[0] = w; return f[0]; };
const last = new Map<number, any>();
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (id, _p, ext, w, cr, fr, tick) => { last.set(id, { tick, ext, key: w[2] >>> 16, type: w[0x4c/4].toString(16), x: fl(w[4]), y: fl(w[5]), z: fl(w[6]) }); } });
for (const [id, a] of last) if (Math.hypot(a.x - X, a.z - Z) < R) console.log(id, JSON.stringify(a));
