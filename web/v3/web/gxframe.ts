// v3: what the game sent its GPU in one video frame, as the worker hands it to a page that draws it.
//
// The page keeps a mirror of the game's RAM (24 MB, addressed as the game addresses it: 0x80000000 is offset 0)
// and of the GPU's registers, and runs the command stream against them, as the GPU does:
//   - `fifo` is the bytes of the write-gather pipe, in order, exactly as the game wrote them: BP / CP / XF register
//     loads, primitives with their vertices, display-list calls (CALL_DL address, size: the list's bytes are in
//     RAM), the EFB copies. A frame ends with the copy to the display (the XFB copy), which is its last command.
//   - `patches` are the parts of RAM this frame's commands read (display lists, the vertex arrays the CP array
//     registers point at, the arrays that indexed matrix and light loads read, texture images and their palettes)
//     whose bytes the page doesn't have yet or that changed since it got them. Each is applied as the command at
//     offset `at` of `fifo` is about to run (the game may fill the same memory again between two draws of a
//     frame); they are in the order of `at`.
//   - `regs` (the first frame after capture starts, or after frames were skipped): the GPU's registers as they
//     stood before this frame's commands: CP (256 words, by register number), BP (256 words, by register number,
//     each the 24 bits last loaded), XF (0x1100 words, by XF address: the matrix memory from 0x000, the registers from
//     0x1000; floats as their bits).
export interface GxFrame {
    type: 'gxframe';
    /** the replay's frame (the recording's frame count so far) and movement tick this was drawn in */
    frame: number; tick: number;
    fifo: Uint8Array;
    patches: GxPatch[];
    regs?: { cp: Uint32Array; bp: Uint32Array; xf: Uint32Array };
}
/** bytes of the game's RAM, put in before the command at `fifo[at]` runs: `addr` is the game's address (0x80000000 and up) */
export interface GxPatch { at: number; addr: number; data: Uint8Array }

const MAGIC = 0x47584652;   // 'GXFR'

/** A frame as one block of bytes (a file for the tests, or a message's transferable). */
export function encodeGxFrame(f: GxFrame): Uint8Array {
    const head = JSON.stringify({ frame: f.frame, tick: f.tick, fifo: f.fifo.length, patches: f.patches.map((p) => [p.at, p.addr, p.data.length]), regs: f.regs ? [f.regs.cp.length, f.regs.bp.length, f.regs.xf.length] : null });
    const hb = new TextEncoder().encode(head), pad = (4 - (hb.length & 3)) & 3;
    let n = 8 + hb.length + pad + f.fifo.length + f.patches.reduce((a, p) => a + p.data.length, 0);
    if (f.regs) n += (f.regs.cp.length + f.regs.bp.length + f.regs.xf.length) * 4;
    const out = new Uint8Array(n), dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC); dv.setUint32(4, hb.length);
    out.set(hb, 8);
    let at = 8 + hb.length + pad;
    out.set(f.fifo, at); at += f.fifo.length;
    for (const p of f.patches) { out.set(p.data, at); at += p.data.length; }
    if (f.regs) for (const r of [f.regs.cp, f.regs.bp, f.regs.xf]) for (let i = 0; i < r.length; i++, at += 4) dv.setUint32(at, r[i]);
    return out;
}
export function decodeGxFrame(b: Uint8Array): GxFrame {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(0) !== MAGIC) throw new Error('not a GX frame');
    const hn = dv.getUint32(4), head = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + hn)));
    let at = 8 + hn + ((4 - (hn & 3)) & 3);
    const take = (n: number) => { const s = b.subarray(at, at + n); at += n; return s; };
    const fifo = take(head.fifo), patches: GxPatch[] = head.patches.map(([p, addr, n]: [number, number, number]) => ({ at: p, addr, data: take(n) }));
    const words = (n: number) => { const w = new Uint32Array(n); for (let i = 0; i < n; i++, at += 4) w[i] = dv.getUint32(at); return w; };
    const regs = head.regs ? { cp: words(head.regs[0]), bp: words(head.regs[1]), xf: words(head.regs[2]) } : undefined;
    return { type: 'gxframe', frame: head.frame, tick: head.tick, fifo, patches, regs };
}
