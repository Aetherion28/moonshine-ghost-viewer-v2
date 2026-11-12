// v3: writes out what the game sends its GPU while a trace is played, video frame by video frame (web/gxframe.ts):
// the files a page that draws the game's GPU commands is tested with, and tests/gxcheck.ts checks.
// Run: node gxdump.mjs <trace.msgt> <out folder> [first frame] [count]
//   Each captured frame becomes <out folder>/f_<its number in the dump, six digits>.gxf, from the first one whose
//   replay frame is at least [first frame] (default: the first captured), [count] of them (default 120). The
//   first file carries the GPU's registers and every piece of memory it reads, so a dump stands by itself.
//   env: FSTPAD=n the file table's padding (480 for the JP recordings at hand), QUIET=0 shows the game's console,
//   NOCAP=1 plays as far without capturing (to time the capture), EVERY=1 compares every read of memory with what
//   was sent (slow; the dump should come out the same)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay } from '../game/replay.ts';
import { versionOf } from '../game/versions.ts';
import { encodeGxFrame, type GxFrame } from '../web/gxframe.ts';
import { symbols } from './syms.ts';
import { discOf, loadBytes } from './jpdisc.ts';

const [file, outDir] = process.argv.slice(2), first = +(process.argv[4] || 0), count = +(process.argv[5] || 120);
if (!file || !outDir) { console.log('usage: node gxdump.mjs <trace.msgt> <out folder> [first frame] [count]'); process.exit(2); }
const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const V = versionOf(T.gameId, T.discRevision);
if (!V) { console.log(`the trace is from ${T.gameId} revision ${T.discRevision}: that version isn't set up here`); process.exit(2); }
const S = symbols(`${process.env.DECOMP || '/home/claude/sms-ai-decomp/config'}/${V.decomp}/symbols.txt`), D = discOf(V.key);
mkdirSync(outDir, { recursive: true });

let seq = 0, dumping = false, bytes = 0, fifoBytes = 0, patchBytes = 0, lastFrame = -1;
const noCap = !!process.env.NOCAP;
const onGxFrame = (f: GxFrame) => {
    lastFrame = f.frame;
    if (seq >= count) return;
    if (!dumping) {
        // (the frames before the first wanted go by; the last few each make the next one stand by itself)
        if (f.frame < first || !f.regs) { if (f.frame >= first - 3) R.m.hw.gx.forget(); return; }
        dumping = true;
    }
    const e = encodeGxFrame(f);
    writeFileSync(`${outDir}/f_${String(seq).padStart(6, '0')}.gxf`, e);
    bytes += e.length; fifoBytes += f.fifo.length; patchBytes += f.patches.reduce((a, p) => a + p.data.length, 0);
    if (++seq >= count) R.m.hw.gx.capture(false);
};
const R = new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), {
    recorded: V.addrs, fstPad: +(process.env.FSTPAD || 480), log: (s) => console.log(s),
    report: process.env.QUIET === '0' ? (t) => process.stdout.write('[game] ' + t) : undefined,
    onGxFrame: noCap ? undefined : onGxFrame,
});
if (process.env.EVERY) R.m.hw.gx.captureEvery = true;
const t0 = performance.now();
let res = 'budget';
// (without capturing: as many of the recording's frames as the dump would have needed)
const enough = () => noCap ? R.frames >= first + count : seq >= count;
while (!enough() && (res = R.run(20e6)) !== 'done');
const dt = (performance.now() - t0) / 1000;
if (R.heapDelta) console.log(`the stage heap is ${R.heapDelta} bytes off the recording's: run again with FSTPAD=${R.fstPadUsed + R.heapDelta}`);
console.log(`${R.stageName}: ${seq} frame(s) written to ${outDir} (${(bytes / 1e6).toFixed(1)} MB: ${(fifoBytes / 1e6).toFixed(1)} MB of commands, ${(patchBytes / 1e6).toFixed(1)} MB of memory), the replay at frame ${R.frames} of ${T.frames.length}${lastFrame >= 0 ? `, the last video frame in replay frame ${lastFrame}` : ''}; ${R.issues.length} issue(s); ${dt.toFixed(1)} s`);
process.exit(seq || noCap ? 0 : 1);
