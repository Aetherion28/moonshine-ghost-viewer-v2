// The Phantamanta's shadow (Enemy/bossManta.cpp: TBossMantaManager::perform's CUE_DRAW,
// drawMantaShadow / setupEfbAlpha). The game draws no manta model (TBossManta::drawObject is
// empty): each live manta's mesh is a shadow volume counted into the EFB's alpha, then a
// full-screen quad shades where the count is set with getMantaColor (the params' manta colour,
// ramping to the angry one over 15 draws once the battle is in its second state; alpha 0x80):
//
//  - setupEfbAlpha: alpha cleared to 0 over the screen; then the manta's material colour
//    (0, 0, 0, 4), depth GEQUAL (only where the volume's face is behind the ground), no depth write;
//  - drawMantaShadow: back faces (cull front) added, front faces (cull back) subtracted, so the alpha
//    is 4 only where the ground lies inside a volume; copied out (GX_TF_A8) and drawn over the
//    screen: colour = alpha > 0 ? K0 : 0, alpha likewise, blended ONE, INVSRCALPHA
//    (the screen times 1 - K0.a, plus K0's colour).
//
// Here the count is kept in the main colour target's alpha the same way, but without a copy (a
// blend can't test "alpha > 0"), as a multiplier: alpha set to 1, back faces subtract K0.a, front
// faces add it back (so 1 - K0.a inside, 1 outside); then the screen is multiplied by that alpha
// (DSTALPHA) and K0's colour added in by 1 - alpha (in n passes, as K0's colour can be above K0.a),
// and the alpha put back to 1. Same look as the game's for a single volume.

import * as GX from '../noclip/gx/gx_enum.js';
import { mat4 } from 'gl-matrix';
import { TDDraw } from '../noclip/gx/DDraw.js';
import { GXMaterialBuilder } from '../noclip/gx/GXMaterialBuilder.js';
import { GXMaterialHelperGfx, MaterialParams, DrawParams, ColorKind } from '../noclip/gx/gx_render.js';
import { colorFromRGBA } from '../noclip/Color.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager, makeSortKey } from '../noclip/gfx/render/GfxRenderInstManager.js';
import { J3DModelInstanceSimple } from '../noclip/Common/JSYSTEM/J3D/J3DGraphSimple.js';
import { MaterialData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import * as Viewer from '../noclip/viewer.js';

/** sort layers, all between the opaque models and the translucent ones */
const L_ALPHA1 = 0x7A, L_BACK = 0x7B, L_FRONT = 0x7C, L_SHADE = 0x7D, L_RESTORE = 0x7F;

function passClr(mb: GXMaterialBuilder) {
    mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.REG, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
    mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
    mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.RASC);
    mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.RASA);
    mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
    mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
}

/**
 * The volume's materials on a manta model instance: back (cull front, subtract K0.a from the
 * alpha) or front (cull back, add it), alpha only, depth GEQUAL, no depth write.
 */
export function mantaVolumeMaterials(inst: J3DModelInstanceSimple, back: boolean) {
    for (const mi of inst.materialInstances) {
        const mb = new GXMaterialBuilder(back ? 'MantaShadowBack' : 'MantaShadowFront');
        passClr(mb);
        mb.setCullMode(back ? GX.CullMode.FRONT : GX.CullMode.BACK);
        mb.setZMode(true, GX.CompareType.GEQUAL, false);
        mb.setBlendMode(back ? GX.BlendMode.SUBTRACT : GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ONE);
        mb.setColorUpdate(false); mb.setAlphaUpdate(true);
        const me = mi.materialData.material;
        mi.setMaterialData(new MaterialData({ ...me, gxMaterial: mb.finish(), translucent: false } as any));
        mi.setSortKeyLayer((back ? L_BACK : L_FRONT) as any, false);
    }
}
/** K0.a (0..1) as the volume's material colour alpha */
export function setMantaVolumeAlpha(inst: J3DModelInstanceSimple, a: number) {
    for (const mi of inst.materialInstances) mi.setColorOverride(ColorKind.MAT0, { r: 0, g: 0, b: 0, a });
}

