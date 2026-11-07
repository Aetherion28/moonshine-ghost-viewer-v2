import { readFileSync } from 'node:fs';
import { replayMstr, marioView } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const lo = +process.argv[3], hi = +process.argv[4];
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onTick: (s: any) => {
  if (!s.mario || !s.fludd) return; const m = marioView(s.mario); if (process.env.FX && Math.abs(m.pos[0] - +process.env.FX) > 60) return; if (s.tick < +(process.env.TA||0) || s.tick > +(process.env.TB||1e9)) return;
  const d = new DataView(s.fludd.data.buffer, s.fludd.data.byteOffset, s.fludd.data.byteLength);
  console.log(s.frame, s.tick, 'st', m.status.toString(16), 'vy', m.vel[1].toFixed(5), 'x', m.pos[0].toFixed(2), 'water', d.getInt32(0x1C80), 'noz', d.getUint8(0x1C84), d.getUint8(0x1C85), 'press', d.getUint8(0x1C8C), d.getUint8(0x1C8D), 'emitted', d.getUint8(0x1C86), 'epos', [0,1,2].map(i=>d.getFloat32(0x1C90+4*i).toFixed(3)).join(','), 'mpos', m.pos.map((v:number)=>v.toFixed(3)).join(','));
} } as any);
