// The converters' output kept in the browser (IndexedDB) between visits, so a map built once loads
// from storage the next time. Keyed by the disc (game ID, revision), the converters' source
// (V1DATA_VERSION, a hash build.mjs makes of src/v1data) and the file's path; storage that is
// unavailable or full just means building again.
declare const V1DATA_VERSION: string;

const DB = 'ghostViewer.v1data', STORE = 'files';
let dbP: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
    if (dbP) return dbP;
    return dbP = new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch { resolve(null); }
    });
}
const version = typeof V1DATA_VERSION === 'string' ? V1DATA_VERSION : 'dev';

export function storeKey(disc: string, path: string) { return `${version}|${disc}|${path}`; }

export async function storeGet(key: string): Promise<any> {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
        try {
            const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(undefined);
        } catch { resolve(undefined); }
    });
}

export async function storePut(key: string, value: any): Promise<void> {
    const d = await db();
    if (!d) return;
    try {
        const tx = d.transaction(STORE, 'readwrite'), s = tx.objectStore(STORE);
        s.put(value, key);
        // entries of other builds of the converters or other discs' revisions are dropped once
        const c = s.openKeyCursor();
        c.onsuccess = () => { const k = c.result; if (!k) return; if (!String(k.key).startsWith(version + '|')) s.delete(k.key); k.continue(); };
    } catch { }
}
