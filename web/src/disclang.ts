// PAL keeps some 2D archives once per language (data/game_6_en.szs, select_fr.szs, subtitle_ge.szs …)
// where the other releases have one (data/game_6.szs). The viewer draws them in the reader's language
// when the disc has it, else English. (The simulation's own text, cmn2d, stays English: runner.ts.)

const SUFFIX: Record<string, string> = { en: 'en', fr: 'fr', de: 'ge', it: 'it', es: 'sp' };

function order(): string[] {
    let langs: readonly string[] = [];
    try { langs = navigator.languages || [navigator.language]; } catch { }
    const want = langs.map((l) => SUFFIX[(l || '').slice(0, 2).toLowerCase()]).filter(Boolean);
    return [...new Set([...want, 'en', 'fr', 'ge', 'it', 'sp'])];
}

/** path, or its per-language PAL archive when the disc has no plain one. */
export function localizedPath(fs: { has(path: string): boolean }, path: string): string {
    if (fs.has(path)) return path;
    const m = /^(.*)\.szs$/i.exec(path);
    if (m) for (const s of order()) { const p = `${m[1]}_${s}.szs`; if (fs.has(p)) return p; }
    return path;
}
