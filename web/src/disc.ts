// The player's copy of the game, read in the browser: a GameCube disc image (ISO / GCM, or Dolphin's
// RVZ, WIA, GCZ and CISO through discformats.ts) or a folder extracted from one (Dolphin's "Extract
// Entire Disc"). Nothing leaves the browser.
//
// Disc layout (GameCube boot.bin / FST): game ID at 0x00, magic 0xC2339F3D at 0x1C, the file
// system table's offset and size at 0x424 / 0x428. FST entries are 12 bytes: a flags byte
// (1 = directory) and a 24-bit name offset, then for a file its data offset and length, for a
// directory its parent index and the index past its last child. Names follow the entries.

import { openSource, type DiscSource } from './discformats.js';

export interface GameFS {
    /** Game ID, e.g. GMSE01 (US), GMSJ01 (JP), GMSP01 (PAL). */
    id: string;
    /** boot.bin 0x07, the disc revision: JP 1.1 is GMSJ01 revision 1, the Korean image GMSE01 revision 48 */
    revision?: number;
    label: string;
    /** Paths are the disc's own, without a leading slash: "data/scene/dolpic0.szs". */
    has(path: string): boolean;
    read(path: string): Promise<ArrayBuffer>;
    list(): string[];
    /** part of a file (the streaming movies are read a frame at a time) */
    readRange?(path: string, off: number, len: number): Promise<ArrayBuffer>;
    /** a file's size */
    size?(path: string): number;
    /** what it was read from: ISO, RVZ, GCZ, CISO, WIA or folder (for bug reports) */
    format?: string;
}

const GC_MAGIC = 0xC2339F3D;

class DiscImage implements GameFS {
    private files = new Map<string, { off: number, len: number }>();
    public revision = 0;
    public format: string;
    constructor(private src: DiscSource, public id: string, public label: string) { this.format = src.kind; }

    static async open(blob: Blob, name: string): Promise<DiscImage> {
        const src = await openSource(blob, name);
        const head = new DataView(buffer(await src.read(0, 0x440)));
        if (head.byteLength < 0x440 || head.getUint32(0x1C) !== GC_MAGIC)
            throw new Error(`${name} isn't a GameCube disc image.`);
        const id = String.fromCharCode(...new Uint8Array(head.buffer, 0, 6));
        const fstOff = head.getUint32(0x424), fstLen = head.getUint32(0x428);
        const disc = new DiscImage(src, id, name);
        disc.revision = head.getUint8(7);
        const fst = await src.read(fstOff, fstLen);
        if (fst.length < fstLen || fstLen < 12) throw tooShort(name);
        const v = new DataView(fst.buffer, fst.byteOffset, fst.byteLength);
        const n = v.getUint32(8);
        if (n < 1 || n * 12 > fst.length) throw damagedDisc(name);
        const strings = n * 12, dec = new TextDecoder('shift_jis');
        const nameAt = (o: number) => { let e = strings + o; while (fst[e]) e++; return dec.decode(fst.subarray(strings + o, e)); };
        // Walk the tree: a directory's children run to its "next" index.
        const discName = name;
        const walk = (first: number, end: number, prefix: string, depth = 0) => {
            for (let i = first; i < end;) {
                const flags = fst[i * 12], name = nameAt(v.getUint32(i * 12) & 0xFFFFFF);
                if (flags === 1) {
                    const next = v.getUint32(i * 12 + 8);
                    // (a folder ends after itself and inside its parent: anything else would loop for ever)
                    if (!(next > i && next <= end) || depth > 64) throw damagedDisc(discName);
                    walk(i + 1, next, prefix + name + '/', depth + 1);
                    i = next;
                } else {
                    disc.files.set((prefix + name).toLowerCase(), { off: v.getUint32(i * 12 + 4), len: v.getUint32(i * 12 + 8) });
                    i++;
                }
            }
        };
        walk(1, n, '');
        // A cut-off image (an interrupted copy or download) still lists every file: catch it here,
        // not when a stage fails to load.
        let end = 0;
        for (const f of disc.files.values()) end = Math.max(end, f.off + f.len);
        if (end > src.size) throw tooShort(name);
        return disc;
    }

