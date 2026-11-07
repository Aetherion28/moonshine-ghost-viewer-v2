// The sea's wave surface as the game draws it (MoveBG/MapObjWave.cpp TMapObjWave::perform's
// CUE_DRAW: initDraw, draw): triangle strips over a grid around Mario straight from the view
// matrix, vertex colour sColor with getAlpha's alpha, /scene/map/map/wave.bti sampled twice
// (the static and the moving texture positions). TEV: stage 0 alpha = tex0.a * ras.a; stage 1
// colour = ras.rgb * 2, alpha = tex1.a * prev.a * 2. Blend SRCALPHA, SRCCLR; alpha compare
// GEQUAL 0x55 OR LEQUAL 0x23; depth test LEQUAL without writes, no culling.
// The geometry is the sim's (game/mapobj/lib.ts MapObjWave.drawStrips).

import { mat4 } from 'gl-matrix';
import * as GX from '../noclip/gx/gx_enum.js';
import { TDDraw } from '../noclip/gx/DDraw.js';
import { GXMaterialBuilder } from '../noclip/gx/GXMaterialBuilder.js';
import { GXMaterialHelperGfx, MaterialParams, DrawParams, ColorKind } from '../noclip/gx/gx_render.js';
import { colorFromRGBA } from '../noclip/Color.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey } from '../noclip/gfx/render/GfxRenderInstManager.js';
import { BTIData } from '../noclip/Common/JSYSTEM/JUTTexture.js';
import * as Viewer from '../noclip/viewer.js';

/** sAlphaCompLarge, sAlphaCompSmall */
const ALPHA_LARGE = 0x55, ALPHA_SMALL = 0x23;

