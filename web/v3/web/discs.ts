// v3 in the browser: the user's disc as the machine's drive. Runs in a worker (FileReaderSync).
//   - a disc image (.iso / .gcm): the image's own boot.bin and file system table, reads served from the image
//     at its own offsets (ImageDisc);
//   - an extracted folder (Dolphin's "Extract Entire Disc": files/ and sys/): with sys/boot.bin and sys/fst.bin
//     the same, each file's reads served from the folder; without them a table built from the files (VirtualDisc).
// Nothing is copied anywhere: the bytes go from the user's files into the machine's memory.
import { VirtualDisc, type DiscFile } from '../ppc/disc.js';

export type DiscSource = { iso: Blob } | { folder: { path: string; file: Blob }[] };
export interface OpenedDisc {
    gameId: string; revision: number; dol: Uint8Array;
    /** how the disc is served ("image", "folder with its file table", "folder") */
    kind: string;
    /** a fresh drive (its `onOpen` and read state are its own; the bytes read so far are shared) */
    make(): VirtualDisc;
}

declare const FileReaderSync: { new(): { readAsArrayBuffer(b: Blob): ArrayBuffer } };
const readBlob = (b: Blob, off: number, len: number) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(b.slice(off, off + len)));
const WHOLE = 16 << 20;   // files up to this size are read whole on their first read and kept

interface Entry { path: string; offset: number; size: number; blob: Blob | null; at: number; data: Uint8Array | null }

/** A file system table's files, in disc-offset order. */
export function parseFst(fst: Uint8Array): { path: string; offset: number; size: number }[] {
    const v = new DataView(fst.buffer, fst.byteOffset, fst.byteLength), n = v.getUint32(8), strings = n * 12, out: { path: string; offset: number; size: number }[] = [];
    const nameAt = (o: number) => { let s = ''; for (let e = strings + o; fst[e]; e++) s += String.fromCharCode(fst[e]); return s; };
    const walk = (first: number, end: number, prefix: string) => {
        for (let i = first; i < end;) {
            const name = nameAt(v.getUint32(i * 12) & 0xFFFFFF);
            if (fst[i * 12] === 1) { const next = v.getUint32(i * 12 + 8); walk(i + 1, next, prefix + name + '/'); i = next > i ? next : i + 1; }
            else { out.push({ path: prefix + name, offset: v.getUint32(i * 12 + 4), size: v.getUint32(i * 12 + 8) }); i++; }
        }
    };
    walk(1, n, '');
    return out.sort((a, b) => a.offset - b.offset);
}

/** The drive over a disc's own header and file table (the shape of ppc/disc.ts's VirtualDisc). */
export class ImageDisc {
    pal: boolean;
    misses = 0;
    onOpen: ((path: string) => void) | null = null;
    private opened = new Set<Entry>();
    /** raw: the image itself, for reads outside every file (null: an extracted folder, which has nothing there) */
    constructor(public header: Uint8Array, public fst: Uint8Array, private files: Entry[], private raw: Blob | null) { this.pal = header[3] === 0x50; }

    read(off: number, len: number, out: Uint8Array, at: number) {
        let done = 0;
        if (off < 0x440) { const n = Math.min(len, 0x440 - off); out.set(this.header.subarray(off, off + n), at); done = n; }
        const files = this.files;
        while (done < len) {
            const o = off + done;
            let lo = 0, hi = files.length - 1, pi = -1;
            while (lo <= hi) { const mid = (lo + hi) >> 1; if (files[mid].offset > o) hi = mid - 1; else { pi = mid; lo = mid + 1; } }
            const p = pi >= 0 ? files[pi] : null;
            if (p && o < p.offset + p.size) {
                if (!this.opened.has(p)) { this.opened.add(p); if (this.onOpen) this.onOpen(p.path); }
                const n = Math.min(len - done, p.size - (o - p.offset)), rel = o - p.offset;
                if (!p.blob) out.fill(0, at + done, at + done + n);
                else if (p.size <= WHOLE) { if (!p.data) p.data = readBlob(p.blob, p.at, p.size); out.set(p.data.subarray(rel, rel + n), at + done); }
                else out.set(readBlob(p.blob, p.at + rel, n), at + done);
                done += n;
            } else {
                const next = files[pi + 1], n = Math.min(len - done, next && next.offset > o ? next.offset - o : len - done);
                if (done === 0) this.misses++;
                if (this.raw) { const b = readBlob(this.raw, o, n); out.fill(0, at + done, at + done + n); out.set(b, at + done); }
                else out.fill(0, at + done, at + done + n);
                done += n;
            }
        }
    }
}

