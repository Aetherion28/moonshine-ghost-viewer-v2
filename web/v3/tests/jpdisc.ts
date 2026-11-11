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
/**
 * The disc and DOL of a version for the Node tests. JP 1.0: as above. PAL: the workspace's PAL files (PAL_FILES: a
 * folder with the disc's files; PAL_SCENES: its data/scene, kept apart here). DISC and DOL override both.
 */
const PAL_FILES = process.env.PAL_FILES || '/mnt/user-data/uploads/Games/_ghostviewer_extract/palmini/files';
const PAL_SCENES = process.env.PAL_SCENES || '/tmp/claude-0/palscene/data/scene';
const DOLS = process.env.DOLS || '/mnt/user-data/uploads/ghosts/dols';
export function discOf(key: string): { dol: string; disc: () => VirtualDisc } {
    if (key === 'JP10') return { dol: JP_DOL, disc: () => jpDisc() };
    const dol = process.env.DOL || `${DOLS}/${{ JP11: 'GMSJ01_01', US: 'GMSE01', PAL: 'GMSP01', PAL_3DAS: 'GMSP01_NX' }[key]}.dol`;
    if (process.env.DISC) return { dol, disc: () => jpDisc() };
    if (key !== 'PAL') throw new Error(`no disc files here for ${key}: give DISC=<image or extracted folder>`);
    return {
        dol, disc: () => {
            const files = new Map<string, DiscFile>();
            const add = (fsPath: string, discPath: string) => {
                const st = statSync(fsPath);
                if (st.isDirectory()) { for (const n of readdirSync(fsPath)) add(fsPath + '/' + n, discPath ? discPath + '/' + n : n); return; }
                files.set(discPath.toLowerCase(), { path: discPath, size: st.size, load: () => { const b = readFileSync(fsPath); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } });
            };
            add(PAL_FILES, ''); add(PAL_SCENES, 'data/scene');
            return new VirtualDisc('GMSP01', 0, [...files.values()]);
        },
    };
}
export function loadBytes(path: string) { const b = readFileSync(path); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
