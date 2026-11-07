import { readFileSync } from 'node:fs';
import { replayMstr, padView } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const a = +process.argv[3], b = +process.argv[4]; let last = '';
replayMstr(buf as ArrayBuffer, { onTick: (s: any) => { if (s.tick < a || s.tick > b || !s.input) return; const p = padView(s.input); const k = (p.button >>> 0).toString(16) + ' ' + p.stickX + ',' + p.stickY + ' fp ' + ((s.input[4] & 0x80) ? 1 : 0); if (k !== last) { console.log('frame', s.frame, 'tick', s.tick, k); last = k; } } } as any);
