// The game version being simulated: the disc's (GMSJ01 JP, GMSE01 US, GMSP01 PAL).
// PAL is a later revision of the Mario and Yoshi code: the differences are read off the PAL
// binary by the decomp (Aetherion28/SMS-AI-Decomp-PAL, VERSION_GMSP01) and are applied here
// only for a PAL disc. US has not been compared and keeps the Japanese behaviour.
export const VERSION = { id: 'GMSJ01', pal: false };
export function setGameVersion(id: string) { VERSION.id = id; VERSION.pal = id.startsWith('GMSP'); }
