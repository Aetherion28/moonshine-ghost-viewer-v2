// (a tool for the v2 port) plays a trace and prints who calls a function between two ticks: its arguments and the
// chain of callers (return addresses up the stack, named from the decomp's symbols).
// Run: node calls.mjs <trace> <from tick> <to tick> <function address or symbol> [more ...]   (env FSTPAD, default 480)
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay } from '../game/replay.ts';
import { versionOf } from '../game/versions.ts';
import { symbols } from './syms.ts';
import { discOf, loadBytes } from './jpdisc.ts';
const [file, a1, a2, ...fns] = process.argv.slice(2);
const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const V = versionOf(T.gameId, T.discRevision)!;
const S = symbols(`${process.env.DECOMP || '/home/claude/sms-ai-decomp/config'}/${V.decomp}/symbols.txt`), D = discOf(V.key);
const R = new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), { log: () => {}, fstPad: +(process.env.FSTPAD ?? 480) });
const from = +a1, to = +a2, mem = R.m.mem, hex = (v: number) => (v >>> 0).toString(16);
for (const f of fns) {
    const addr = /^[0-9a-fA-F]{8}$/.test(f) ? parseInt(f, 16) : S.byName.get(f) ?? [...S.byName].find(([n]) => n.startsWith(f))?.[1];
    if (!addr) { console.log('no function ' + f); continue; }
    R.m.cpu.hook(addr, (c) => {
        if (R.ticks >= from && R.ticks <= to) {
            const chain: string[] = [S.who(c.lr)];
            let sp = c.gpr[1];
            for (let k = 0; k < 8; k++) { const up = mem.r32(sp); if (up < 0x80003000 || up >= 0x81800000) break; const lr = mem.r32(up + 4); if (lr >= 0x80003000 && lr < 0x81800000) chain.push(S.who(lr)); sp = up; }
            console.log(`tick ${R.ticks} ${S.who(addr)} r3 ${hex(c.gpr[3])} r4 ${hex(c.gpr[4])} r5 ${hex(c.gpr[5])} r6 ${hex(c.gpr[6])} f1 ${c.ps0[1]} <- ${chain.join(' <- ')}`);
        }
        return false;
    });
}
while (R.ticks <= to && R.run(200e6) !== 'done');
console.log(`the replay: tick ${R.ticks}, ${R.issues.length} issue(s)`);
