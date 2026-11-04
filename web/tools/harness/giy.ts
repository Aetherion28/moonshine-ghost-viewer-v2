import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, a = +process.argv[3], b = +process.argv[4];
for (const t of g.trace.ticks) { const q = t.qf - q0; if (q < a || q > b || !t.mario) continue; console.log(q, 'iy', t.mario.intendedYaw, 'im', t.mario.intendedMag, 'fa', t.mario.faceAngle[1]); }
