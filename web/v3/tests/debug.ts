// v3 debugging helpers: the OS's threads and their call stacks, from the game's own structures.
import type { Machine } from '../ppc/machine.ts';

export interface Syms { who(a: number): string }

/** the return addresses up a stack from sp (the back chain at 0(sp), the saved LR at 4(sp)) */
export function backtrace(M: Machine, sp: number, S: Syms, max = 24): string[] {
    const out: string[] = [], mem = M.mem;
    for (let i = 0; i < max && sp >= 0x80000000 && sp < 0x81800000; i++) {
        const next = mem.r32(sp);
        if (next < 0x80000000 || next >= 0x81800000) break;
        const lr = mem.r32(next + 4);
        out.push(S.who(lr));
        sp = next;
    }
    return out;
}
/** every OS thread (the active queue at 0x800000DC): its state, priority, where it resumes, its stack */
export function threads(M: Machine, S: Syms): string {
    const mem = M.mem, lines: string[] = [];
    const cur = mem.r32(0x800000E4);
    for (let t = mem.r32(0x800000DC), n = 0; t && n < 32; t = mem.r32(t + 0x2FC), n++) {
        const state = mem.r16(t + 0x2C8), prio = mem.r32(t + 0x2D0) | 0, srr0 = mem.r32(t + 0x198), sp = mem.r32(t + 4), lr = mem.r32(t + 0x84);
        const running = t === cur;
        lines.push(`thread ${t.toString(16)} state ${['?', 'ready', 'running', '?', 'waiting', '?', '?', '?', 'moribund'][state] ?? state} prio ${prio}${running ? ' (current)' : ''} pc ${S.who(running ? M.cpu.pc : srr0)} lr ${S.who(running ? M.cpu.lr : lr)}`);
        lines.push('    ' + backtrace(M, running ? M.cpu.gpr[1] : sp, S).join(' < '));
    }
    return lines.join('\n');
}
