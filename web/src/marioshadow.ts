// Mario's shadow (MarioUtil/ShadowUtil.cpp: TMBindShadowBody, TMBindShadowParts,
// TMBindShadowManager). TMario::perform's CUE_ENTRY calls unk390->entryDrawShadow() while he is
// drawn and not sinking; TMBindShadowBody::calc finds the ground under him (checkGround at y + 30;
// a water surface: again at y - 50; illegal: no shadow) and each used joint (kind 1) asks for an
// ellipse: the joint and its first child projected down the light (the light group's first light's
// position, normalised) onto that ground height, centred between them, its radii their x / z spread
// (at least the part's radius: 38 for jnt_head, 25 for jnt_waist and jnt_chest, 18 for the rest;
// stretched 1.55x past a 0.5 ratio and the short side cut back to the minimum).
//
// TMBindShadowManager::request drops one too far from the camera (dist² > 2e7 * 6), too thin, outside
// the map or NaN; calcVtx puts it on the ground under its centre (checkGround at y + 30, the water
// surface ignored), and makes its matrix: MsMtxSetTRS(pos, (90, rotY, 0), (0.08 rx, 0.08 rz,
// 0.08 max(rx, rz) * shrink * 1.5)) (shrink 0.2 when far, 1.5 for Mario), drawing /common/
// shadowCircle.bmd (shadowCircleLow.bmd past dist² 2e7) as a volume. drawShadow: in each merged box,
// alpha cleared, front faces in front of the ground write the shadow colour's alpha, back faces behind
// it then blend the shadow colour by that alpha (and clear it), so the ground inside any volume is
// shaded once: colour = dst * (1 - a) + C * a, C (30, 50, 115, 180) (stage 6: (9, 9, 28, 116);
// stage 7: (45, 40, 60, 90)).
//
// Here, in the main colour target's alpha (the manta shadow's way, mantashadow.ts): alpha set to 0;
// back faces behind the ground add 1/4, front faces behind it take 1/4 off (so a convex volume leaves
// 1/4 where the ground is inside it, 0 elsewhere, and overlaps more); doubled twice (to 1 inside any
// volume), times a; the screen times 1 - alpha plus C times alpha; alpha back to 1.

import * as GX from '../noclip/gx/gx_enum.js';
import { mat4 } from 'gl-matrix';
import { TDDraw } from '../noclip/gx/DDraw.js';
import { GXMaterialBuilder } from '../noclip/gx/GXMaterialBuilder.js';
import { GXMaterialHelperGfx, MaterialParams, DrawParams, ColorKind } from '../noclip/gx/gx_render.js';
import { colorFromRGBA } from '../noclip/Color.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager, makeSortKey } from '../noclip/gfx/render/GfxRenderInstManager.js';
import { J3DModelInstanceSimple } from '../noclip/Common/JSYSTEM/J3D/J3DGraphSimple.js';
import { MaterialData, J3DModelData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import * as Viewer from '../noclip/viewer.js';
import { IGNORE_WATER_SURFACE } from './game/collision.js';

/** sort layers, after the opaque models and before the manta shadow's (0x7A..) */
const L_CLEAR = 0x70, L_BACK = 0x71, L_FRONT = 0x72, L_DOUBLE1 = 0x73, L_DOUBLE2 = 0x74, L_TIMES_A = 0x75, L_MUL = 0x76, L_ADD = 0x77, L_RESTORE = 0x78;
const STEP = 0.25;

/** ma_mdl1's joints of kind 1 (TMBindShadowBody: all used for Mario) and their first children */
const MARIO_PARTS: [number, number][] = [[2, 3], [3, 4], [4, 5], [6, 7], [8, 9], [9, 10], [11, 12], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19], [20, 21], [22, 23], [23, 24], [24, 25], [26, 27]];
const CIRCLE_JOINT = 0x1A, BODY_JOINTS = [2, 0xE];
const CIRCLE_R = 38, PARTS_R = 18, BODY_R = 25;
/** TMBindShadowManager: unk60 (the ground check's rise), unk68 / unk6C (the stretch ratio, its scale) */
const RISE = 30, RATIO = 0.5, STRETCH = 1.55;

function passClr(mb: GXMaterialBuilder) {
    mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.REG, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
    mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
    mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.RASC);
    mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.RASA);
    mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
    mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
}

function volumeMaterials(inst: J3DModelInstanceSimple, back: boolean) {
    for (const mi of inst.materialInstances) {
        const mb = new GXMaterialBuilder(back ? 'MarioShadowBack' : 'MarioShadowFront');
        passClr(mb);
        mb.setCullMode(back ? GX.CullMode.FRONT : GX.CullMode.BACK);
        mb.setZMode(true, GX.CompareType.GEQUAL, false);
        mb.setBlendMode(back ? GX.BlendMode.BLEND : GX.BlendMode.SUBTRACT, GX.BlendFactor.ONE, GX.BlendFactor.ONE);
        mb.setColorUpdate(false); mb.setAlphaUpdate(true);
        const me = mi.materialData.material;
        mi.setMaterialData(new MaterialData({ ...me, gxMaterial: mb.finish(), translucent: false } as any));
        mi.setSortKeyLayer((back ? L_BACK : L_FRONT) as any, false);
        mi.setColorOverride(ColorKind.MAT0, { r: 0, g: 0, b: 0, a: STEP });
    }
}

