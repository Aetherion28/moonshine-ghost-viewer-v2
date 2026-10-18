// The game's stage table, /data/stageArc.bin: for each area ID (what Moonshine records as a
// route's area), the scene archive of each episode. A JDrama NameRef tree: each object is
// [u32 size][u16 hash][u16 len][type][u16 hash][u16 len][name] then its payload; groups carry a
// u32 child count then their children, a ScenarioArchiveName one [u16 len][string].

export function parseStageArc(buf: ArrayBuffer): string[][] {
    const v = new DataView(buf), b = new Uint8Array(buf), dec = new TextDecoder('shift_jis');
    const str = (o: number): [string, number] => { const n = v.getUint16(o + 2); return [dec.decode(b.subarray(o + 4, o + 4 + n)), o + 4 + n]; };
    type Node = { type: string, value?: string, children: Node[] };
    const obj = (o: number): [Node, number] => {
        const size = v.getUint32(o);
        const [type, p0] = str(o + 4);
        const [, p1] = str(p0);
        if (type === 'ScenarioArchiveName') {
            const n = v.getUint16(p1);
            return [{ type, value: dec.decode(b.subarray(p1 + 2, p1 + 2 + n)), children: [] }, o + size];
        }
        const count = v.getUint32(p1);
        let p = p1 + 4;
        const children: Node[] = [];
        for (let i = 0; i < count; i++) { const [c, e] = obj(p); children.push(c); p = e; }
        return [{ type, children }, o + size];
    };
    const [root] = obj(0);
    return root.children[0].children.map((t) => t.children.map((c) => (c.value || '').replace(/\.arc$/, '')));
}

/** The scene for a route, as the game picks it: the area's table, the episode's entry. */
export function sceneForRoute(table: string[][], area: number, episode: number): string | null {
    const eps = table[area];
    if (!eps || !eps.length) return null;
    const s = eps[episode] ?? eps[0];
    return s && s !== 'none' ? s : null;
}
