// A stage's model (tools/build_stage.py): map/map/map.bmd, the sea surface, the see-through water body
// and the sky dome, in game units, with the material data v1's renderer and logic read.
import { Bytes, pyRound, contentHash } from './bin.js';
import { GlbWriter } from './glb.js';
import * as bmd from './bmd.js';
import { parseBtk } from './anim.js';
import { unlit, uvFor, materialFor, gxTevSpec, gxTevUvs, animsByMat } from './gxmat.js';

const WATER_ALPHA = 0.05;
const eq = (a: number[] | undefined, b: number[]) => !!a && b.every((v, i) => a[i] === v);
const isIn = (v: number, list: number[]) => list.includes(v);

export function addModel(w: GlbWriter, model: bmd.Model, prefix: string, kind = 'map', anim: any | null = null): number {
    const anims = animsByMat(anim);
    let tris = 0;
    const seen = new Set<string>();
    for (const mesh of model.meshes) {
        const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
        const dup = (mat ? mat.name.replace(/\(\d+\)$/, '') : '') + '|' + contentHash(mesh.pos);
        if (seen.has(dup)) continue;
        seen.add(dup);
        const name = `${prefix}_${mat ? mat.name : 'shape'}${mesh.shape}`;
        let color: Uint8Array | null = mesh.color || null;
        if (kind === 'water') {
            const wm = w.customMaterial(unlit('water', null, { alphaMode: 'BLEND' }, [0.13, 0.47, 0.62, WATER_ALPHA]));
            w.addArrays(name, mesh.pos, mesh.tris, wm);
            tris += mesh.tris.length / 3;
            continue;
        }
        if (kind === 'map' && mat && mat.lit && mesh.nrm) {
            const [mi, entry] = materialFor(w, model, mat, prefix, false, true);
            const luv = entry ? uvFor(mesh, entry) : null;
            const lcol = mat.useVertexColor ? color : null;
            w.addArrays(name, mesh.pos, mesh.tris, mi, luv, lcol, mesh.nrm, gxTevUvs(mesh, mat));
            tris += mesh.tris.length / 3;
            continue;
        }
        let tex: [number, boolean] | null = null, uv: Float32Array | null = null, alpha: any = null, factor = [1, 1, 1, 1];
        if (mat) {
            if (mat.base) { const t = model.textures[mat.base[0]]; tex = w.textureRgba(`${prefix}:${t[0]}`, t[1], t[2], t[3]); uv = uvFor(mesh, mat.base); }
            if (!mat.useVertexColor || !color) { factor = mat.matColor.map((c) => c / 255); color = null; }
            if (mat.alphaRef !== null) alpha = { alphaMode: 'MASK', alphaCutoff: pyRound(mat.alphaRef, 3) };
            else if (mat.translucent || mat.blend) alpha = { alphaMode: 'BLEND' };
        }
        let skyMul: bmd.TexEntry | null = null, skyTev: any = null, glowExtra = false;
        const stAll = mat && mat.tev ? mat.tev.stages : [];
        if (kind === 'map' && mat) {
            const st0 = stAll[0] || ({} as any);
            if (eq(st0.c, [15, 15, 15, 2]) && mat.translucent && eq(mat.blendMode, [1, 2]) && isIn(mat.blendMode[2], [1, 4])) {
                const c0 = mat.tev!.regs[0], a0 = mat.blendMode[2] === 4 ? c0[3] / 255 : 1;
                factor = [...c0.slice(0, 3).map((c) => (Math.max(0, Math.min(255, c)) / 255) ** 2 * a0), 1];
                tex = null; alpha = { alphaMode: 'BLEND' }; glowExtra = true;
            } else if (eq(st0.c, [15, 15, 15, 2]) && !mat.translucent) {
                const c0 = mat.tev!.regs[0], a0 = eq(st0.a, [7, 7, 7, 1]) ? c0[3] / 255 : 1;
                factor = [...c0.slice(0, 3).map((c) => Math.max(0, Math.min(255, c)) / 255), a0];
                color = null; tex = null;
                alpha = a0 < 0.99 ? { alphaMode: 'BLEND' } : null;
            }
        }
        let st: bmd.TevStage[] = [];
        if (kind === 'sky') {
            alpha = null;
            st = stAll;
            if (st.length && eq(st[0].c, [15, 8, 2, 15])) { factor = [...mat!.tev!.regs[0].slice(0, 3).map((c) => c / 255), 1]; color = null; }
            if (st.length > 1 && (eq(st[1].c, [15, 0, 8, 15]) || eq(st[1].c, [15, 8, 0, 15])) && mat!.layer) skyMul = mat!.layer;
            if (st.length === 2 && eq(st[0].c, [2, 15, 8, 10]) && eq(st[1].c, [15, 8, 4, 0, 1])) {
                const regs = mat!.tev!.regs;
                skyTev = { c0: regs[0].slice(0, 3).map((c) => pyRound(Math.max(0, Math.min(255, c)) / 255, 4)), c1: regs[1].slice(0, 3).map((c) => pyRound(Math.max(0, Math.min(255, c)) / 255, 4)) };
                factor = [1, 1, 1, 1];
            }
        }
        let baseColor = color;
        if (color && mat && mat.layer) { baseColor = Uint8Array.from(color); for (let i = 3; i < baseColor.length; i += 4) baseColor[i] = 255; }
        let extras: any = glowExtra ? { additive: true } : null;
        if (kind === 'map' && mat && mat.translucent && eq(mat.blendMode, [1, 4, 1])) {
            extras = { additive: true };
            const s1 = stAll;
            if (s1.length === 1 && eq(s1[0].c, [15, 15, 15, 14]) && s1[0].kc >= 12 && s1[0].kc <= 15) {
                const k = mat.tev!.kregs[s1[0].kc - 12];
                factor = [...k.slice(0, 3).map((c) => c / 255), 1];
                color = baseColor = null;
                if (mat.base) {
                    const t = model.textures[mat.base[0]];
                    if (t[1]) { const rgba = { w: t[1].w, h: t[1].h, d: Uint8Array.from(t[1].d) }; for (let i = 0; i < rgba.d.length; i += 4) rgba.d[i] = rgba.d[i + 1] = rgba.d[i + 2] = 255; tex = w.textureRgba(`${prefix}:${t[0]}:alpha`, rgba, t[2], t[3]); }
                }
            }
            alpha = { alphaMode: 'BLEND' };
        }
        let gxTev: any = null;
        const plainTev = stAll.length === 1 && eq(stAll[0].c, [15, 8, 10, 15]) && eq(stAll[0].a, [7, 4, 5, 7]);
        if (kind === 'map' && mat && mat.translucent && mat.blendMode[0] === 1 && !eq(mat.blendMode.slice(1, 3), [4, 1]) && !glowExtra
            && (!eq(mat.blendMode.slice(1, 3), [4, 5]) || !plainTev)) {
            const baseNo = mat.base ? mat.base[0] : null;
            if (stAll.length && stAll.every((x) => x.texmap === -1 || x.texmap === baseNo)) {
                gxTev = { st: stAll.map((x) => [...x.c.slice(0, 8), ...x.a.slice(0, 8), x.c[8], x.a[8], x.kc, x.ka, x.texmap >= 0 ? 1 : 0]),
                    regs: mat.tev!.regs.map((r) => r.map((c) => Math.max(-1024, Math.min(1023, c)) / 255)), k: mat.tev!.kregs.map((r) => r.map((c) => c / 255)),
                    blend: mat.blendMode.slice(0, 3), aref: mat.alphaRef || 0 };
                factor = !mat.useVertexColor || !color ? mat.matColor.map((c) => c / 255) : [1, 1, 1, 1];
                alpha = { alphaMode: 'BLEND' };
            }
        }
        let fullTev: any = null;
        if (kind === 'map' && mat && !glowExtra && stAll.length) {
            fullTev = gxTevSpec(w, model, mat, anims);
            if (fullTev) {
                gxTev = null;
                fullTev.map = 1;
                const vtxUsed = (mat.gx?.chans || []).some((c: number[] | null) => c && (c[1] === 1 || c[5] === 1));
                color = vtxUsed ? mesh.color || null : null;
                baseColor = color;
                alpha = mat.translucent ? { alphaMode: 'BLEND' } : null;
            }
        }
        const um = unlit(`${prefix} ${mat ? mat.name : ''}`, tex ? tex[0] : null, alpha, factor);
        if (kind === 'map' && mat && (mat.cull === 1 || mat.cull === 2)) extras = { ...(extras || {}), cull: mat.cull };
        if (gxTev) extras = { ...(extras || {}), gxTev };
        if (fullTev) extras = { ...(extras || {}), gxTev: fullTev };
        if (kind === 'sky' && mat) { extras = { ...(extras || {}), gxBlend: mat.blendMode.slice(0, 3) }; if (skyTev) extras.skyTev = skyTev; }
        if (extras) um.extras = extras;
        const mi = w.customMaterial(um);
        if (fullTev) {
            const litAny = (mat!.gx?.chans || []).some((c: number[] | null) => c && c[0]);
            const nrmNeeded = litAny || (mat!.gx?.texgens || []).some((g: number[] | null) => g && g[1] === 1);
            w.addArrays(name, mesh.pos, mesh.tris, mi, null, baseColor, nrmNeeded ? mesh.nrm || null : null, gxTevUvs(mesh, mat, anims));
            tris += mesh.tris.length / 3;
            continue;
        }
        w.addArrays(name, mesh.pos, mesh.tris, mi, tex ? uv : null, baseColor);
        tris += mesh.tris.length / 3;
        if (skyMul) {
            const t = model.textures[skyMul[0]];
            const mtex = w.textureRgba(`${prefix}:${t[0]}`, t[1], t[2], t[3]);
            const muv = uvFor(mesh, skyMul);
            if (mtex && muv) {
                const mm = unlit(`skymul ${prefix} ${mat!.name}`, mtex[0], { alphaMode: 'BLEND' });
                mm.extras = { multiply: true, scale: [1, 2, 4, 0.5][st[1].c[6]] };
                w.addArrays(name + '_mul', mesh.pos, mesh.tris, w.customMaterial(mm), muv, null);
                tris += mesh.tris.length / 3;
            }
        }
        if (mat && mat.layer && color) {
            const t = model.textures[mat.layer[0]];
            const ltex = w.textureRgba(`${prefix}:${t[0]}`, t[1], t[2], t[3]);
            const luv = uvFor(mesh, mat.layer);
            if (ltex && luv) {
                const lm = w.customMaterial(unlit(`layer2 ${prefix} ${mat.name}`, ltex[0], { alphaMode: 'BLEND' }));
                w.addArrays(name + '_layer2', mesh.pos, mesh.tris, lm, luv, color);
                tris += mesh.tris.length / 3;
            }
        }
    }
    return tris;
}

/** build(scene archive files) -> the stage's .glb */
export async function buildStage(arc: Map<string, Bytes>, maxTex = 512, sky = true): Promise<Uint8Array> {
    const w = new GlbWriter(maxTex);
    const animFor = (path: string) => { try { return arc.has(path) ? parseBtk(arc.get(path)!) : null; } catch { return null; } };
    addModel(w, bmd.parse(arc.get('map/map/map.bmd')!), 'map', 'map', animFor('map/map/map.btk'));
    if (arc.has('map/map/sea.bmd')) addModel(w, bmd.parse(arc.get('map/map/sea.bmd')!), 'sea', 'map', animFor('map/map/sea.btk'));
    if (arc.has('map/map/seaindirect.bmd')) addModel(w, bmd.parse(arc.get('map/map/seaindirect.bmd')!, { decodeTextures: false }), 'sea', 'water');
    if (sky && arc.has('map/map/sky.bmd')) addModel(w, bmd.parse(arc.get('map/map/sky.bmd')!, { bmt: arc.get('map/map/sky.bmt') || null }), 'sky', 'sky');
    return w.write();
}
