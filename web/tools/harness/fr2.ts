import { readFileSync } from 'node:fs';
import { readMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const a = +process.argv[3], b = +process.argv[4]; const kinds = new Map<string, number>(); let cur = -1;
readMstr(buf as ArrayBuffer, (r: any) => { if (r.frame < a || r.frame > b) return; if (r.kind === 2) console.log('F', r.frame, r.tick, Buffer.from(r.body).toString('hex')); else console.log('  k', r.kind, r.tick, r.body.length); });
