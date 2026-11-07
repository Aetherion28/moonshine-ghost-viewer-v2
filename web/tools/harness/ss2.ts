import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
replayMstr(buf as ArrayBuffer, { onSession: (b: Uint8Array, f: number) => console.log('session frame', f, Buffer.from(b).toString('hex')), onProvenance: (x: number, f: number) => console.log('prov', f, x) } as any);
