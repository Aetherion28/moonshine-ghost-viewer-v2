import { readFileSync } from 'node:fs';
import { readMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const a = +process.argv[3], b = +process.argv[4]; const kinds = new Map<number, number>();
readMstr(buf as ArrayBuffer, (r: any) => { kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1); if ((r.kind === 10 || r.kind === 11) && r.tick >= a && r.tick <= b) console.log('K', r.kind, 'tick', r.tick, Buffer.from(r.body).toString('hex')); });
console.log('kinds', [...kinds].map(([k, n]) => k + ':' + n).join(' '));
