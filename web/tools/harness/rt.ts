import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); const q0 = g.segments[0].startQf; const R = g.trace.rng; const a = +process.argv[3], b = +process.argv[4];
let cur = -1, line: string[] = []; const flush = () => { if (line.length) console.log(cur, line.join(' ')); line = []; };
for (let i = 0; i < R.count; i++) { const q = R.qf[i] - q0; if (q < a || q > b) continue; if (q !== cur) { flush(); cur = q; } line.push((R.caller[i] >>> 0).toString(16).slice(-5)); }
flush();
