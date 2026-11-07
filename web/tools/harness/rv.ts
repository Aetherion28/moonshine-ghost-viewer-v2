import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); const q0 = g.segments[0].startQf; const R = g.trace.rng; const a = +process.argv[3], b = +process.argv[4]; const skip = new Set(['801c2458','801c24ac','801c2504','801ec17c','801ec198','801ec1d4','801ec1f0','801ebcb0','801ebcec']);
for (let i = 0; i < R.count; i++) { const q = R.qf[i] - q0; if (q < a || q > b) continue; const c = (R.caller[i] >>> 0).toString(16); if (skip.has(c)) continue; const v = (R.result[i] >>> 0); console.log(q, i, c, v, (v / 32768).toFixed(4)); }
