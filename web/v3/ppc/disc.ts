// v3: a disc made from the user's extracted files. The game finds files through the file system table
// (FST) the boot code leaves in memory and reads them by disc offset through the drive: this builds an
// FST for the files it is given and answers reads at the offsets it assigned. The layout is not the
// retail disc's (the game never depends on where a file lies), and only the files given exist.

export interface DiscFile {
    /** the path on the disc, e.g. "data/scene/dolpic0.szs" */
    path: string;
    size: number;
    /** the file's bytes (called on the first read; the result is kept) */
    load(): Uint8Array;
}

interface Placed { file: DiscFile; offset: number; data: Uint8Array | null }

export class VirtualDisc {
    /** boot.bin: the game ID, the disc magic, where the FST lies */
    header = new Uint8Array(0x440);
    fst: Uint8Array;
    pal: boolean;
    private placed: Placed[] = [];
    /** reads that touched no file (debugging) */
    misses = 0;
    /** called with each file as a read first touches it */
    onOpen: ((path: string) => void) | null = null;

    /** gameId: the six characters of the disc's ID ("GMSJ01"); version: its revision byte */
    constructor(gameId: string, version: number, files: DiscFile[]) {
        for (let i = 0; i < 6; i++) this.header[i] = gameId.charCodeAt(i);
        this.header[7] = version;
        new DataView(this.header.buffer).setUint32(0x1C, 0xC2339F3D);
        this.pal = gameId[3] === 'P';

        // the directory tree
        interface Dir { name: string; dirs: Map<string, Dir>; files: [string, DiscFile][] }
        const root: Dir = { name: '', dirs: new Map(), files: [] };
        for (const f of files) {
            const parts = f.path.split('/').filter(Boolean);
            let d = root;
            for (const p of parts.slice(0, -1)) { let n = d.dirs.get(p); if (!n) { n = { name: p, dirs: new Map(), files: [] }; d.dirs.set(p, n); } d = n; }
            d.files.push([parts[parts.length - 1], f]);
        }
        // entries in the order the disc tools write them: a directory, then its content sorted by name
        const entries: { dir: boolean; name: string; a: number; b: number; file?: DiscFile }[] = [];
        const walk = (d: Dir, parent: number) => {
            const self = entries.length;
            entries.push({ dir: true, name: d.name, a: parent, b: 0 });
            const items: [string, Dir | DiscFile][] = [...d.dirs.entries(), ...d.files];
            items.sort((x, y) => (x[0].toLowerCase() < y[0].toLowerCase() ? -1 : 1));
            for (const [name, it] of items) {
                if ('dirs' in it) walk(it, self);
                else entries.push({ dir: false, name, a: 0, b: it.size, file: it });
            }
            entries[self].b = entries.length;
        };
        walk(root, 0);
        // file data from 0x100000, each file aligned to 32 KB (as retail discs are, for the drive's DMA)
        let off = 0x100000;
        for (const e of entries) if (!e.dir) { e.a = off; this.placed.push({ file: e.file!, offset: off, data: null }); off = (off + e.b + 0x7FFF) & ~0x7FFF; }
        // the table: 12 bytes an entry, then the names
        let names = 0;
        const nameOff: number[] = [];
        for (const e of entries) { nameOff.push(names); names += e.name.length + 1; }
        this.fst = new Uint8Array((entries.length * 12 + names + 31) & ~31);
        const dv = new DataView(this.fst.buffer);
        entries.forEach((e, i) => {
            dv.setUint32(i * 12, ((e.dir ? 1 : 0) << 24) | (i ? nameOff[i] : 0));
            dv.setUint32(i * 12 + 4, e.a); dv.setUint32(i * 12 + 8, e.b);
            for (let k = 0; k < e.name.length; k++) this.fst[entries.length * 12 + nameOff[i] + k] = e.name.charCodeAt(k);
        });
        const h = new DataView(this.header.buffer);
        h.setUint32(0x420, 0x1E000);   // the DOL's offset (not read through the drive here)
        h.setUint32(0x424, 0x80000); h.setUint32(0x428, this.fst.length); h.setUint32(0x42C, this.fst.length);
    }

    /** Copies `len` bytes at disc offset `off` into out[at..]. */
    read(off: number, len: number, out: Uint8Array, at: number) {
        let done = 0;
        if (off < 0x440) { const n = Math.min(len, 0x440 - off); out.set(this.header.subarray(off, off + n), at); done = n; }
        while (done < len) {
            const o = off + done;
            // (the files are in offset order: a binary search)
            let lo = 0, hi = this.placed.length - 1, p: Placed | null = null;
            while (lo <= hi) { const mid = (lo + hi) >> 1, q = this.placed[mid]; if (q.offset > o) hi = mid - 1; else { p = q; lo = mid + 1; } }
            if (p && o < p.offset + p.file.size) {
                if (!p.data) { p.data = p.file.load(); if (this.onOpen) this.onOpen(p.file.path); }
                const n = Math.min(len - done, p.file.size - (o - p.offset));
                out.set(p.data.subarray(o - p.offset, o - p.offset + n), at + done); done += n;
            } else {
                // between files: zeros up to the next file
                const next = p ? this.placed[this.placed.indexOf(p) + 1] : this.placed[0];
                const n = Math.min(len - done, next && next.offset > o ? next.offset - o : len - done);
                if (done === 0) this.misses++;
                out.fill(0, at + done, at + done + n); done += n;
            }
        }
    }
}
