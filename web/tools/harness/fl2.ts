import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const Q0 = (parseMstrGhost(buf as ArrayBuffer, 'x') as any).segments[0].startQf; const a = +process.argv[3], b = +process.argv[4];
let wt = 0, ft: number | null = null, lm = false; let last = '';
replayMstr(buf as ArrayBuffer, {
  onFrame: (s: any) => { if (ft === null) wt = s.tick; else if (!(lm || s.menuShown) || s.tick !== ft) wt += 4; lm = s.menuShown; ft = s.tick; },
  onTick: (s: any) => { const q = (ft === null ? s.tick : wt + (s.tick - ft)) - 1 - Q0; if (q < a || q > b) return; const f = s.fludd; if (!f) return; const d = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength); const H = 0x1548;
    const l = `bomb rum ${d.getUint8(0x714)} spray ${d.getUint8(0x715)} timer ${d.getInt16(0x716)} pres ${d.getFloat32(0x718).toFixed(2)} dU378 ${d.getFloat32(0x0C+0x378).toFixed(3)} 1cec ${d.getFloat32(0x1CEC).toFixed(3)} 1c88 ${d.getFloat32(0x1C88).toFixed(3)} water ${d.getInt32(0x1C80)} cur ${d.getUint8(0x1C84)} | 1cc0 ${d.getInt16(0x1CC0)} ${d.getInt16(0x1CC2)} ${d.getInt16(0x1CC4)} 1cc6 ${d.getInt16(0x1CC6)} ${d.getInt16(0x1CC8)} ${d.getInt16(0x1CCA)} ${d.getInt16(0x1CCC)} ${d.getInt16(0x1CCE)} prop ${d.getFloat32(0x1CD0).toFixed(3)} ${d.getInt16(0x1CD4)} ${d.getInt16(0x1CD6)} water ${d.getInt32(0x1C80)} cur ${d.getUint8(0x1C84)} hov anim ${d.getUint16(H + 0x36C)} spray ${d.getUint8(H + 0x385)} timer ${d.getInt16(H + 0x386)} pres ${d.getFloat32(H + 0x388).toFixed(2)} u378 ${d.getFloat32(H + 0x378).toFixed(3)} emitted ${d.getUint8(0x1C86)} 1c88 ${d.getFloat32(0x1C88).toFixed(3)} flags ${d.getUint16(8).toString(16)}`; if (l !== last) console.log(q, l); last = l; } });
