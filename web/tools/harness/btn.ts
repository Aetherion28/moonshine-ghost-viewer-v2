import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf, I = g.inputs, a = +process.argv[3], b = +process.argv[4];
for (let i = 0; i < I.count; i++) { const q = I.qf[i] - q0; if (q < a || q > b) continue; console.log(q, 'btn', I.buttons[i].toString(16), 'stick', I.stick[2*i], I.stick[2*i+1], 'trig', I.trig[2*i], I.trig[2*i+1]); }