export class WaveDraw {
    private dd = new TDDraw('wave');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor(private tex: BTIData) {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        this.dd.setVtxDesc(GX.Attr.CLR0, true);
        this.dd.setVtxDesc(GX.Attr.TEX0, true);
        this.dd.setVtxDesc(GX.Attr.TEX1, true);
        const mb = new GXMaterialBuilder('MapObjWave');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.VTX, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD1, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX1, GX.TexGenMatrix.IDENTITY);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.TEXA, GX.CA.RASA, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevOrder(1, GX.TexCoordID.TEXCOORD1, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(1, GX.CC.RASC, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_2, true, GX.Register.PREV);
        mb.setTevAlphaIn(1, GX.CA.ZERO, GX.CA.TEXA, GX.CA.APREV, GX.CA.ZERO);
        mb.setTevAlphaOp(1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_2, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.SRCCOLOR);
        mb.setAlphaCompare(GX.CompareType.GEQUAL, ALPHA_LARGE, GX.AlphaOp.OR, GX.CompareType.LEQUAL, ALPHA_SMALL);
        mb.setZMode(true, GX.CompareType.LEQUAL, false);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    /** strips: MapObjWave.drawStrips; color: sColor (0..255) */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, strips: Float32Array[], color: number[]) {
        if (!strips.length) return;
        const d = this.dd;
        d.beginDraw(rim.gfxRenderCache);
        for (const v of strips) {
            const n = v.length / 8;
            if (n < 3) continue;
            d.begin(GX.Command.DRAW_TRIANGLE_STRIP, n);
            for (let i = 0; i < n; i++) {
                const o = i * 8;
                d.position3f32(v[o], v[o + 1], v[o + 2]);
                d.color4rgba8(GX.Attr.CLR0, color[0], color[1], color[2], Math.max(0, Math.min(255, v[o + 3] & 0xFF)));
                d.texCoord2f32(GX.Attr.TEX0, v[o + 4], v[o + 5]);
                d.texCoord2f32(GX.Attr.TEX1, v[o + 6], v[o + 7]);
            }
            d.end();
        }
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        inst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        this.tex.fillTextureMapping(this.mp.m_TextureMapping[0]);
        inst.setSamplerBindingsFromTextureMappings(this.mp.m_TextureMapping);
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    destroy(device: GfxDevice) { this.dd.destroy(device); this.tex.destroy(device); }
}

/**
 * The hanging bridge's ropes (MoveBG/MapObjMonte.cpp THangingBridge::perform's CUE_DRAW: initDraw,
 * each board's drawRopes, drawRopeBetweenBoards): triangle strips from the view matrix, the texture
 * (/scene/mapObj/mon_bri_rope.bti) as colour and alpha, blend ONE ZERO, depth LEQUAL with writes,
 * back faces culled. The geometry is the sim's (game/mapobj/monte.ts HangingBridge.ropeStrips).
 */
export class RopeDraw {
    private dd = new TDDraw('bridge ropes');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor(private tex: BTIData) {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        this.dd.setVtxDesc(GX.Attr.TEX0, true);
        const mb = new GXMaterialBuilder('HangingBridgeRope');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.REG, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR_ZERO);   // (GX_COLOR_NULL)
        mb.setTevColorIn(0, GX.CC.TEXC, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.TEXA, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
        mb.setZMode(true, GX.CompareType.LEQUAL, true);
        mb.setCullMode(GX.CullMode.BACK);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    /** strips: HangingBridge.ropeStrips ([x, y, z, s, t] per vertex) */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, strips: Float32Array[]) {
        const d = this.dd;
        if (!strips.length) return;
        d.beginDraw(rim.gfxRenderCache);
        for (const v of strips) {
            const n = v.length / 5;
            if (n < 3) continue;
            d.begin(GX.Command.DRAW_TRIANGLE_STRIP, n);
            for (let i = 0; i < n; i++) { const o = i * 5; d.position3f32(v[o], v[o + 1], v[o + 2]); d.texCoord2f32(GX.Attr.TEX0, v[o + 3], v[o + 4]); }
            d.end();
        }
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        inst.sortKey = makeSortKey(GfxRendererLayer.OPAQUE);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        this.tex.fillTextureMapping(this.mp.m_TextureMapping[0]);
        inst.setSamplerBindingsFromTextureMappings(this.mp.m_TextureMapping);
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    destroy(device: GfxDevice) { this.dd.destroy(device); this.tex.destroy(device); }
}

/**
 * The grass (MoveBG/MapObjGrass.cpp TMapObjGrassManager::perform's CUE_DRAW: draw): initDrawNear's
 * state (unlit vertex colour from color_table, TEV passing it through, blend ONE ZERO, alpha always,
 * depth LEQUAL with writes, no culling), one triangle per blade from the view matrix. The
 * geometry is the sim's (game/mapobj/view.ts MapObjGrassManager.draw: the near and the far groups).
 */
export class GrassDraw {
    private dd = new TDDraw('grass');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor() {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        this.dd.setVtxDesc(GX.Attr.CLR0, true);
        const mb = new GXMaterialBuilder('MapObjGrass');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.VTX, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(0, GX.CC.RASC, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.RASA, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.OR, GX.CompareType.ALWAYS, 0);
        mb.setZMode(true, GX.CompareType.LEQUAL, true);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    /** tris: [x, y, z, colour index] per vertex, three per blade; table: color_table */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, tris: number[], table: number[][]) {
        const n = tris.length / 4;
        if (n < 3) return;
        const d = this.dd;
        d.beginDraw(rim.gfxRenderCache);
        d.begin(GX.Command.DRAW_TRIANGLES, n);
        for (let i = 0; i < n; i++) {
            const o = i * 4, c = table[tris[o + 3]];
            d.position3f32(tris[o], tris[o + 1], tris[o + 2]);
            d.color4rgba8(GX.Attr.CLR0, c[0], c[1], c[2], c[3]);
        }
        d.end();
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        inst.sortKey = makeSortKey(GfxRendererLayer.OPAQUE);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    destroy(device: GfxDevice) { this.dd.destroy(device); }
}

/**
 * The elastic codes' lines (MoveBG/MapObjMare.cpp TMapObjElasticCode::draw): GX_LINES, line width
 * 24 (in sixths of a pixel: 4 pixels), unlit material colour {0, 0, 100, 255}, blend ONE ZERO,
 * depth LEQUAL without writes, no culling. WebGL has no wide lines, so each line is a 4-pixel
 * quad across the screen in view space. The ends are the sim's (game/mapobj/mare.ts MapObjElasticCode.draw).
 */
export class LineDraw {
    private dd = new TDDraw('elastic code');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor() {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        const mb = new GXMaterialBuilder('MapObjElasticCode');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.REG, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(0, GX.CC.RASC, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.RASA, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.OR, GX.CompareType.ALWAYS, 0);
        mb.setZMode(true, GX.CompareType.LEQUAL, false);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    /** lines: [x0, y0, z0, x1, y1, z1] each (world); color 0..255; widthGX: GXSetLineWidth's value */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, lines: number[][], color: number[], widthGX: number) {
        if (!lines.length) return;
        const V = vi.camera.viewMatrix, P = vi.camera.projectionMatrix, H = vi.backbufferHeight || 480;
        const half = (widthGX / 6) / 2;
        const toView = (x: number, y: number, z: number) => [V[0] * x + V[4] * y + V[8] * z + V[12], V[1] * x + V[5] * y + V[9] * z + V[13], V[2] * x + V[6] * y + V[10] * z + V[14]];
        const d = this.dd;
        d.beginDraw(rim.gfxRenderCache);
        for (const l of lines) {
            const a = toView(l[0], l[1], l[2]), b = toView(l[3], l[4], l[5]);
            let dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
            // a pixel at view depth z is 2|z| / (H * P[5]) units
            const wa = half * 2 * Math.abs(a[2]) / (H * P[5]), wb = half * 2 * Math.abs(b[2]) / (H * P[5]);
            d.begin(GX.Command.DRAW_TRIANGLE_STRIP, 4);
            d.position3f32(a[0] - dy * wa, a[1] + dx * wa, a[2]);
            d.position3f32(a[0] + dy * wa, a[1] - dx * wa, a[2]);
            d.position3f32(b[0] - dy * wb, b[1] + dx * wb, b[2]);
            d.position3f32(b[0] + dy * wb, b[1] - dx * wb, b[2]);
            d.end();
        }
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        inst.sortKey = makeSortKey(GfxRendererLayer.OPAQUE);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        colorFromRGBA(this.mp.u_Color[ColorKind.MAT0], color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255);
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.identity(this.dp.u_PosMtx[0]);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    destroy(device: GfxDevice) { this.dd.destroy(device); }
}

/**
 * The light cones (Enemy/beam.cpp TBeamManager::perform's CUE_DRAW: setupMaterial, drawAllBeam):
 * each cone as two triangle fans (apex unk00 and base centre unk0C to the rim), vertex colour
 * mColor through GX_PASSCLR, in TConeBeam::drawConeBeam's four passes: (1) alpha only, the constant
 * dst alpha 0, depth ALWAYS; (2) alpha only, dst alpha 128 on its front faces, depth LEQUAL;
 * (3) colour only, its back faces behind the scene (depth GEQUAL), blend DSTALPHA ONE; (4) with
 * unk1C, its front faces (LEQUAL), blend SRCALPHA ONE, the apex's alpha 0 with unk1D. No depth
 * writes. (The channel is lit with no lights and the ambient register's leftover colour: taken as
 * white, so the vertex colour.) The cones are the sim's (game/enemies/beam.ts BeamManager).
 */
export class BeamDraw {
    private dd = new TDDraw('beams');
    private passes: GXMaterialHelperGfx[] = [];
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor() {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        this.dd.setVtxDesc(GX.Attr.CLR0, true);
        const make = (name: string, f: (mb: GXMaterialBuilder) => void) => {
            const mb = new GXMaterialBuilder(name);
            mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
            mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
            mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.RASC);
            mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.RASA);
            mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
            mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
            mb.setUsePnMtxIdx(false);
            f(mb);
            return new GXMaterialHelperGfx(mb.finish());
        };
        // (GXSetDstAlpha writes its constant whatever the blend: drawn here unblended)
        this.passes.push(make('Beam1', (mb) => { mb.setColorUpdate(false); mb.setAlphaUpdate(true); mb.setDstAlpha(0); mb.setCullMode(GX.CullMode.NONE); mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO); mb.setZMode(true, GX.CompareType.ALWAYS, false); }));
        this.passes.push(make('Beam2', (mb) => { mb.setColorUpdate(false); mb.setAlphaUpdate(true); mb.setDstAlpha(128 / 255); mb.setCullMode(GX.CullMode.BACK); mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO); mb.setZMode(true, GX.CompareType.LEQUAL, false); }));
        this.passes.push(make('Beam3', (mb) => { mb.setColorUpdate(true); mb.setAlphaUpdate(false); mb.setCullMode(GX.CullMode.FRONT); mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.DSTALPHA, GX.BlendFactor.ONE); mb.setZMode(true, GX.CompareType.GEQUAL, false); }));
        this.passes.push(make('Beam4', (mb) => { mb.setColorUpdate(true); mb.setAlphaUpdate(false); mb.setCullMode(GX.CullMode.BACK); mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.ONE); mb.setZMode(true, GX.CompareType.LEQUAL, false); }));
    }

    /** beams: { unk00, unk0C, mVtx, unk1C, unk1D }; color: mColor (0..255) */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, beams: any[], color: number[]) {
        if (!beams.length) return;
        const d = this.dd;
        d.beginDraw(rim.gfxRenderCache);
        const fan = (c: any, v: any[], apexA: number) => {
            d.begin(GX.Command.DRAW_TRIANGLE_FAN, v.length + 1);
            d.position3f32(c.x, c.y, c.z); d.color4rgba8(GX.Attr.CLR0, color[0], color[1], color[2], apexA);
            for (const p of v) { d.position3f32(p.x, p.y, p.z); d.color4rgba8(GX.Attr.CLR0, color[0], color[1], color[2], color[3]); }
            d.end();
        };
        // drawConeBeamAux(color, unk): the fan from unk00 (alpha 0 with unk), then the one from unk0C
        const aux = (b: any, unk: boolean) => { fan(b.unk00, b.mVtx, unk ? 0 : color[3]); fan(b.unk0C, b.mVtx, color[3]); };
        for (const b of beams) aux(b, false);
        const glow = beams.filter((b) => b.unk1C);
        // (one geometry set per pass kind: the plain fans, then the glow fans)
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const submit = (h: GXMaterialHelperGfx, layer: number, last: boolean) => {
            let inst;
            if (last) inst = d.makeRenderInst(rim);
            else { inst = rim.newRenderInst(); d.setOnRenderInst(inst); }
            inst.sortKey = makeSortKey(layer);
            h.setOnRenderInst(rim.gfxRenderCache, inst);
            h.allocateMaterialParamsDataOnInst(inst, this.mp);
            mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
            h.allocateDrawParamsDataOnInst(inst, this.dp);
            rim.submitRenderInst(inst);
        };
        submit(this.passes[0], 0x90, false); submit(this.passes[1], 0x91, false); submit(this.passes[2], 0x92, true);
        if (glow.length) {
            // the fourth pass's own fans (the apex alpha follows unk1D)
            this.glowDraw.beginDraw(rim.gfxRenderCache);
            const g = this.glowDraw;
            for (const b of glow) {
                const f2 = (c: any, v: any[], a0: number) => {
                    g.begin(GX.Command.DRAW_TRIANGLE_FAN, v.length + 1);
                    g.position3f32(c.x, c.y, c.z); g.color4rgba8(GX.Attr.CLR0, color[0], color[1], color[2], a0);
                    for (const p of v) { g.position3f32(p.x, p.y, p.z); g.color4rgba8(GX.Attr.CLR0, color[0], color[1], color[2], color[3]); }
                    g.end();
                };
                f2(b.unk00, b.mVtx, b.unk1D ? 0 : color[3]); f2(b.unk0C, b.mVtx, color[3]);
            }
            g.endDraw(rim);
            if (g.hasIndicesToDraw()) {
                const inst = g.makeRenderInst(rim);
                inst.sortKey = makeSortKey(0x93 as number);
                this.passes[3].setOnRenderInst(rim.gfxRenderCache, inst);
                this.passes[3].allocateMaterialParamsDataOnInst(inst, this.mp);
                mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
                this.passes[3].allocateDrawParamsDataOnInst(inst, this.dp);
                rim.submitRenderInst(inst);
            }
        }
    }
    private glowDraw = (() => { const g = new TDDraw('beams glow'); g.setVtxDesc(GX.Attr.POS, true); g.setVtxDesc(GX.Attr.CLR0, true); return g; })();

    destroy(device: GfxDevice) { this.dd.destroy(device); this.glowDraw.destroy(device); }
}