    has(path: string) { return this.files.has(path.toLowerCase()); }
    list() { return [...this.files.keys()]; }
    async read(path: string): Promise<ArrayBuffer> {
        const f = this.files.get(path.toLowerCase());
        if (!f) throw new Error(`${path} isn't on the disc`);
        return buffer(await this.src.read(f.off, f.len));
    }
    async readRange(path: string, off: number, len: number): Promise<ArrayBuffer> {
        const f = this.files.get(path.toLowerCase());
        if (!f) throw new Error(`${path} isn't on the disc`);
        const a = f.off + Math.max(0, off), b = f.off + Math.min(f.len, off + len);
        return buffer(await this.src.read(a, Math.max(0, b - a)));
    }
    size(path: string) { const f = this.files.get(path.toLowerCase()); return f ? f.len : 0; }
}

const damagedDisc = (name: string) => new Error(`${name} has a damaged file table and can't be read.`);
const tooShort = (name: string) => new Error(`${name} is incomplete: the file ends before the disc's data does. Copy or dump it again.`);

/** The bytes as an ArrayBuffer of their own (a plain ISO read already is one: no copy). */
function buffer(u: Uint8Array): ArrayBuffer {
    return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer as ArrayBuffer : u.slice().buffer;
}

class ExtractedFolder implements GameFS {
    private files = new Map<string, File>();
    public id = '';
    public revision = 0;
    public format = 'folder';
    constructor(public label: string) { }

    static async open(list: File[]): Promise<ExtractedFolder> {
        const root = (list[0] as any).webkitRelativePath?.split('/')[0] || 'folder';
        const f = new ExtractedFolder(root);
        for (const file of list) {
            const rel: string = (file as any).webkitRelativePath || file.name;
            // Dolphin extracts to <name>/files/... and <name>/sys/...; take paths from files/, or
            // from the folder holding data/ if that's what was picked.
            const parts = rel.split('/');
            const at = parts.indexOf('files');
            const di = parts.indexOf('data');
            const tail = at >= 0 ? parts.slice(at + 1) : di >= 0 ? parts.slice(di) : null;
            if (tail && tail.length) f.files.set(tail.join('/').toLowerCase(), file);
            if (parts.includes('sys') && file.name === 'boot.bin') {
                const h = new Uint8Array(await file.slice(0, 8).arrayBuffer());
                f.id = String.fromCharCode(...h.subarray(0, 6));
                f.revision = h[7] || 0;
            }
        }
        if (!f.files.has('data/scene/dolpic0.szs'))
            throw new Error(`${root} doesn't look like an extracted Super Mario Sunshine disc (no files/data/scene).`);
        return f;
    }

    has(path: string) { return this.files.has(path.toLowerCase()); }
    list() { return [...this.files.keys()]; }
    async read(path: string): Promise<ArrayBuffer> {
        const f = this.files.get(path.toLowerCase());
        if (!f) throw new Error(`${path} isn't in the folder`);
        return f.arrayBuffer();
    }
    async readRange(path: string, off: number, len: number): Promise<ArrayBuffer> {
        const f = this.files.get(path.toLowerCase());
        if (!f) throw new Error(`${path} isn't in the folder`);
        return f.slice(Math.max(0, off), Math.min(f.size, off + len)).arrayBuffer();
    }
    size(path: string) { const f = this.files.get(path.toLowerCase()); return f ? f.size : 0; }
}

export async function openDisc(file: File): Promise<GameFS> {
    const d = await DiscImage.open(file, file.name);
    if (!d.id.startsWith('GMS'))
        throw new Error(`${file.name} is ${d.id}, not Super Mario Sunshine (GMSE01, GMSJ01 or GMSP01).`);
    if (!d.has('data/scene/dolpic0.szs')) throw new Error(`${file.name} has no Sunshine stages in it.`);
    return d;
}

export async function openFolder(files: File[]): Promise<GameFS> {
    return ExtractedFolder.open(files);
}

// Remembering the disc between visits: browsers that have the File System Access API (Chrome,
// Edge) can keep a handle to the file in IndexedDB and ask again for permission; others pick it
// each visit.
const DB = 'moonshine-ghost-viewer', STORE = 'disc';
function idb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
export async function rememberHandle(h: any): Promise<void> {
    try {
        const db = await idb();
        await new Promise<void>((res) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(h, 'iso'); t.oncomplete = () => res(); t.onerror = () => res(); });
    } catch { }
}
export async function rememberedHandle(): Promise<any | null> {
    try {
        const db = await idb();
        return await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get('iso'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    } catch { return null; }
}
export async function forgetHandle(): Promise<void> {
    try {
        const db = await idb();
        await new Promise<void>((res) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete('iso'); t.oncomplete = () => res(); t.onerror = () => res(); });
    } catch { }
}
