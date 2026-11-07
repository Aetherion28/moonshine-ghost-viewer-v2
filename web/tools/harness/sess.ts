import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
for (const f of process.argv.slice(2)) { const B = readFileSync(f); const seen = new Set<string>();
  replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onSession: (b: Uint8Array, fr: number) => { const h = Array.from(b.slice(0, 48)).map((x) => x.toString(16).padStart(2, '0')).join(''); if (!seen.has(h)) { seen.add(h); console.log(f.split('/').slice(-2).join('/'), 'frame', fr, 'len', b.length, h); } } }); }
