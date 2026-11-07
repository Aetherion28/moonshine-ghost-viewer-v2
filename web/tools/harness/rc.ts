import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const g: any = parseMstrGhost(buf as ArrayBuffer, 'x'); const q0 = g.segments[0].startQf; const A = g.trace.actors; const key = parseInt(process.argv[3], 16);
const last = new Map<number, string>();
for (let i = 0; i < A.count; i++) { if (A.key[i] !== key) continue; const id = A.id[i]; const s = (A.liveFlag[i] >>> 0).toString(16) + ' hf ' + (A.hitFilter[i] >>> 0).toString(16); if (last.get(id) !== s) { last.set(id, s); console.log(A.qf[i] - q0, id, s, A.pos[i*3].toFixed(1), A.pos[i*3+1].toFixed(1), A.pos[i*3+2].toFixed(1)); } }
