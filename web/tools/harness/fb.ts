import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const f = g.trace?.feedback; console.log('feedback', f ? f.count : 'none', 'q0', g.segments[0].startQf);
if (f) for (let i = 0; i < Math.min(f.count, 20); i++) console.log(f.qf[i] - g.segments[0].startQf, f.consumer[i], f.value[i]);
