// glTF binary writer (tools/dae_to_glb.py GlbWriter): accessors and buffer views in the order the
// builders add them, images queued and encoded (PNG with alpha, else JPEG) when the file is written.
import { contentHash, sortedJson } from './bin.js';
import type { Image } from './gxtex.js';

/** Encodes an RGBA image, downscaled to fit maxSide (PIL's thumbnail), as PNG (alpha) or JPEG (quality 85). */
export type ImageEncoder = (img: Image, alpha: boolean, maxSide: number) => Promise<{ bytes: Uint8Array; mime: string }>;
let encoder: ImageEncoder | null = null;
export function setImageEncoder(e: ImageEncoder) { encoder = e; }

export type Arr = Float32Array | Uint8Array | Uint16Array | Uint32Array;
type View = { data: Uint8Array | null; image?: { img: Image; alpha: boolean }; target?: number; out?: any };

export class GlbWriter {
    gltf: any = {
        asset: { version: '2.0', generator: 'sms ghost viewer dae_to_glb' }, extensionsUsed: ['KHR_materials_unlit'],
        scenes: [{ nodes: [] }], scene: 0, nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], textures: [], images: [],
        samplers: [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }],
    };
    private views: View[] = [];
    texCache = new Map<string, any>();
    matCache = new Map<string, number>();
    constructor(public maxTex: number) { }

    view(data: Uint8Array | null, target?: number, image?: View['image']) {
        const bv: any = { buffer: 0, byteOffset: 0, byteLength: data ? data.length : 0 };
        if (target) bv.target = target;
        this.gltf.bufferViews.push(bv);
        this.views.push({ data, image, out: bv });
        return this.gltf.bufferViews.length - 1;
    }
    /** arr: flat data; comps: components per element (kind) */
    accessor(arr: Arr, kind: string, ctype: number, target: number | null, minmax = false, normalized = false) {
        const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[kind];
        const bytes = new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
        const acc: any = { bufferView: this.view(bytes, target || undefined), componentType: ctype, count: arr.length / comps, type: kind };
        if (normalized) acc.normalized = true;
        if (minmax) {
            const mn = new Array(comps).fill(Infinity), mx = new Array(comps).fill(-Infinity);
            for (let i = 0; i < arr.length; i++) { const c = i % comps; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
            acc.min = mn; acc.max = mx;
        }
        this.gltf.accessors.push(acc);
        return this.gltf.accessors.length - 1;
    }
    /** texture_rgba: a decoded image with its wrap modes -> [texture index, has alpha] */
    textureRgba(key: string, rgba: Image | null, wrapS = 10497, wrapT = 10497): [number, boolean] | null {
        const ck = `rgba|${key}|${wrapS}|${wrapT}`;
        if (this.texCache.has(ck)) return this.texCache.get(ck);
        if (!rgba) return null;
        let alpha = false;
        for (let i = 3; i < rgba.d.length; i += 4) if (rgba.d[i] < 250) { alpha = true; break; }
        const ik = `img|${key}`;
        let imageIndex: number;
        if (this.texCache.has(ik)) imageIndex = this.texCache.get(ik);
        else {
            this.gltf.images.push({ bufferView: this.view(null, undefined, { img: rgba, alpha }), mimeType: alpha ? 'image/png' : 'image/jpeg' });
            imageIndex = this.gltf.images.length - 1;
            this.texCache.set(ik, imageIndex);
        }
        const sampler = { wrapS, wrapT, magFilter: 9729, minFilter: 9987 };
        let si = this.gltf.samplers.findIndex((s: any) => s.wrapS === wrapS && s.wrapT === wrapT && s.magFilter === 9729 && s.minFilter === 9987);
        if (si < 0) { this.gltf.samplers.push(sampler); si = this.gltf.samplers.length - 1; }
        this.gltf.textures.push({ source: imageIndex, sampler: si });
        const r: [number, boolean] = [this.gltf.textures.length - 1, alpha];
        this.texCache.set(ck, r);
        return r;
    }
    customMaterial(spec: any) {
        const key = 'custom|' + sortedJson(spec);
        if (!this.matCache.has(key)) { this.gltf.materials.push(spec); this.matCache.set(key, this.gltf.materials.length - 1); }
        return this.matCache.get(key)!;
    }
    /** add_arrays: a mesh from flat per-vertex arrays (positions n*3, UVs n*2, RGBA8 colours n*4, normals n*3) */
    addArrays(name: string, pos: ArrayLike<number>, tris: ArrayLike<number>, mat: number, uv: ArrayLike<number> | null = null,
        color: ArrayLike<number> | null = null, normal: ArrayLike<number> | null = null, extra: Map<string, ArrayLike<number>> | null = null) {
        const n = pos.length / 3;
        const attrs: any = { POSITION: this.accessor(Float32Array.from(pos), 'VEC3', 5126, 34962, true) };
        if (normal) attrs.NORMAL = this.accessor(Float32Array.from(normal), 'VEC3', 5126, 34962);
        if (uv) attrs.TEXCOORD_0 = this.accessor(Float32Array.from(uv), 'VEC2', 5126, 34962);
        if (extra) for (const [k, v] of extra) attrs[k] = this.accessor(Float32Array.from(v), 'VEC2', 5126, 34962);
        if (color) attrs.COLOR_0 = this.accessor(Uint8Array.from(color), 'VEC4', 5121, 34962, false, true);
        const big = n > 65535;
        const idx = big ? Uint32Array.from(tris) : Uint16Array.from(tris);
        const prim = { attributes: attrs, indices: this.accessor(idx, 'SCALAR', big ? 5125 : 5123, 34963), material: mat };
        this.gltf.meshes.push({ name, primitives: [prim] });
        this.gltf.nodes.push({ name, mesh: this.gltf.meshes.length - 1 });
        this.gltf.scenes[0].nodes.push(this.gltf.nodes.length - 1);
    }
    async write(): Promise<Uint8Array> {
        if (!encoder) throw new Error('no image encoder');
        for (const v of this.views) if (v.image) { const e = await encoder(v.image.img, v.image.alpha, this.maxTex); v.data = e.bytes; }
        for (const k of ['textures', 'images']) if (!this.gltf[k].length) delete this.gltf[k];
        let len = 0;
        for (const v of this.views) { while (len % 4) len++; v.out.byteOffset = len; v.out.byteLength = v.data!.length; len += v.data!.length; }
        while (len % 4) len++;
        const bin = new Uint8Array(len);
        for (const v of this.views) bin.set(v.data!, v.out.byteOffset);
        this.gltf.buffers = [{ byteLength: len }];
        let js = new TextEncoder().encode(JSON.stringify(this.gltf));
        const pad = (4 - (js.length % 4)) % 4;
        if (pad) { const j2 = new Uint8Array(js.length + pad).fill(0x20); j2.set(js); js = j2; }
        const total = 12 + 8 + js.length + 8 + len, out = new Uint8Array(total), d = new DataView(out.buffer);
        out.set([0x67, 0x6c, 0x54, 0x46]); d.setUint32(4, 2, true); d.setUint32(8, total, true);
        d.setUint32(12, js.length, true); out.set([0x4a, 0x53, 0x4f, 0x4e], 16); out.set(js, 20);
        const b0 = 20 + js.length;
        d.setUint32(b0, len, true); out.set([0x42, 0x49, 0x4e, 0], b0 + 4); out.set(bin, b0 + 8);
        return out;
    }
}
export { contentHash };
