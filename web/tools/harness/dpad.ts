import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const TRIG = new Set([0x1, 0x2, 0x4, 0x8, 0x401, 0x402, 0x404, 0x408]);
for (const f of process.argv.slice(2)) {
  const B = readFileSync(f); let g: any; try { g = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); } catch (e) { console.log(f, 'ERR'); continue; }
  const I = g.inputs, q0 = g.segments[0].startQf, hits = new Map<number, number[]>();
  let prev = -1;
  for (let i = 0; i < I.count; i++) { const b = I.buttons[i] & 0xffff; if (TRIG.has(b) && b !== prev) { if (!hits.has(b)) hits.set(b, []); hits.get(b)!.push(I.qf[i] - q0); } prev = b; }
  if (hits.size) console.log(f.split('/').slice(-2).join('/'), [...hits].map(([b, q]) => b.toString(16) + ':' + q.slice(0, 5).join(',') + (q.length > 5 ? '…(' + q.length + ')' : '')).join(' '));
}
