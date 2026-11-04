import fs from 'node:fs';
import ArrayBufferSlice from '/home/claude/moonshine-ghost-viewer-v2/web/noclip/ArrayBufferSlice.ts';
import * as Yaz0 from '/home/claude/moonshine-ghost-viewer-v2/web/noclip/Common/Compression/Yaz0.ts';
import * as RARC from '/home/claude/moonshine-ghost-viewer-v2/web/noclip/Common/JSYSTEM/JKRArchive.ts';
import type { Files } from '/home/claude/moonshine-ghost-viewer-v2/web/src/game/engine.ts';
const D = '/mnt/user-data/uploads/Games/_ghostviewer_extract/data/';
export function arc(path: string) {
  const raw = fs.readFileSync(path);
  let b = new ArrayBufferSlice(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  if (raw.toString('latin1', 0, 4) === 'Yaz0') b = Yaz0.decompressSW(b);
  const a = RARC.parse(b);
  const files = new Map<string, Uint8Array>(), dirs = new Map<string, string[]>();
  const walk = (d: RARC.RARCDir, prefix: string) => {
    const list: string[] = [];
    for (const f of d.files) { files.set((prefix + f.name).toLowerCase(), f.buffer.createTypedArray(Uint8Array)); list.push(f.name.toLowerCase()); }
    dirs.set(prefix.replace(/\/$/, '').toLowerCase(), list);
    for (const s of d.subdirs) if (s.name !== '.' && s.name !== '..') walk(s, prefix + s.name + '/');
  };
  walk(a.root, '');
  return { files, dirs };
}
export function stageFiles(scene: string): Files & { common(p: string): Uint8Array | null } {
  // SCENEDIR: a region's own scene archives (<dir>/<scene>.szs) in place of the JP disc's
  const own = process.env.SCENEDIR ? process.env.SCENEDIR + '/' + scene + '.szs' : null;
  const s = arc(own && fs.existsSync(own) ? own : D + 'scene/' + scene + '.szs'), p = arc(D + 'params.szs'), c = arc(D + 'common.szs');
  return {
    scene: (path) => s.files.get(path.toLowerCase()) || null,
    folder: (path) => s.dirs.get(path.toLowerCase()) || [],
    params: (path) => p.files.get(path.toLowerCase()) || null,
    common: (path) => c.files.get(path.toLowerCase()) || null,
  };
}
