// The tightrope wires as the game draws them (Map/MapWireManager.cpp TMapWireManager::perform's
// CUE_DRAW, Map/MapWire.cpp drawUpper / drawLower): straight from the view matrix, unlit, one
// material colour per pass (mUpperSurface, then mLowerSurface: the manager's load, 0x78 / 0x32
// grey by default), depth tested and written. Each wire is a triangle strip through its points
// (start, the active points, end): the upper surface flat, mDrawWidth to each side across the
// wire (mDrawAxes, its run turned 90 degrees in x / z); the lower one two strips from those
// edges down to a ridge mDrawHeight under the points, so it reads as a thin prism.
//
// Drawn in the game layer's main pass, so walls hide it like any other model.

import { mat4 } from 'gl-matrix';
import * as GX from '../noclip/gx/gx_enum.js';
import { TDDraw } from '../noclip/gx/DDraw.js';
import { GXMaterialBuilder } from '../noclip/gx/GXMaterialBuilder.js';
import { GXMaterialHelperGfx, MaterialParams, DrawParams } from '../noclip/gx/gx_render.js';
import { ColorKind } from '../noclip/gx/gx_render.js';
import { colorFromRGBA } from '../noclip/Color.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager } from '../noclip/gfx/render/GfxRenderInstManager.js';
import * as Viewer from '../noclip/viewer.js';

/** One wire: its points (x, y, z each: start, the active points, end), the draw sizes and colours (0..255). */
export interface WireLine { pts: number[]; width: number; height: number; upper: number[]; lower: number[]; }

export class WireDraw {
    // (one per colour: a TDDraw's buffers can't grow once a render inst was made from them)
    private upper = new TDDraw('wires upper');
    private lower = new TDDraw('wires lower');
    private helper: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();

    constructor() {
        this.upper.setVtxDesc(GX.Attr.POS, true);
        this.lower.setVtxDesc(GX.Attr.POS, true);
        const mb = new GXMaterialBuilder('MapWire');
        mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.REG, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
        // GX_PASSCLR
        mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.RASC);
        mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.RASA);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setZMode(true, GX.CompareType.LEQUAL, true);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.INVSRCALPHA);
        // (the game culls back faces; the prism is closed, so drawing both sides looks the same and
        // doesn't depend on the strips' winding surviving the conversion to triangles)
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.helper = new GXMaterialHelperGfx(mb.finish());
    }

    private strip(d: TDDraw, pts: number[], f: (x: number, y: number, z: number, out: (x: number, y: number, z: number) => void) => void) {
        const n = pts.length / 3;
        d.begin(GX.Command.DRAW_TRIANGLE_STRIP, n * 2);
        const put = (x: number, y: number, z: number) => d.position3f32(x, y, z);
        for (let i = 0; i < n; i++) f(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], put);
        d.end();
    }

    private pass(d: TDDraw, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, c: number[]) {
        d.endDraw(rim);
        if (!d.hasIndicesToDraw()) return;
        const inst = d.makeRenderInst(rim);
        this.helper.setOnRenderInst(rim.gfxRenderCache, inst);
        colorFromRGBA(this.mp.u_Color[ColorKind.MAT0], c[0] / 255, c[1] / 255, c[2] / 255, 1);
        this.helper.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.copy(this.dp.u_PosMtx[0], vi.camera.viewMatrix);
        this.helper.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }

    /** Called in the main pass's prepare (the scene template pushed). */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, wires: WireLine[]) {
        const W = wires.filter((w) => w.pts.length >= 6);
        if (!W.length) return;
        const axes = W.map((w) => {   // mDrawAxes: (end - start) in x / z, normalized, turned 90 degrees
            const p = w.pts, k = p.length - 3, dx = p[k] - p[0], dz = p[k + 2] - p[2], l = Math.hypot(dx, dz) || 1;
            return [(-dz / l) * w.width, (dx / l) * w.width];
        });
        const U = this.upper, L = this.lower;
        U.beginDraw(rim.gfxRenderCache); L.beginDraw(rim.gfxRenderCache);
        // drawUpper: the flat top, +offset then -offset at each point
        W.forEach((w, i) => { const [ox, oz] = axes[i]; this.strip(U, w.pts, (x, y, z, o) => { o(x + ox, y, z + oz); o(x - ox, y, z - oz); }); });
        this.pass(U, rim, vi, W[0].upper);
        // drawLower: -offset edge to the ridge, then the ridge to the +offset edge
        W.forEach((w, i) => {
            const [ox, oz] = axes[i], h = w.height;
            this.strip(L, w.pts, (x, y, z, o) => { o(x - ox, y, z - oz); o(x, y - h, z); });
            this.strip(L, w.pts, (x, y, z, o) => { o(x, y - h, z); o(x + ox, y, z + oz); });
        });
        this.pass(L, rim, vi, W[0].lower);
    }

    destroy(device: GfxDevice) { this.upper.destroy(device); this.lower.destroy(device); }
}
