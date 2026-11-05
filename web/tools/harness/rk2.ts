import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
for (let a = 2; a + 1 < process.argv.length; a += 2) { const p = process.argv[a], lc = +process.argv[a + 1];
  try { const B = readFileSync(p); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); const R = g.trace && g.trace.rng; if (!R) { console.log(p, 'norng'); continue; }
  const s = g.segments[0].startQf - g.header.startQf; const c = (i: number) => i < R.count ? R.caller[i].toString(16) + '@' + (R.qf[i] - s) : '-';
  console.log(p, 'LC', lc, 'at', c(lc - 1), c(lc), c(lc + 1)); } catch (e) { console.log(p, 'ERR'); } }
