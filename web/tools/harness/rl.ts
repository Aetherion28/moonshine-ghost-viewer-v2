import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); const q0 = g.segments[0].startQf; const R = g.trace.rng;
const sites = process.argv[3].split(',').map((x) => parseInt(x, 16)); const a = +process.argv[4], b = +process.argv[5];
const m = new Map<number, number[]>(); for (let i = 0; i < R.count; i++) { const q = R.qf[i] - q0; if (q < a || q > b) continue; const k = sites.indexOf(R.caller[i] >>> 0); if (k < 0) continue; const v = m.get(q) || m.set(q, sites.map(() => 0)).get(q)!; v[k]++; }
for (const [q, v] of [...m].sort((x, y) => x[0] - y[0])) console.log(q, v.join(' '));
