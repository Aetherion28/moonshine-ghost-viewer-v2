// v3, the page's GPU: from the registers to a shader. The texture environment's stages, the colour channels, the
// texture coordinate generators, the indirect stages, the alpha test, the fog's kind and the constant alpha, as
// the registers hold them at a draw, are put into noclip's description of a GX material; its generator
// (gx_material.ts, GX_Program) writes the GLSL. One program is made per distinct description and kept.
//
// What changes without a new program (colours, matrices, lights, the fog's numbers, the alpha test's references,
// the textures' sizes) goes into the generator's uniform blocks, which this file fills straight from the registers.

import * as GX from '../../../noclip/gx/gx_enum.js';
import { ColorChannelControl, GXMaterial, GX_Program, IndTexStage, LightChannelControl, SwapTable, TevStage, TexGen } from '../../../noclip/gx/gx_material.js';
import { GfxClipSpaceNearZ, GfxPlatform, GfxVendorInfo, GfxViewportOrigin } from '../../../noclip/gfx/platform/GfxPlatform.js';
import { Layout } from './geometry.js';

const vendorInfo: GfxVendorInfo = { platform: GfxPlatform.WebGL2, glslVersion: '#version 300 es', explicitBindingLocations: false, separateSamplerTextures: false, viewportOrigin: GfxViewportOrigin.LowerLeft, clipSpaceNearZ: GfxClipSpaceNearZ.NegativeOne };

/** a material's program and what it needs filled in */
export interface Mat {
    id: number;
    program: WebGLProgram | null;
    /** the texture units it samples (a bit each) */
    maps: number;
    /** the size of its material block (floats) and where the optional parts start (-1: not there) */
    floats: number; post: number; lights: number; fog: number; alpha: number;
}

// the material block's fixed part: the channels' material and ambient colours, the constant colours, the
// registers' colours, ten texture matrices, eight texture sizes, eight detail biases, three indirect matrices
export const OFF_MAT = 0, OFF_AMB = 8, OFF_KONST = 16, OFF_REG = 32, OFF_TEXMTX = 48, OFF_SIZES = 168, OFF_BIAS = 184, OFF_IND = 192, FIXED = 216;

const KSEL_OK = (v: number) => v < 8 || v >= 12;
const DEFAULT_SWAP: SwapTable = [0, 1, 2, 3];

export class Materials {
    private byKey = new Map<string, Mat>();
    private key: number[] = [];
    compiled = 0;

    constructor(private gl: WebGL2RenderingContext) { }

    /**
     * The material for the registers as they are, for vertices of `layout`.
     * dstAlpha: the constant alpha (BP 0x42) is written instead of the pixel's own (-1: not).
     */
    get(bp: Uint32Array, xfw: Uint32Array, layout: Layout, dstAlpha: number): Mat {
        const K = this.key;
        K.length = 0;
        const gen = bp[0], gens = gen & 15, stages = ((gen >>> 10) & 15) + 1, inds = (gen >>> 16) & 7, chans = Math.min(xfw[0x1009] & 3, 2);
        K.push(gens, stages, inds, chans, layout.texIdx, layout.hasClr, dstAlpha, bp[0xF3] >>> 16, (bp[0xF1] >>> 20) & 15);
        for (let i = 0; i < stages; i++) {
            const sh = (i & 1) * 12;
            K.push((bp[0x28 + (i >> 1)] >>> sh) & 0xFFF, bp[0xC0 + 2 * i], bp[0xC1 + 2 * i], (bp[0xF6 + (i >> 1)] >>> ((i & 1) ? 14 : 4)) & 0x3FF, inds ? bp[0x10 + i] : 0);
        }
        for (let i = 0; i < 8; i++) K.push(bp[0xF6 + i] & 15);
        for (let i = 0; i < inds; i++) K.push((bp[0x27] >>> (6 * i)) & 63, (bp[0x25 + (i >> 1)] >>> (8 * (i & 1))) & 0xFF);
        const dual = xfw[0x1012] & 1;
        for (let i = 0; i < gens; i++) K.push(xfw[0x1040 + i], dual ? xfw[0x1050 + i] & 0x13F : 0, texMtxIndex(xfw, i));
        for (let i = 0; i < chans; i++) K.push(xfw[0x100E + i] & 0x7FFF, xfw[0x1010 + i] & 0x7FFF);
        const key = K.join(',');
        let m = this.byKey.get(key);
        if (!m) { m = this.make(bp, xfw, layout, dstAlpha); this.byKey.set(key, m); }
        return m;
    }

