// the decomp's symbols.txt (names and sizes by address), for probes and HLE hooks
import { readFileSync } from 'node:fs';
export function symbols(path = '/home/claude/sms-ai-decomp/config/GMSJ01/symbols.txt') {
    const byAddr = new Map<number, string>(), byName = new Map<string, number>(), list: [number, number, string][] = [];
    for (const l of readFileSync(path, 'utf8').split('\n')) {
        const m = /^(\S+) = \.\w+:0x([0-9A-F]+); \/\/ type:function size:0x([0-9A-F]+)/.exec(l);
        if (!m) continue;
        const a = parseInt(m[2], 16); byAddr.set(a, m[1]); byName.set(m[1], a); list.push([a, parseInt(m[3], 16), m[1]]);
    }
    list.sort((x, y) => x[0] - y[0]);
    const who = (a: number) => { let lo = 0, hi = list.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= a) lo = mid + 1; else hi = mid - 1; } const e = list[hi]; return e && a < e[0] + e[1] ? `${e[2]}+0x${(a - e[0]).toString(16)}` : '?'; };
    return { byAddr, byName, who };
}
