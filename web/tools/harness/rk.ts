import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, R = g.trace.rng, a=+process.argv[3], b=+process.argv[4], pat = process.argv[5];
for (let i = 0; i < R.count; i++) { const q = R.qf[i] - q0; if (q < a || q > b) continue; const c = R.caller[i].toString(16); if (pat && !new RegExp(pat).test(c)) continue; console.log(i, q, c); }
