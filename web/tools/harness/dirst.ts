import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const g: any = parseMstrGhost(buf as ArrayBuffer, 'x'); const q0 = g.segments[0].startQf; const a = +process.argv[3], b = +process.argv[4];
const D = g.trace.director; if (D) for (let i = 0; i < D.qf.length; i++) { const q = D.qf[i] - q0; if (q >= a && q <= b) console.log('dir', q, D.state[i]); }
let last = ''; let n = 0;
replayMstr(buf as ArrayBuffer, { onFrame: (s: any) => { const k = `menu ${s.menuShown} dir ${s.directorState}`; if (k !== last) { console.log('frame', s.frame, 'tick', s.tick, k); last = k; } } });
