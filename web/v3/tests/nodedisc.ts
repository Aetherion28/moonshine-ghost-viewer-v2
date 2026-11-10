// A disc for the Node tests as the browser gets it: a plain disc image (.iso / .gcm) or a folder Dolphin
// extracted (files/ and sys/), read on demand (web/discs.ts's Bytes).
import { openSync, readSync, fstatSync, readdirSync, statSync } from 'node:fs';
import type { Bytes, DiscBytes } from '../web/discs.ts';

export function fileBytes(path: string): Bytes {
    const fd = openSync(path, 'r'), size = fstatSync(fd).size;
    return { size, read: (off, len) => { const n = Math.max(0, Math.min(len, size - off)), b = new Uint8Array(n); let done = 0; while (done < n) { const r = readSync(fd, b, done, n - done, off + done); if (r <= 0) break; done += r; } return done === n ? b : b.subarray(0, done); } };
}
export function source(path: string): DiscBytes {
    if (!statSync(path).isDirectory()) return { iso: fileBytes(path) };
    const folder: { path: string; file: Bytes }[] = [];
    const walk = (dir: string, rel: string) => { for (const n of readdirSync(dir)) { const p = dir + '/' + n; if (statSync(p).isDirectory()) walk(p, rel + n + '/'); else folder.push({ path: rel + n, file: fileBytes(p) }); } };
    walk(path, '');
    return { folder };
}
