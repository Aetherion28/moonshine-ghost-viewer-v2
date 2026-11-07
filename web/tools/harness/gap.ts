import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const Q0 = (parseMstrGhost(buf as ArrayBuffer, 'x') as any).segments[0].startQf;
let wt = 0, ft: number | null = null, lm = false; let lastq = -1;
replayMstr(buf as ArrayBuffer, {
  onFrame: (s: any) => { if (ft === null) wt = s.tick; else if (!(lm || s.menuShown) || s.tick !== ft) wt += 4; lm = s.menuShown; ft = s.tick; if (wt - Q0 > 8780 && wt - Q0 < 9520 && (wt - Q0) % 40 < 4) console.log('frame', s.frame, 'tick', s.tick, 'wq', wt - Q0, 'menu', s.menuShown, 'dir', s.directorState, 'mario?', !!s.mario); },
  onTick: (s: any) => { const q = (ft === null ? s.tick : wt + (s.tick - ft)) - 1 - Q0; if (q > 8780 && q < 9520 && (q - lastq !== 1 || q % 100 === 0)) console.log('tick', q, 'raw', s.tick, 'frame', s.frame, 'mario', !!s.mario); lastq = q; },
});
