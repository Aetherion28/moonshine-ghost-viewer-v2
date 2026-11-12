// asink <trace>: every recorded actor whose live flag (word 60) first gets the JP sink bit 0x400000, and when
import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const bit = +(process.env.BIT || 0x400000); const seen = new Set<number>();
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (aid: number, _p: number, ext: number, w: Uint32Array, _c: boolean, fr: number, tick: number) => { if (seen.has(aid) || w.length <= 60) return; if ((w[60] >>> 0) & bit) { seen.add(aid); console.log('SINK', aid, tick); } } } as any);