interface Req { x: number; y: number; z: number; rx: number; rz: number; dist2: number; rotY?: number; mario?: boolean; ground?: boolean }

/** a model's joint world matrix (three.js column-major elements): its translation */
const tx = (e: number[]) => e[12], ty = (e: number[]) => e[13], tz = (e: number[]) => e[14];

export class MarioShadow {
    private dd = new TDDraw('mario shadow');
    private mats: Record<string, GXMaterialHelperGfx> = {};
    private mp = new MaterialParams();
    private dp = new DrawParams();
    private pool: { hi: J3DModelInstanceSimple[]; lo: J3DModelInstanceSimple[] }[] = [];
    private used = 0;
    /** the shadow colour this frame (0..255 RGBA) */
    private color = [30, 50, 115, 180];
    constructor(private hi: J3DModelData, private lo: J3DModelData, private addModel: (m: J3DModelInstanceSimple) => void) {
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
        const alphaOnly = (mb: GXMaterialBuilder) => { mb.setColorUpdate(false); mb.setAlphaUpdate(true); };
        const colorOnly = (mb: GXMaterialBuilder) => { mb.setColorUpdate(true); mb.setAlphaUpdate(false); };
        this.mats.set = make('MarioShadowSet', (mb) => { mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO); alphaOnly(mb); });
        this.mats.double = make('MarioShadowDouble', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.DSTALPHA, GX.BlendFactor.ONE); alphaOnly(mb); });
        this.mats.times = make('MarioShadowTimes', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ZERO, GX.BlendFactor.SRCALPHA); alphaOnly(mb); });
        this.mats.mul = make('MarioShadowMul', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ZERO, GX.BlendFactor.INVDSTALPHA); colorOnly(mb); });
        this.mats.add = make('MarioShadowAdd', (mb) => { mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.DSTALPHA, GX.BlendFactor.ONE); colorOnly(mb); });
    }

    /** TMBindShadowManager's colour for the stage (its constructor: by SMSGetApplication()->mCurrArea.getStage()) */
    setStage(stage: number) {
        this.color = stage === 6 ? [9, 9, 28, 116] : stage === 7 ? [45, 40, 60, 90] : [30, 50, 115, 180];
    }

    private volume(i: number): { hi: J3DModelInstanceSimple[]; lo: J3DModelInstanceSimple[] } {
        while (this.pool.length <= i) {
            const mk = (d: J3DModelData) => [true, false].map((back) => { const m = new J3DModelInstanceSimple(d); volumeMaterials(m, back); m.visible = false; this.addModel(m); return m; });
            this.pool.push({ hi: mk(this.hi), lo: mk(this.lo) });
        }
        return this.pool[i];
    }

    /** start a frame: every volume hidden */
    begin() {
        for (const p of this.pool) for (const m of [...p.hi, ...p.lo]) m.visible = false;
        this.used = 0;
    }

    /**
     * TMBindShadowBody::calc + TMBindShadowParts::calc + TMBindShadowManager::request / calcVtx for one
     * Mario: pos his position, bones his joints' world matrices (by ma_mdl1 joint index), col the map's
     * collision, light the light group's first light's position, eye the camera's.
     */
    addMario(pos: { x: number; y: number; z: number }, bones: any[], col: any, light: number[], eye: number[]) {
        if (!col || !bones) return;
        let [groundY, g] = col.checkGround(pos.x, pos.y + RISE, pos.z);
        if (g && g.isWaterSurface()) [groundY, g] = col.checkGround(pos.x, pos.y - 50, pos.z);
        if (!g || g.isIllegal()) return;
        const ll = Math.hypot(light[0], light[1], light[2]) || 1, lx = light[0] / ll, lz = light[2] / ll;
        const dist = Math.abs(pos.y - groundY);
        for (const [j, c] of MARIO_PARTS) {
            const a = bones[j], b = bones[c];
            if (!a || !b) continue;
            const A = a.matrixWorld.elements, B = b.matrixWorld.elements;
            const h1 = ty(A) - dist - groundY, h2 = ty(B) - dist - groundY;
            const x1 = tx(A) - lx * h1, z1 = tz(A) - lz * h1, x2 = tx(B) - lx * h2, z2 = tz(B) - lz * h2;
            const cx = 0.5 * (x1 + x2), cz = 0.5 * (z1 + z2);
            let rz = Math.abs(cz - z2), rx = Math.abs(cx - x2);
            const circle = j === CIRCLE_JOINT, min = BODY_JOINTS.includes(j) ? BODY_R : circle ? CIRCLE_R : PARTS_R;
            if (rx < min) rx = min;
            if (rz < min) rz = min;
            if (!circle) {
                if (rz > rx) { if (rz > RATIO * rx) rz *= STRETCH; if (rx > min) rx = min; }
                else if (rx > rz) { if (rx > RATIO * rz) rx *= STRETCH; if (rz > min) rz = min; }
            }
            this.request({ x: cx, y: groundY, z: cz, rx, rz, dist2: 0, rotY: 0, mario: true, ground: true }, col, eye);
        }
    }

    /** TLiveActor::requestShadow (a circle of the actor's scaled body radius, turned by its rotation) */
    addActor(a: any, col: any, eye: number[]) {
        if (!col || !a || !a.pos || typeof a.checkLiveFlag !== 'function') return;
        if (a.checkLiveFlag(0x1 | 0x2 | 0x8)) return;   // DEAD | HIDDEN | UNK8
        if (a.checkLiveFlag(0x200 | 0x4) && !a.checkLiveFlag(0x400)) return;   // UNK200 | CLIPPED_OUT, unless FORCE_SHADOW
        const air = a.checkLiveFlag(0x80);
        const r = a.scaledBodyRadius;
        this.request({ x: a.pos.x, y: air ? a.pos.y : a.groundHeight, z: a.pos.z, rx: r, rz: r, dist2: 0, rotY: a.rot ? a.rot.y : 0, mario: false, ground: air }, col, eye);
    }

    private request(r: Req, col: any, eye: number[]) {
        const dx = r.x - eye[0], dy = r.y - eye[1], dz = r.z - eye[2];
        r.dist2 = dx * dx + dy * dy + dz * dz;
        if (r.dist2 > 20000000 * 6) return;
        if (r.rx < 0.01 || r.rz < 0.01) return;
        if (!col.isInArea(r.x, r.z)) return;
        if (Number.isNaN(r.x) || Number.isNaN(r.z)) return;
        // calcVtx: on the ground under its centre (unless the request already put it there)
        let gy = r.y;
        if (r.ground !== false) {
            let g: any;
            [gy, g] = col.checkGround(r.x, r.y + RISE, r.z);
            if (g && g.isWaterSurface()) [gy, g] = col.checkGround(r.x, r.y, r.z, IGNORE_WATER_SURFACE);
        }
        const rotY = r.rotY || 0;
        const shrink = r.dist2 > 20000000 || rotY !== 0 ? 0.2 : 1;
        const rad = Math.max(r.rx, r.rz);
        const sx = 0.08 * r.rx, sy = 0.08 * r.rz, sz = 0.08 * (rad * shrink) * (r.mario ? 1.5 : 1);
        // MsMtxSetTRS(x, y, z, 90, rotY, 0, sx, sy, sz): model y along world z, model z down world -y, turned by rotY about y
        const c = Math.cos(rotY * Math.PI / 180), s = Math.sin(rotY * Math.PI / 180);
        const v = this.volume(this.used++), set = r.dist2 < 20000000 ? v.hi : v.lo;
        for (const m of set) {
            mat4.set(m.modelMatrix, sx * c, 0, -sx * s, 0, sy * s, 0, sy * c, 0, 0, -sz, 0, 0, r.x, gy, r.z, 1);
            m.visible = true;
        }
    }

    private quad(rim: GfxRenderInstManager, h: GXMaterialHelperGfx, layer: number, c: number[]) {
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

    /** the full-screen passes; call in the main pass's prepare */
    prepare(device: GfxDevice, rim: GfxRenderInstManager, vi: Viewer.ViewerRenderInput) {
        if (!this.used) return;
        const cam: any = vi.camera, near = cam.near || 1, d = near * 1.5;
        const fy = cam.fovY || Math.PI / 3, hy = Math.tan(fy / 2) * d * 1.5, hx = hy * (cam.aspect || 1.5);
        this.dd.beginDraw(rim.gfxRenderCache);
        this.dd.begin(GX.Command.DRAW_QUADS, 4);
        this.dd.position3f32(-hx, -hy, -d); this.dd.position3f32(hx, -hy, -d); this.dd.position3f32(hx, hy, -d); this.dd.position3f32(-hx, hy, -d);
        this.dd.end();
        this.dd.endDraw(rim);
        const [r, g, b, a] = this.color;
        this.quad(rim, this.mats.set, L_CLEAR, [0, 0, 0, 0]);
        this.quad(rim, this.mats.double, L_DOUBLE1, [0, 0, 0, 1]);
        this.quad(rim, this.mats.double, L_DOUBLE2, [0, 0, 0, 1]);
        this.quad(rim, this.mats.times, L_TIMES_A, [0, 0, 0, a / 255]);
        this.quad(rim, this.mats.mul, L_MUL, [0, 0, 0, 0]);
        this.quad(rim, this.mats.add, L_ADD, [r / 255, g / 255, b / 255, 0]);
        this.quad(rim, this.mats.set, L_RESTORE, [0, 0, 0, 1]);
    }
    destroy(device: GfxDevice) { this.dd.destroy(device); }
}
