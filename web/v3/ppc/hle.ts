// v3: high-level stand-ins for the SDK's hardware-facing functions, hooked by address.
// The game code above them runs as it is; these only answer for hardware the viewer doesn't emulate.
import type { Cpu } from './cpu.js';

export interface Symbols { byName: Map<string, number> }

/** name -> what the function does instead (it returns to LR, results in r3 / f1) */
export const HLE: Record<string, (cpu: Cpu) => void> = {
    // the DSP's boot handshake (audio is not emulated)
    __OSInitAudioSystem: () => { },
    __OSStopAudioSystem: () => { },
    // cache maintenance: no cache is modelled (memory is always coherent)
    DCFlushRange: () => { }, DCFlushRangeNoSync: () => { }, DCInvalidateRange: () => { },
    DCStoreRange: () => { }, DCStoreRangeNoSync: () => { }, ICInvalidateRange: () => { }, ICFlashInvalidate: () => { },
};

export function installHle(cpu: Cpu, syms: Symbols, extra: Record<string, (cpu: Cpu) => void> = {}) {
    const missing: string[] = [];
    for (const [name, fn] of Object.entries({ ...HLE, ...extra })) {
        const a = syms.byName.get(name);
        if (a === undefined) { missing.push(name); continue; }
        cpu.hooks.set(a, fn);
    }
    return missing;
}
