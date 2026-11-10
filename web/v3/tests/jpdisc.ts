// The JP disc for the Node tests, from the user's extracted files (the layout the workspace keeps them in:
// data/ is the disc's data folder; jp/ holds the JP disc's AudioRes and a few data files).
// With DISC=<disc image or Dolphin-extracted folder> the disc is that one instead, with its own file table
// (then no FSTPAD is needed: the padding is the difference between the table made here and the disc's).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { VirtualDisc, DiscFile } from '../ppc/disc.ts';
import { openDisc, type OpenedDisc } from '../web/discs.ts';
import { source } from './nodedisc.ts';

export const EXTRACT = process.env.EXTRACT || '/mnt/user-data/uploads/Games/_ghostviewer_extract';
export const JP_DOL = process.env.DOL || '/mnt/user-data/uploads/ghosts/_main_jp.dol';

let opened: OpenedDisc | null = null;
export function jpDisc(root = EXTRACT): VirtualDisc {
    if (process.env.DISC) { if (!opened) opened = openDisc(source(process.env.DISC)); return opened.make(); }
    const files: DiscFile[] = [];
    const add = (fsPath: string, discPath: string) => {
        const st = statSync(fsPath);
        if (st.isDirectory()) { for (const n of readdirSync(fsPath)) add(fsPath + '/' + n, discPath + '/' + n); return; }
        files.push({ path: discPath.replace(/^\//, ''), size: st.size, load: () => { const b = readFileSync(fsPath); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } });
    };
    add(root + '/data', 'data');
    add(root + '/jp/AudioRes', 'AudioRes');
    add(root + '/jp/PerformLists.bin', 'data/PerformLists.bin');
    add(root + '/jp/scenecmn.bin', 'data/scenecmn.bin');
    add(root + '/jp/data/nintendo.szs', 'data/nintendo.szs');
    return new VirtualDisc('GMSJ01', 0, files);
}
export function loadBytes(path: string) { const b = readFileSync(path); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
