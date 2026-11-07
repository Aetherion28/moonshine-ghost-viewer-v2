import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); const q0 = g.segments[0].startQf; const A = g.trace.actors; const key = parseInt(process.argv[3], 16); const a = +process.argv[4], b = +process.argv[5];
let last = ''; for (let i = 0; i < A.count; i++) { if (A.key[i] !== key) continue; const q = A.qf[i] - q0; if (q < a || q > b) continue; const s = [A.id[i], A.pos[i*3].toFixed(1), A.pos[i*3+1].toFixed(1), A.pos[i*3+2].toFixed(1), (A.liveFlag[i]>>>0).toString(16)].join(' '); if (s !== last) { console.log(q, s); last = s; } }
