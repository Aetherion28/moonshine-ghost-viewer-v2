import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const a = +process.argv[3], b = +process.argv[4]; let n = 0;
replayMstr(buf as ArrayBuffer, { onFrame: (s: any) => { n++; if (s.tick >= a && s.tick <= b) console.log('frame', s.frame, 'tick', s.tick, 'menu', s.menuShown, 'dir', s.directorState, 'ctx', s.context, 'osTick', s.osTick); } } as any);
