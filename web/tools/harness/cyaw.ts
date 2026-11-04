import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, a = +process.argv[3], b = +process.argv[4];
const t0 = g.trace.ticks.find((t: any) => t.camera); console.log(Object.keys(t0), Object.keys(t0.camera||{}));
for (const t of g.trace.ticks) { const q = t.qf - q0; if (q < a || q > b) continue; console.log(q, 'camyaw', t.camera?.yaw, 'iy', t.mario?.intendedYaw, 'stick', JSON.stringify(t.pad ?? t.input ?? null).slice(0,80)); }