    private make(bp: Uint32Array, xfw: Uint32Array, layout: Layout, dstAlpha: number): Mat {
        const material = describe(bp, xfw, layout, dstAlpha);
        const m: Mat = { id: this.byKey.size + 1, program: null, maps: 0, floats: FIXED, post: -1, lights: -1, fog: -1, alpha: -1 };
        if (material.hasPostTexMtxBlock) { m.post = m.floats; m.floats += 240; }
        if (material.hasLightsBlock) { m.lights = m.floats; m.floats += 160; }
        if (material.hasFogBlock) { m.fog = m.floats; m.floats += 20; }
        m.alpha = m.floats; m.floats += 4;
        for (const s of material.tevStages) if (s.texMap !== GX.TexMapID.TEXMAP_NULL) m.maps |= 1 << s.texMap;
        for (const s of material.indTexStages) m.maps |= 1 << s.texture;
        const gl = this.gl;
        try {
            const src = new GX_Program(material);
            src.ensurePreprocessed(vendorInfo);
            const sh = (type: number, text: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, text); gl.compileShader(s); return s; };
            const p = gl.createProgram()!, vs = sh(gl.VERTEX_SHADER, src.preprocessedVert), fs = sh(gl.FRAGMENT_SHADER, src.preprocessedFrag);
            gl.attachShader(p, vs); gl.attachShader(p, fs);
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
                console.error('[gx] a material that does not compile: ' + (gl.getShaderInfoLog(vs) || '') + (gl.getShaderInfoLog(fs) || '') + (gl.getProgramInfoLog(p) || ''));
                gl.deleteProgram(p);
            } else {
                const blocks = ['ub_SceneParams', 'ub_MaterialParams', 'ub_DrawParams'];
                for (let i = 0; i < 3; i++) { const at = gl.getUniformBlockIndex(p, blocks[i]); if (at !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, at, i); }
                gl.useProgram(p);
                for (let i = 0; i < 8; i++) { const loc = gl.getUniformLocation(p, `u_Texture${i}`); if (loc) gl.uniform1i(loc, i); }
                m.program = p;
            }
            gl.deleteShader(vs); gl.deleteShader(fs);
        } catch (e) { console.error('[gx] a material the generator refuses: ' + e); }
        this.compiled++;
        return m;
    }

    destroy() {
        for (const m of this.byKey.values()) if (m.program) this.gl.deleteProgram(m.program);
        this.byKey.clear();
    }
}

/** the matrix a texture coordinate generator takes (its row in the transform unit's matrix memory, from 0x1018 / 0x1019) */
export function texMtxIndex(xfw: Uint32Array, i: number): number {
    return i < 4 ? (xfw[0x1018] >>> (6 + 6 * i)) & 63 : (xfw[0x1019] >>> (6 * (i - 4))) & 63;
}

function channel(v: number): ColorChannelControl {
    const attn = (v >>> 9) & 1, spot = (v >>> 10) & 1;
    return {
        lightingEnabled: !!(v & 2), matColorSource: v & 1, ambColorSource: (v >>> 6) & 1,
        litMask: ((v >>> 2) & 15) | (((v >>> 11) & 15) << 4), diffuseFunction: Math.min((v >>> 7) & 3, 2),
        attenuationFunction: attn ? (spot ? GX.AttenuationFunction.SPOT : GX.AttenuationFunction.SPEC) : GX.AttenuationFunction.NONE,
    };
}
const UNLIT_VERTEX: ColorChannelControl = { lightingEnabled: false, matColorSource: GX.ColorSrc.VTX, ambColorSource: GX.ColorSrc.REG, litMask: 0, diffuseFunction: GX.DiffuseFunction.NONE, attenuationFunction: GX.AttenuationFunction.NONE };

