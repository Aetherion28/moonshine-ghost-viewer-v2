import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const Q0 = (parseMstrGhost(buf as ArrayBuffer, 'x') as any).segments[0].startQf;
const a = +process.argv[3], b = +process.argv[4];
let wt = 0, ft: number | null = null, lm = false; const seen = new Set<number>(); let last = '';
replayMstr(buf as ArrayBuffer, {
  onFrame: (s: any) => { if (ft === null) wt = s.tick; else if (!(lm || s.menuShown) || s.tick !== ft) wt += 4; lm = s.menuShown; ft = s.tick; },
  onTick: (s: any) => { const q = (ft === null ? s.tick : wt + (s.tick - ft)) - 1 - Q0; if (q < a || q > b || seen.has(q)) return; seen.add(q);
    const m = s.cameraMeta; if (!m) return; const h = Buffer.from(m.inbetween).toString('hex'); const k = m.mode + ' ' + h; if (k !== last) { console.log(q, m.mode, h); last = k; } },
} as any);
