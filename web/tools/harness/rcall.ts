import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, a = +process.argv[3], b = +process.argv[4], R = g.trace.rng;
console.log('id', g.identity?.gameId ?? g.header?.gameId);
const out: string[] = [];
for (let i = 0; i < R.count; i++) { const q = R.qf[i] - q0; if (q < a || q > b) continue; out.push(q + ':' + R.caller[i].toString(16) + ':' + (R.result[i] / 32768).toFixed(3)); }
console.log(out.join(' '));
