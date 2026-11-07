import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const g: any = parseMstrGhost(buf as ArrayBuffer, 'x'); const q0 = g.segments[0].startQf; const A = g.trace.actors;
const X = +process.argv[3], Z = +process.argv[4], R = +process.argv[5], a = +process.argv[6], b = +process.argv[7], only = process.argv[8] ? +process.argv[8] : -1;
for (let i = 0; i < A.count; i++) { const q = A.qf[i] - q0; if (q < a || q > b) continue; if (only >= 0 && A.id[i] !== only) continue; const x = A.pos[i*3], y = A.pos[i*3+1], z = A.pos[i*3+2]; if (Math.hypot(x - X, z - Z) < R) console.log(q, A.id[i], 'key', A.key[i].toString(16), x.toFixed(2), y.toFixed(2), z.toFixed(2), 'lf', (A.liveFlag[i] >>> 0).toString(16), 'hf', (A.hitFilter[i] >>> 0).toString(16)); }
