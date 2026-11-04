import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, a = +process.argv[3], b = +process.argv[4];
for (const t of g.trace.ticks) { const q = t.qf - q0; if (q < a || q > b || !t.mario) continue; const m = t.mario; console.log(q, m.pos.join(' '), 'st', (m.status>>>0).toString(16), 'fv', m.forwardVel, 'v', m.vel.join(' '), 'sv', m.slideVel.join(' '), 'fa', m.faceAngle[1], 'in', (m.input>>>0).toString(16), 'ss', m.statusState, 'up', m.upperState, 'fl', (m.flag>>>0).toString(16)); }