function dolSize(head: Uint8Array) {
    const v = new DataView(head.buffer, head.byteOffset, 0x100);
    let end = 0x100;
    for (let i = 0; i < 18; i++) end = Math.max(end, v.getUint32(i * 4) + v.getUint32(0x90 + i * 4));
    return end;
}
const idOf = (h: Uint8Array) => String.fromCharCode(...h.subarray(0, 6));

export function openDiscSource(src: DiscSource): OpenedDisc {
    if ('iso' in src) {
        const img = src.iso, header = readBlob(img, 0, 0x440), hv = new DataView(header.buffer);
        if (header.length < 0x440 || hv.getUint32(0x1C) !== 0xC2339F3D) throw new Error("the file isn't a GameCube disc image");
        const dolOff = hv.getUint32(0x420), fst = readBlob(img, hv.getUint32(0x424), hv.getUint32(0x428));
        const dol = readBlob(img, dolOff, dolSize(readBlob(img, dolOff, 0x100)));
        const files: Entry[] = parseFst(fst).map((f) => ({ ...f, blob: img, at: f.offset, data: null }));
        return { gameId: idOf(header), revision: header[7], dol, kind: 'image', make: () => new ImageDisc(header, fst, files, img) as unknown as VirtualDisc };
    }
    // an extracted folder: <root>/files/... and <root>/sys/{main.dol, boot.bin, fst.bin}
    const disc = new Map<string, { path: string; file: Blob }>(), sys = new Map<string, Blob>();
    for (const f of src.folder) {
        const parts = f.path.split('/').filter(Boolean), at = parts.indexOf('files'), name = parts[parts.length - 1].toLowerCase();
        if (at >= 0 && at < parts.length - 1) { const p = parts.slice(at + 1).join('/'); disc.set(p.toLowerCase(), { path: p, file: f.file }); }
        else if (parts.includes('sys') || name === 'main.dol') sys.set(name, f.file);
    }
    const dolFile = sys.get('main.dol');
    if (!dolFile) throw new Error("the folder has no sys/main.dol (the game's program): pick the folder that holds both files and sys, as Dolphin extracts a whole disc");
    if (!disc.size) throw new Error('the folder has no files folder with the disc\'s files in it');
    const dol = readBlob(dolFile, 0, dolFile.size);
    const boot = sys.get('boot.bin'), fstFile = sys.get('fst.bin');
    if (boot && fstFile && boot.size >= 0x440) {
        const header = readBlob(boot, 0, 0x440), fst = readBlob(fstFile, 0, fstFile.size);
        const files: Entry[] = parseFst(fst).map((f) => { const have = disc.get(f.path.toLowerCase()); return { ...f, blob: have ? have.file : null, at: 0, data: null }; });
        return { gameId: idOf(header), revision: header[7], dol, kind: 'folder with its file table', make: () => new ImageDisc(header, fst, files, null) as unknown as VirtualDisc };
    }
    // no table: one made from the files (ppc/disc.ts)
    const head = boot && boot.size >= 8 ? readBlob(boot, 0, 8) : null;
    const gameId = head ? idOf(head) : '', revision = head ? head[7] : 0;
    const cache = new Map<string, Uint8Array>();
    const list: DiscFile[] = [...disc.values()].map(({ path, file }) => ({
        path, size: file.size,
        load: () => { let d = cache.get(path); if (!d) { d = readBlob(file, 0, file.size); cache.set(path, d); } return d; },
    }));
    return { gameId, revision, dol, kind: 'folder', make: () => new VirtualDisc(gameId || 'GMSJ01', revision, list) };
}
