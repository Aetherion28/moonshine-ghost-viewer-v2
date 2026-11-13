// amodel <trace>: each recorded actor's first record: id, key code, position, and whether its TLiveActor::mMActor (+0x74) is set
import { readFileSync } from 'fs';
import { replayMstr } from '../../src/ghost/mstr.js';
const b = readFileSync(process.argv[2]); const seen = new Set<number>(); const out: any[] = [];
const f32 = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];
replayMstr(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { onActor: (id, ptr, ext, w) => {
    if (seen.has(id) || w[4] === 0) return; seen.add(id);
    out.push([id, w[2] >>> 16, +f32(w[4]).toFixed(1), +f32(w[5]).toFixed(1), +f32(w[6]).toFixed(1), ext > 0x74 && w[29] !== 0 ? 1 : 0]);
} });
console.log(JSON.stringify(out));
