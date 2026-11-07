import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const Q0 = (parseMstrGhost(buf as ArrayBuffer, 'x') as any).segments[0].startQf;
let wt = 0, ft: number | null = null, lm = false; const seen = new Set<number>(); const hist = [0, 0, 0, 0]; const ex: string[] = [];
replayMstr(buf as ArrayBuffer, {
  onFrame: (s: any) => { if (ft === null) wt = s.tick; else if (!(lm || s.menuShown) || s.tick !== ft) wt += 4; lm = s.menuShown; ft = s.tick; },
  onTick: (s: any) => { const q = (ft === null ? s.tick : wt + (s.tick - ft)) - 1 - Q0; if (seen.has(q)) return; seen.add(q); const m = s.mario; if (!m) return; const d = new DataView(m.data.buffer, m.data.byteOffset, m.data.byteLength); const n = d.getUint16(0x48); if (n > 0) { hist[((q % 4) + 4) % 4]++; if (ex.length < 12) ex.push(q + ':' + n); } },
} as any);
console.log('colCount>0 by stage qf mod 4', hist.join(' '), ex.join(' '));