/** The registers as noclip's material description. */
function describe(bp: Uint32Array, xfw: Uint32Array, layout: Layout, dstAlpha: number): GXMaterial {
    const gen = bp[0], gens = gen & 15, stages = ((gen >>> 10) & 15) + 1, chans = Math.min(xfw[0x1009] & 3, 2);
    let inds = (gen >>> 16) & 7;
    if (inds > 4) inds = 4;
    if (!gens) inds = 0;

    // ---- the colour channels (0x100E.. colour, 0x1010.. alpha); one the transform unit doesn't compute passes the vertex's colour on
    const lightChannels: LightChannelControl[] = [];
    let lit = false;
    for (let i = 0; i < 2; i++) {
        if (i < chans) {
            const c = channel(xfw[0x100E + i]), a = channel(xfw[0x1010 + i]);
            if ((c.lightingEnabled && c.litMask) || (a.lightingEnabled && a.litMask)) lit = true;
            lightChannels.push({ colorChannel: c, alphaChannel: a });
        } else lightChannels.push({ colorChannel: UNLIT_VERTEX, alphaChannel: UNLIT_VERTEX });
    }

    // ---- the texture coordinate generators (0x1040.., and the second transform 0x1050.. when 0x1012 turns it on)
    const texGens: TexGen[] = [], useTexMtxIdx: boolean[] = [];
    const dual = xfw[0x1012] & 1;
    let post = false, bump = false;
    const ROWS = [GX.TexGenSrc.POS, GX.TexGenSrc.NRM, GX.TexGenSrc.COLOR0, GX.TexGenSrc.BINRM, GX.TexGenSrc.TANGENT];
    for (let i = 0; i < gens; i++) {
        const v = xfw[0x1040 + i], kind = (v >>> 4) & 7, row = (v >>> 7) & 31;
        let type: GX.TexGenType, source: GX.TexGenSrc;
        if (kind === 1 && i > 0) { type = GX.TexGenType.BUMP0 + ((v >>> 15) & 7); source = GX.TexGenSrc.TEXCOORD0 + Math.min((v >>> 12) & 7, i - 1, 6); bump = true; }
        else if (kind === 2) { type = GX.TexGenType.SRTG; source = GX.TexGenSrc.COLOR0; }
        else if (kind === 3) { type = GX.TexGenType.SRTG; source = GX.TexGenSrc.COLOR1; }
        else { type = v & 2 ? GX.TexGenType.MTX3x4 : GX.TexGenType.MTX2x4; source = row < 5 ? ROWS[row] : row <= 12 ? GX.TexGenSrc.TEX0 + (row - 5) : GX.TexGenSrc.POS; }
        const ix = texMtxIndex(xfw, i);
        const matrix: GX.TexGenMatrix = ix >= 60 || ix % 3 ? GX.TexGenMatrix.IDENTITY : ix;
        let postMatrix = GX.PostTexGenMatrix.PTIDENTITY, normalize = false;
        if (dual) {
            const d = xfw[0x1050 + i], px = d & 63;
            normalize = !!(d & 0x100);
            if (px < 60 && px % 3 === 0) { postMatrix = GX.PostTexGenMatrix.PTTEXMTX0 + px; post = true; }
        }
        texGens.push({ type, source, matrix, normalize, postMatrix });
        useTexMtxIdx.push(!!(layout.texIdx & (1 << i)));
    }

    // ---- the indirect stages (0x27: each one's map and coordinate; 0x25, 0x26: the coordinate's scale)
    const indTexStages: IndTexStage[] = [];
    for (let i = 0; i < inds; i++) {
        const ref = (bp[0x27] >>> (6 * i)) & 63, ss = (bp[0x25 + (i >> 1)] >>> (8 * (i & 1))) & 0xFF;
        indTexStages.push({ texture: ref & 7, texCoordId: Math.min((ref >>> 3) & 7, gens - 1), scaleS: Math.min(ss & 15, 8), scaleT: Math.min(ss >>> 4, 8) });
    }

    // ---- the texture environment (0x28..: each stage's map, coordinate and channel; 0xC0..: its two formulas; 0xF6..: constants and swap tables; 0x10..: indirect)
    const swap: SwapTable[] = [];
    for (let t = 0; t < 4; t++) swap.push([bp[0xF6 + 2 * t] & 3, (bp[0xF6 + 2 * t] >>> 2) & 3, bp[0xF7 + 2 * t] & 3, (bp[0xF7 + 2 * t] >>> 2) & 3]);
    const op = (bias: number, scale: number, sub: number): GX.TevOp => bias === 3 ? 8 + scale * 2 + sub : sub;
    const tevStages: TevStage[] = [];
    for (let i = 0; i < stages; i++) {
        const sh = (i & 1) * 12, order = bp[0x28 + (i >> 1)] >>> sh, c = bp[0xC0 + 2 * i], a = bp[0xC1 + 2 * i];
        const ksel = bp[0xF6 + (i >> 1)], kc = ((i & 1) ? ksel >>> 14 : ksel >>> 4) & 31, ka = ((i & 1) ? ksel >>> 19 : ksel >>> 9) & 31;
        const ind = inds ? bp[0x10 + i] : 0, chan = (order >>> 7) & 7;
        const cBias = (c >>> 16) & 3, aBias = (a >>> 16) & 3;
        let indMtx: GX.IndTexMtxID = (ind >>> 9) & 15;
        if ((ind & 3) >= inds || (indMtx & 3) === 0) indMtx = GX.IndTexMtxID.OFF;
        const textured = (order & 0x40) !== 0 && (gens > 0 || indMtx !== GX.IndTexMtxID.OFF);
        tevStages.push({
            colorInA: (c >>> 12) & 15, colorInB: (c >>> 8) & 15, colorInC: (c >>> 4) & 15, colorInD: c & 15,
            colorOp: op(cBias, (c >>> 20) & 3, (c >>> 18) & 1), colorBias: cBias === 3 ? 0 : cBias, colorScale: cBias === 3 ? 0 : (c >>> 20) & 3, colorClamp: !!(c & 0x80000), colorRegId: (c >>> 22) & 3,
            alphaInA: (a >>> 13) & 7, alphaInB: (a >>> 10) & 7, alphaInC: (a >>> 7) & 7, alphaInD: (a >>> 4) & 7,
            alphaOp: op(aBias, (a >>> 20) & 3, (a >>> 18) & 1), alphaBias: aBias === 3 ? 0 : aBias, alphaScale: aBias === 3 ? 0 : (a >>> 20) & 3, alphaClamp: !!(a & 0x80000), alphaRegId: (a >>> 22) & 3,
            texCoordId: (order >>> 3) & 7, texMap: textured ? order & 7 : GX.TexMapID.TEXMAP_NULL,
            channelId: chan === 0 || chan === 1 || (chan >= 5 && inds) ? chan : GX.RasColorChannelID.COLOR_ZERO,
            konstColorSel: KSEL_OK(kc) ? kc : GX.KonstColorSel.KCSEL_1, konstAlphaSel: ka < 8 || ka >= 16 ? ka : GX.KonstAlphaSel.KASEL_1,
            rasSwapTable: swap[a & 3] ?? DEFAULT_SWAP, texSwapTable: swap[(a >>> 2) & 3] ?? DEFAULT_SWAP,
            indTexStage: ind & 3, indTexFormat: GX.IndTexFormat._8, indTexBiasSel: (ind >>> 4) & 7, indTexAlphaSel: (ind >>> 7) & 3,
            indTexMatrix: indMtx, indTexWrapS: Math.min((ind >>> 13) & 7, 6), indTexWrapT: Math.min((ind >>> 16) & 7, 6),
            indTexAddPrev: !!(ind & 0x100000) && i > 0, indTexUseOrigLOD: !!(ind & 0x80000),
        });
    }

    // ---- the alpha test (0xF3), the fog's kind (0xF1), the constant alpha
    const at = bp[0xF3], fsel = (bp[0xF1] >>> 21) & 7, ortho = (bp[0xF1] >>> 20) & 1;
    const fogType: GX.FogType = fsel === 2 || fsel >= 4 ? fsel | (ortho << 3) : GX.FogType.NONE;
    return {
        name: 'gx', cullMode: GX.CullMode.NONE, lightChannels, texGens, tevStages, indTexStages,
        alphaTest: { op: (at >>> 22) & 3, compareA: (at >>> 16) & 7, referenceA: 0, compareB: (at >>> 19) & 7, referenceB: 0 },
        ropInfo: {
            fogType, fogAdjEnabled: false, depthTest: true, depthFunc: GX.CompareType.LESS, depthWrite: true,
            blendMode: GX.BlendMode.NONE, blendSrcFactor: GX.BlendFactor.ONE, blendDstFactor: GX.BlendFactor.ZERO, blendLogicOp: GX.LogicOp.COPY,
            dstAlpha: dstAlpha >= 0 ? dstAlpha / 255 : undefined, colorUpdate: true, alphaUpdate: true,
        },
        usePnMtxIdx: true, useTexMtxIdx, hasPostTexMtxBlock: post, hasLightsBlock: lit || bump, hasFogBlock: fogType !== GX.FogType.NONE, hasDynamicAlphaTest: true,
    };
}