/**
 * FLUDD's splashes (Player/SplashManager.cpp TSplashManager::draw): the view-space quads of makeDL
 * (game/splash.ts) under an identity matrix, vertex colour (white, the splash's alpha), texture
 * /mario/timg/splash.bti. TEV: colour = lerp(C0 (168, 203, 227), 1, tex.rgb); alpha = tex.a * ras.a.
 * Blend SRCALPHA, INVSRCALPHA; depth LEQUAL without writes; no culling.
 */
export class SplashDraw {
    private dd = new TDDraw('splash');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor(private tex: BTIData, private c0: number[]) {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        this.dd.setVtxDesc(GX.Attr.CLR0, true);
        this.dd.setVtxDesc(GX.Attr.TEX0, true);
        const mb = new GXMaterialBuilder('SplashManager');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.VTX, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(0, GX.CC.C0, GX.CC.ONE, GX.CC.TEXC, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.TEXA, GX.CA.RASA, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.INVSRCALPHA);
        mb.setZMode(true, GX.CompareType.LEQUAL, false);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    /** quads: SplashManager.makeDL's (view-space corners: top left, top right, bottom right, bottom left) */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, quads: { v: number[]; alpha: number }[]) {
        if (!quads.length) return;
        const d = this.dd;
        const ST = [[0, 0], [1, 0], [1, 1], [0, 1]];
        d.beginDraw(rim.gfxRenderCache);
        d.begin(GX.Command.DRAW_QUADS, quads.length * 4);
        for (const q of quads) {
            for (let k = 0; k < 4; k++) {
                d.position3f32(q.v[k * 3], q.v[k * 3 + 1], q.v[k * 3 + 2]);
                d.color4rgba8(GX.Attr.CLR0, 255, 255, 255, q.alpha);
                d.texCoord2f32(GX.Attr.TEX0, ST[k][0], ST[k][1]);
            }
        }
        d.end();
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        inst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        this.tex.fillTextureMapping(this.mp.m_TextureMapping[0]);
        inst.setSamplerBindingsFromTextureMappings(this.mp.m_TextureMapping);
        const c = this.mp.u_Color[ColorKind.C0];
        c.r = this.c0[0] / 255; c.g = this.c0[1] / 255; c.b = this.c0[2] / 255; c.a = this.c0[3] / 255;
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.identity(this.dp.u_PosMtx[0]);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    destroy(device: GfxDevice) { this.dd.destroy(device); this.tex.destroy(device); }
}
