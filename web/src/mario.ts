// Mario from the player's mario.szs, drawn by the game's own J3D model code (noclip's port):
// the body (ma_mdl1) posed by the ghost's animation, the hands the game swaps in
// (TMario::changeHand), the cap, and FLUDD with its nozzle (TWaterGun), each on the joint the
// game hangs it from.

import { mat4, vec3 } from 'gl-matrix';
import ArrayBufferSlice from '../noclip/ArrayBufferSlice.js';
import AnimationController from '../noclip/AnimationController.js';
import * as RARC from '../noclip/Common/JSYSTEM/JKRArchive.js';
import { J3DModelData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import { J3DModelInstanceSimple } from '../noclip/Common/JSYSTEM/J3D/J3DGraphSimple.js';
import { ANK1, BCK, BMD } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../noclip/gfx/render/GfxRenderCache.js';
import { MARIO_ANIM_TABLE, MARIO_BCK_FILES } from './mario_anims.js';
import { SMSPass, SceneBinObjLight } from './sms_scene.js';
import { colorFromRGBA } from '../noclip/Color.js';
import { ColorKind } from '../noclip/gx/gx_render.js';
import { transformVec3Mat4w1 } from '../noclip/MathHelpers.js';

const _v = vec3.create();
/**
 * Mario's lights, as TLightMario::setLight loads them (MarioUtil/LightUtil.cpp): GX_LIGHT0 at the
 * player sun (太陽（プレイヤー）) with its colour, no attenuation; GX_LIGHT2 the specular light toward
 * it (GXInitSpecularDir) in the same colour, shininess 50 (GXInitLightShininess: cos atten 0, 0, 1,
 * dist atten 25, 0, -24). The channel's ambient (太陽アンビエント（プレイヤー）) is set on the materials.
 */
export function setPlayerLights(models: J3DModelInstanceSimple[], sun: SceneBinObjLight, viewMatrix: mat4) {
    for (const m of models) {
        const l0 = m.getGXLightReference(0);
        vec3.set(_v, sun.x, sun.y, sun.z);
        transformVec3Mat4w1(l0.Position, viewMatrix, _v);
        colorFromRGBA(l0.Color, sun.r / 255, sun.g / 255, sun.b / 255, sun.a / 255);
        vec3.set(l0.CosAtten, 1, 0, 0);
        vec3.set(l0.DistAtten, 1, 0, 0);
        const l2 = m.getGXLightReference(2);
        transformVec3Mat4w1(_v, viewMatrix, _v);
        vec3.normalize(_v, _v);
        const nx = -_v[0], ny = -_v[1], nz = -_v[2];
        // GXInitSpecularDir: the half-angle vector, and the position far along the direction.
        vec3.set(l2.Direction, -nx, -ny, -(nz - 1));
        vec3.normalize(l2.Direction, l2.Direction);
        vec3.set(l2.Position, nx * -1048576, ny * -1048576, nz * -1048576);
        colorFromRGBA(l2.Color, sun.r / 255, sun.g / 255, sun.b / 255, sun.a / 255);
        vec3.set(l2.CosAtten, 0, 0, 1);
        vec3.set(l2.DistAtten, 25, 0, -24);
    }
}

/** An animation controller the scene's clock doesn't drive: the ghost sets its frame. */
class PinnedAnimationController extends AnimationController {
    public override setTimeInMilliseconds(_ms: number): void { }
}

export class MarioModel {
    public body: J3DModelInstanceSimple;
    public parts: J3DModelInstanceSimple[] = [];
    public hands: Record<string, J3DModelInstanceSimple> = {};
    public cap: J3DModelInstanceSimple | null = null;
    public fludd: J3DModelInstanceSimple | null = null;
    public nozzles: Record<string, J3DModelInstanceSimple> = {};
    private anim = new PinnedAnimationController(30);
    private bcks = new Map<string, ANK1 | null>();
    private joint: Record<string, number> = {};
    private fluddNozzleCenter = -1;
    public all: J3DModelInstanceSimple[] = [];

    constructor(device: GfxDevice, cache: GfxRenderCache, private arc: RARC.JKRArchive) {
        const load = (path: string): J3DModelInstanceSimple | null => {
            const f = arc.findFile(path);
            if (!f) return null;
            const m = new J3DModelInstanceSimple(new J3DModelData(device, cache, BMD.parse(f.buffer)));
            m.passMask = SMSPass.MAIN;
            m.animationController = new PinnedAnimationController(30);
            (m as any).isPlayer = true;
            return m;
        };
        this.body = load('bmd/ma_mdl1.bmd')!;
        this.body.animationController = this.anim;
        this.body.modelData.bmd.jnt1.joints.forEach((j, i) => { this.joint[j.name] = i; });
        for (const id of ['2', '3', '4'])
            for (const side of ['r', 'l']) {
                const m = load(`bmd/ma_hnd${id}${side}.bmd`);
                if (m) this.hands[id + side] = m;
            }
        this.cap = load('bmd/ma_cap1.bmd');
        this.fludd = load('watergun2/body/wg_mdl1.bmd');
        if (this.fludd) this.fluddNozzleCenter = this.fludd.modelData.bmd.jnt1.joints.findIndex((j) => j.name === 'nozzle_center');
        for (const n of ['normal_wg', 'hover_wg', 'rocket_wg', 'back_wg']) {
            const m = load(`watergun2/${n}/${n}.bmd`);
            if (m) this.nozzles[n] = m;
        }
        // Parts ship a placeholder texture the game replaces at load with the body's first one
        // (MarioDraw.cpp / MarioCap.cpp, setResTIMG(0, body texture 0)); FLUDD's nozzles take
        // FLUDD's second (TWaterGun::init, SMS_ChangeTextureAll).
        const bodyTex0 = this.body.materialInstanceState.textureMappings[0];
        for (const m of [...Object.values(this.hands), this.cap]) {
            const r = m && m.getTextureMappingReference('H_ma_main_dummy');
            if (r) r.copy(bodyTex0);
        }
        if (this.fludd) {
            const t1 = this.fludd.materialInstanceState.textureMappings[1];
            for (const m of Object.values(this.nozzles)) {
                const r = m.getTextureMappingReference('H_watergun_main_dummy');
                if (r && t1) r.copy(t1);
            }
        }
        // A clean Mario: TMario::addDirty puts mDirty (0 until goop gets on him) in the alpha of
        // konst colour 0 on the body's, hands' and cap's materials (TMarioCap::addDirty), which blends in the goop texture.
        for (const m of [this.body, ...Object.values(this.hands), ...(this.cap ? [this.cap] : [])])
            for (const md of m.modelMaterialData.materialData || []) {
                const k = md.material.colorConstants[0];
                if (k) md.material.colorConstants[0] = { r: k.r, g: k.g, b: k.b, a: 0 };
            }
        // FLUDD's water gauge (h_watergun_mask_i4): its tank shapes drawn with the mask the game
        // fills by water level (TWaterGun); left out, as v1 leaves them out.
        // TODO: the game's water level in the tank.
        if (this.fludd) {
            const f = this.fludd, samplers = f.modelData.bmd.tex1.samplers;
            f.materialInstances.forEach((mi) => {
                const tex = mi.materialData.material.textureIndexes.filter((i) => i >= 0).map((i) => (samplers[i] ? samplers[i].name.toLowerCase() : ''));
                if (tex.includes('h_watergun_mask_i4')) for (const si of mi.shapeInstances) si.visible = false;
            });
        }
        this.parts = [...Object.values(this.hands), ...(this.cap ? [this.cap] : []), ...(this.fludd ? [this.fludd] : []), ...Object.values(this.nozzles)];
        this.all = [this.body, ...this.parts];
        // Shape 10 is the Hawaiian shirt, only once Mario buys it (TMario::thinkAloha).
        if (this.body.shapeInstances.length > 10) this.body.setShapeVisible(10, false);
    }

    private bck(name: string): ANK1 | null {
        if (!this.bcks.has(name)) {
            const f = this.arc.findFile(`bck/ma_${name}.bck`);
            this.bcks.set(name, f ? BCK.parse(f.buffer) : null);
        }
        return this.bcks.get(name)!;
    }

    public setVisible(v: boolean) { for (const m of this.all) m.visible = v; }

    /**
     * Pose for a ghost sample: position, yaw (s16), the ghost's animation ID and phase (0..4095 of
     * the loop), riding Yoshi or not, FLUDD's nozzle name (or null without FLUDD).
     */
    public pose(x: number, y: number, z: number, yaw: number, animId: number, yoshi: boolean, phase: number, nozzle: string | null) {
        const idx = yoshi ? animId : (MARIO_ANIM_TABLE[animId] || [200])[0];
        const file = MARIO_BCK_FILES[idx];
        const ank1 = file ? this.bck(file) : null;
        if (ank1 && (this.body as any)._ank1 !== ank1) {
            this.body.bindANK1(ank1, this.anim);
            (this.body as any)._ank1 = ank1;
        }
        if (ank1) this.anim.setTimeInFrames((phase / 4096) * ank1.duration);
        mat4.fromYRotation(this.body.modelMatrix, (yaw / 32768) * Math.PI);
        this.body.modelMatrix[12] = x; this.body.modelMatrix[13] = y; this.body.modelMatrix[14] = z;
        // Hands per TMario::changeHand: 0 the body's own (shapes 5 and 6), 1 ma_hnd2, 2 ma_hnd3;
        // ma_hnd4r stays hidden; riding Yoshi always 0.
        const h0 = yoshi ? 0 : (MARIO_ANIM_TABLE[animId] || [0, 0])[1];
        const h = h0 === 1 || h0 === 2 ? h0 : 0;
        this.body.setShapeVisible(5, h === 0); this.body.setShapeVisible(6, h === 0);
        const show = (k: string, v: boolean) => { if (this.hands[k]) this.hands[k].visible = v; };
        show('2r', h === 1); show('2l', h === 1); show('3r', h === 2); show('3l', h === 2); show('4r', false);
        if (this.fludd) this.fludd.visible = nozzle !== null;
        for (const [n, m] of Object.entries(this.nozzles)) m.visible = n === nozzle;
    }

    /** Joint matrices for the pose, then the parts hung on them. Before drawing. */
    public calcParts() {
        this.body.calcAnim();
        const J = this.body.shapeInstanceState.jointToWorldMatrixArray;
        const at = (m: J3DModelInstanceSimple | null | undefined, joint: string) => { if (m && this.joint[joint] !== undefined) mat4.copy(m.modelMatrix, J[this.joint[joint]]); };
        for (const [k, m] of Object.entries(this.hands)) at(m, k.endsWith('r') ? 'jnt_hand_R' : 'jnt_hand_L');
        at(this.cap, 'M_head');
        if (this.fludd) {
            at(this.fludd, 'jnt_chest');
            this.fludd.calcAnim();
            const N = this.fludd.shapeInstanceState.jointToWorldMatrixArray[this.fluddNozzleCenter];
            if (N) for (const m of Object.values(this.nozzles)) mat4.copy(m.modelMatrix, N);
        }
    }

    public position(out: vec3) { vec3.set(out, this.body.modelMatrix[12], this.body.modelMatrix[13], this.body.modelMatrix[14]); return out; }
}

export function parseArchive(buf: ArrayBuffer, yaz0: (b: ArrayBufferSlice) => ArrayBufferSlice): RARC.JKRArchive {
    let b = new ArrayBufferSlice(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === 'Yaz0') b = yaz0(b);
    return RARC.parse(b);
}

// ---------------------------------------------------------------- Yoshi
// yoshi.szs's model and its BCKs in alphabetical order (MActor's index, which Moonshine V7
// records). Body colour: TEV register 2 = TYoshi's bodyColor for its type.
const YOSHI_COLORS = [[0x40, 0xa1, 0x24], [0xff, 0x8c, 0x1c], [0xaa, 0x4c, 0xff], [0xff, 0xa0, 0xbe]];   // green, orange, purple, pink

export class YoshiModel {
    public body: J3DModelInstanceSimple;
    private anim = new PinnedAnimationController(30);
    private names: string[];
    private bcks = new Map<number, ANK1 | null>();
    private colour = -1;
    constructor(device: GfxDevice, cache: GfxRenderCache, private arc: RARC.JKRArchive) {
        const f = arc.findFile('yoshi_model.bmd')!;
        this.body = new J3DModelInstanceSimple(new J3DModelData(device, cache, BMD.parse(f.buffer)));
        this.body.passMask = SMSPass.MAIN;
        this.body.animationController = this.anim;
        (this.body as any).isPlayer = true;
        this.names = arc.root.files.map((x) => x.name.toLowerCase()).filter((n) => n.endsWith('.bck')).sort();
    }
    /** The rider animation's Yoshi counterpart (ghosts before V7 record only Mario): yo_run -> yoshi_run. */
    indexForRider(marioFile: string | undefined): number {
        const name = marioFile && /^yo_/.test(marioFile) ? `yoshi_${marioFile.slice(3)}.bck` : 'yoshi_wait.bck';
        const k = this.names.indexOf(name);
        return k >= 0 ? k : this.names.indexOf('yoshi_wait.bck');
    }
    private bck(i: number) {
        if (!this.bcks.has(i)) {
            const f = this.names[i] ? this.arc.findFile(this.names[i]) : null;
            this.bcks.set(i, f ? BCK.parse(f.buffer) : null);
        }
        return this.bcks.get(i)!;
    }
    setColour(colour: number) {
        if (colour === this.colour) return;
        this.colour = colour;
        const c = YOSHI_COLORS[colour >= 1 && colour <= 4 ? colour - 1 : 0];
        for (const mi of this.body.materialInstances) mi.setColorOverride(ColorKind.C2, { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: 1 });
    }
    duration(i: number) { const a = this.bck(i); return a ? a.duration : 1; }
    pose(x: number, y: number, z: number, yaw: number, colour: number, animIndex: number, frame: number) {
        if (colour !== this.colour) {
            this.colour = colour;
            const c = YOSHI_COLORS[colour >= 1 && colour <= 4 ? colour - 1 : 0];
            for (const mi of this.body.materialInstances) mi.setColorOverride(ColorKind.C2, { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: 1 });
        }
        const a = this.bck(animIndex);
        if (a && (this.body as any)._ank1 !== a) { this.body.bindANK1(a, this.anim); (this.body as any)._ank1 = a; }
        if (a) this.anim.setTimeInFrames(frame);
        mat4.fromYRotation(this.body.modelMatrix, (yaw / 32768) * Math.PI);
        this.body.modelMatrix[12] = x; this.body.modelMatrix[13] = y; this.body.modelMatrix[14] = z;
    }
}
