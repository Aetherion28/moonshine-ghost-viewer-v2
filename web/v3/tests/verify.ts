// v3: the browser's check (web/verify.ts) from Node, on a disc as the browser would get it: a plain disc image
// (.iso / .gcm) or a folder Dolphin extracted (files/ and sys/).
// Run: node v3verify.mjs <disc image or extracted folder> <trace.msgt>
import { readFileSync } from 'node:fs';
import { openDisc } from '../web/discs.ts';
import { source } from './nodedisc.ts';
import { verify } from '../web/verify.ts';

const [disc, trace] = process.argv.slice(2);
if (!disc || !trace) { console.log('node v3verify.mjs <disc image or extracted folder> <trace.msgt>'); process.exit(2); }
const tb = readFileSync(trace);
let last = 0;
const report = await verify(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength) as ArrayBuffer, () => openDisc(source(disc)), {
    slice: 200e6, cancelled: () => false, breathe: async () => { },
    progress: (p) => { if (process.env.QUIET || p.seconds - last < 5) return; last = p.seconds; console.log(`  ${p.phase}${p.attempt > 1 ? ` (start ${p.attempt})` : ''}: frame ${p.frames} of ${p.totalFrames}, ${p.instructions} M instructions, ${p.seconds.toFixed(0)} s`); },
});
console.log(`${report.result}: ${report.summary}`);
console.log(`disc: ${report.disc}; file table padding ${report.fstPad}; ${report.instructions} M instructions in ${report.seconds.toFixed(1)} s`);
for (const i of report.issues.slice(0, 5)) console.log(`  [${i.kind}] frame ${i.frame} tick ${i.tick}: ${i.text.split('\n')[0]}`);
if (report.error) console.log(report.error);
process.exit(report.inStep ? 0 : 1);