/** The full-screen passes (in the main pass, in view space just past the near plane). */
export class MantaShadowQuads {
    private dd = new TDDraw('manta shadow');
    private alpha1: GXMaterialHelperGfx;
    private mul: GXMaterialHelperGfx;
    private add: GXMaterialHelperGfx;
    private mp = new MaterialParams();
    private dp = new DrawParams();
    constructor() {
        this.dd.setVtxDesc(GX.Attr.POS, true);
        const make = (name: string, f: (mb: GXMaterialBuilder) => void) => {
            const mb = new GXMaterialBuilder(name);
            passClr(mb);
            mb.setCullMode(GX.CullMode.NONE);
            mb.setZMode(false, GX.CompareType.ALWAYS, false);
            mb.setUsePnMtxIdx(false);
            f(mb);
            return new GXMaterialHelperGfx(mb.finish());
        };
        this.alpha1 = make('MantaShadowAlpha', (mb) => { mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO); mb.setColorUpdate(false); mb.setAlphaUpdate(true); });
        this.mul = make('MantaShadowMul', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ZERO, GX.BlendFactor.DSTALPHA); mb.setColorUpdate(true); mb.setAlphaUpdate(false); });
        this.add = make('MantaShadowAdd', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.INVDSTALPHA, GX.BlendFactor.ONE); mb.setColorUpdate(true); mb.setAlphaUpdate(false); });
    }
    private quad(rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, h: GXMaterialHelperGfx, layer: number, c: number[]) {
        const inst = rim.newRenderInst();
        this.dd.setOnRenderInst(inst);
        inst.sortKey = makeSortKey(layer);
        h.setOnRenderInst(rim.gfxRenderCache, inst);
        colorFromRGBA(this.mp.u_Color[ColorKind.MAT0], c[0], c[1], c[2], c[3]);
        h.allocateMaterialParamsDataOnInst(inst, this.mp);
        mat4.identity(this.dp.u_PosMtx[0]);
        h.allocateDrawParamsDataOnInst(inst, this.dp);
        rim.submitRenderInst(inst);
    }
    /** color: getMantaColor (0..255, RGBA); call in the main pass's prepare while a manta's volume is drawn */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput, color: number[]) {
        const cam: any = vi.camera, near = cam.near || 1, d = near * 1.5;
        const fy = cam.fovY || Math.PI / 3, hy = Math.tan(fy / 2) * d * 1.5, hx = hy * (cam.aspect || 1.5);
        this.dd.beginDraw(rim.gfxRenderCache);
        this.dd.begin(GX.Command.DRAW_QUADS, 4);
        this.dd.position3f32(-hx, -hy, -d); this.dd.position3f32(hx, -hy, -d); this.dd.position3f32(hx, hy, -d); this.dd.position3f32(-hx, hy, -d);
        this.dd.end();
        this.dd.endDraw(rim);
        const ka = color[3] / 255, k = [color[0] / 255, color[1] / 255, color[2] / 255];
        this.quad(rim, vi, this.alpha1, L_ALPHA1, [0, 0, 0, 1]);
        this.quad(rim, vi, this.mul, L_SHADE, [0, 0, 0, 0]);
        if (ka > 0) {
            const n = Math.min(4, Math.max(1, Math.ceil(Math.max(...k) / ka - 1e-6)));
            for (let i = 0; i < n; i++) this.quad(rim, vi, this.add, L_SHADE + 1, [k[0] / (n * ka), k[1] / (n * ka), k[2] / (n * ka), 0]);
        }
        this.quad(rim, vi, this.alpha1, L_RESTORE, [0, 0, 0, 1]);
    }
    destroy(device: GfxDevice) { this.dd.destroy(device); }
}
