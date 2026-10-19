// The game's own renderer under the viewer: noclip's port of J3D and the Sunshine stage loader,
// drawing the stage from the player's disc, with every object the viewer's logic places and
// moves drawn with its model from the disc too. The viewer (index.html, three.js) keeps all of
// its game logic — pickups, Shines, carried objects, the Chain Chomp, moving platforms, walkers,
// FLUDD — and its own scene graph; this layer copies that scene graph's matrices, joints,
// visibility and TEV colours onto the game's models each frame, then draws them on a canvas
// under the viewer's. The viewer then draws only what the game models can't (water, particles,
// wires, overlays), depth-tested against its own copies of the stage and objects.

import { mat4, ReadonlyMat4 } from 'gl-matrix';
import ArrayBufferSlice from '../noclip/ArrayBufferSlice.js';
import AnimationController from '../noclip/AnimationController.js';
import { Camera } from '../noclip/Camera.js';
import * as RARC from '../noclip/Common/JSYSTEM/JKRArchive.js';
import * as Yaz0 from '../noclip/Common/Compression/Yaz0.js';
import { J3DModelData, J3DModelMaterialData, MaterialInstance, MaterialData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import * as GX from '../noclip/gx/gx_enum.js';
import { J3DModelInstanceSimple } from '../noclip/Common/JSYSTEM/J3D/J3DGraphSimple.js';
import { BCK, BMD, BMT, BRK, BTK, BPK, BTP } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { AntialiasingMode } from '../noclip/gfx/helpers/RenderGraphHelpers.js';
import { createSwapChainForWebGL2, GfxPlatformWebGL2Config } from '../noclip/gfx/platform/GfxPlatformWebGL2.js';
import { GfxDevice, GfxSwapChain } from '../noclip/gfx/platform/GfxPlatform.js';
import { ColorKind } from '../noclip/gx/gx_render.js';
import { Color } from '../noclip/Color.js';
import { GameFS, openDisc, openFolder, rememberHandle, rememberedHandle, forgetHandle } from './disc.js';
import { parseStageArc, sceneForRoute } from './stagearc.js';
import { SMSPass, SunshineRenderer, SunshineSceneDesc } from './sms_scene.js';
import { MarioModel, YoshiModel, parseArchive, setPlayerLights } from './mario.js';
import { swapTextures } from './actors.js';
import { SimRunner, DiscCommon, SimInput, fileMap, FileMap } from './game/runner.js';
import { CLASSES } from './game/scene.js';
import { LiveActor } from './game/engine.js';
import { calcANK1JointAnimationTransform } from '../noclip/Common/JSYSTEM/J3D/J3DGraphAnimator.js';
import { JointTransformInfo } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { V1Data } from './v1data/index.js';

/** Where a viewer library model comes from on the disc (tools/build_objects.py, data["mp"]). */
interface Spec { f: string; bmt?: string; tex?: number; bck?: string; shrink?: string; parts?: [string, string][]; lift?: number; swap?: [string, string]; }

/**
 * A Boo's materials (telesa.bmd): their last TEV stage mixes the screen behind it (the indirect
 * refraction in C2) with the Boo's own colour by KCOLOR0's alpha. The viewer has no screen copy to
 * refract, so that mix is drawn as blending over what's behind by that alpha.
 */
function booMaterials(inst: J3DModelInstanceSimple) {
    for (const mi of inst.materialInstances) {
        const me = mi.materialData.material, g0 = me.gxMaterial;
        const g = { ...g0, tevStages: g0.tevStages.map((t) => ({ ...t })), ropInfo: { ...g0.ropInfo } };
        const t = g.tevStages[g.tevStages.length - 1];
        t.colorInA = GX.CC.ZERO; t.colorInB = GX.CC.ZERO; t.colorInC = GX.CC.ZERO; t.colorInD = GX.CC.CPREV;
        t.alphaInA = GX.CA.ZERO; t.alphaInB = GX.CA.ZERO; t.alphaInC = GX.CA.ZERO; t.alphaInD = GX.CA.KONST;
        t.konstAlphaSel = GX.KonstAlphaSel.KASEL_K0_A;
        g.ropInfo.blendMode = GX.BlendMode.BLEND; g.ropInfo.blendSrcFactor = GX.BlendFactor.SRCALPHA; g.ropInfo.blendDstFactor = GX.BlendFactor.INVSRCALPHA;
        g.ropInfo.depthWrite = false;
        mi.setMaterialData(new MaterialData({ ...me, gxMaterial: g, translucent: true }));
    }
}

/** An animation controller nothing drives: a frame is set on it. */
class PinnedAnimationController extends AnimationController {
    public override setTimeInMilliseconds(_ms: number): void { }
}

/** One game model following one object of the viewer's scene graph. */
interface Mirror {
    obj: any;
    inst: J3DModelInstanceSimple;
    /** The viewer's bones, by joint index: their world matrices replace the model's joints. */
    bones: any[] | null;
    mats: { m: any; mi: MaterialInstance; c: Color[] }[];
    lift: number;
    /** The viewer's materials it stands in for (drawn into depth only while the layer is live). */
    proxied: any[];
    /** A spring's frame of jumpbase_shrink (the viewer shows one of its baked frames). */
    pin?: PinnedAnimationController;
    /** Hung on a joint of another mirror's model (the cannon's lids). */
    on?: { m: Mirror; joint: number };
    actor: boolean;
}

/** One of the game code's objects, drawn with its model. */
interface SimMirror { inst: J3DModelInstanceSimple; bck: string; pin: PinnedAnimationController; }

const _m = mat4.create();
const REG_KINDS = [ColorKind.C0, ColorKind.C1, ColorKind.C2];   // (TEV register 3 is CPREV's)
const K_KINDS = [ColorKind.K0, ColorKind.K1, ColorKind.K2, ColorKind.K3];
const MAT_KINDS = [ColorKind.MAT0, ColorKind.MAT1];

function worldVisible(o: any): boolean {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
}
/** Visible, and still in the group (an object taken out of it isn't drawn). */
function visibleIn(o: any, root: any): boolean {
    for (let p = o; p; p = p.parent) { if (!p.visible) return false; if (p === root) return true; }
    return false;
}

function setColor(c: Color, v: number[]) { c.r = v[0]; c.g = v[1]; c.b = v[2]; c.a = v.length > 3 ? v[3] : 1; }

/** Joints from the viewer's bones, after the model's own animation. */
function pinJoints(inst: J3DModelInstanceSimple, bones: () => (any[] | null)) {
    const calc = inst.calcAnim.bind(inst);
    inst.calcAnim = () => {
        calc();
        const B = bones();
        if (!B) return;
        const W = inst.shapeInstanceState.jointToWorldMatrixArray;
        for (let i = 0; i < W.length; i++) { const b = B[i]; if (b) W[i].set(b.matrixWorld.elements); }
    };
}

/**
 * A Shine in the viewer's Shine get demo (placeShineDemo): its meshes on the joints of its own
 * animation (body, starglow facing the camera), each moved by the viewer, its mesh vertices 71.4
 * below the joints (SG.bindY): the joints from there while the demo runs (userData.sgPlaced).
 */
function pinShineDemo(inst: J3DModelInstanceSimple, o: any) {
    const glow: any[] = o.userData.glow || [];
    let body: any = null;
    o.traverse((x: any) => { if (x.isMesh && !body && !glow.includes(x)) body = x; });
    const calc = inst.calcAnim.bind(inst);
    const up = mat4.fromTranslation(mat4.create(), [0, 71.4, 0]);
    inst.calcAnim = () => {
        calc();
        if (!o.userData.sgPlaced) return;
        const W = inst.shapeInstanceState.jointToWorldMatrixArray;
        if (W[0]) W[0].set(o.matrixWorld.elements);
        if (W[1] && glow[0]) { W[1].set(glow[0].matrixWorld.elements); mat4.mul(W[1], W[1], up); }
        if (W[2] && body) { W[2].set(body.matrixWorld.elements); mat4.mul(W[2], W[2], up); }
    };
}

class MarioMirror {
    public mario: MarioModel;
    public yoshi: YoshiModel | null = null;
    public rig: any = null;
    public yoshiNode: any = null;
    constructor(layer: GameLayer, r: SunshineRenderer) {
        const device = layer.device, cache = r.renderHelper.renderInstManager.gfxRenderCache;
        this.mario = new MarioModel(device, cache, layer.marioArc!);
        setAmbient(this.mario.all, r.playerAmbient);
        swapTextures(device, cache, r.rarc, this.mario.all);
        pinJoints(this.mario.body, () => this.rig && this.rig.bones);
        if (this.mario.fludd) pinJoints(this.mario.fludd, () => this.rig && this.rig.fludd ? this.rig.fludd.body : null);
        for (const [n, m] of Object.entries(this.mario.nozzles)) pinJoints(m, () => this.rig && this.rig.fludd ? this.rig.fludd.noz[n] : null);
        r.modelInstances.push(...this.mario.all);
        if (layer.yoshiArc) {
            this.yoshi = new YoshiModel(device, cache, layer.yoshiArc);
            this.yoshi.body.visible = false;
            setAmbient([this.yoshi.body], r.playerAmbient);
            pinJoints(this.yoshi.body, () => this.yoshiNode && this.yoshiNode.bones);
            r.modelInstances.push(this.yoshi.body);
        }
    }
    get models() { return [...this.mario.all, ...(this.yoshi ? [this.yoshi.body] : [])]; }

    /** Mario as the viewer posed him (rig: MarioRig.attach's, with fluddBones), and his Yoshi. */
    sync(rig: any, yoshiNode: any) {
        this.rig = rig; this.yoshiNode = yoshiNode;
        const M = this.mario, on = !!rig && worldVisible(rig.root);
        M.setVisible(on);
        if (on) {
            mat4.copy(M.body.modelMatrix, rig.root.matrixWorld.elements as any);
            for (const [k, s] of Object.entries(rig.bodyShapes as Record<string, any>)) if (M.body.shapeInstances[+k]) M.body.setShapeVisible(+k, worldVisible(s));
            const part = (m: J3DModelInstanceSimple | null, node: any) => {
                if (!m) return;
                m.visible = !!node && worldVisible(node);
                if (m.visible) mat4.copy(m.modelMatrix, node.matrixWorld.elements as any);
            };
            for (const [k, m] of Object.entries(M.hands)) part(m, rig.parts[`hand_${k[0]}_${k[1]}`]);
            part(M.cap, rig.parts.cap);
            part(M.fludd, rig.parts.fludd_body);
            for (const [n, m] of Object.entries(M.nozzles)) part(m, rig.parts['nozzle_' + n]);
        }
        if (this.yoshi) {
            const Y = yoshiNode, yv = !!Y && worldVisible(Y.root);
            this.yoshi.body.visible = yv;
            if (yv) { this.yoshi.setColour(Y.colour); mat4.copy(this.yoshi.body.modelMatrix, Y.root.matrixWorld.elements as any); }
        }
    }
}

export class GameLayer {
    public device: GfxDevice;
    private swapChain: GfxSwapChain;
    public camera = new Camera();
    private viewerInput: any;
    public fs: GameFS | null = null;
    public stageTable: string[][] = [];
    public marioArc: RARC.JKRArchive | null = null;
    public yoshiArc: RARC.JKRArchive | null = null;
    public renderer: SunshineRenderer | null = null;
    public scene = '';
    private loading = '';
    private playerSun: any = null;
    private objectSun: any = null;
    private mirrors: Mirror[] = [];
    private byObj = new Map<any, Mirror[]>();
    private boundGroup: any = null;
    /** Drawing (else the viewer draws everything itself again). */
    public live = false;
    private proxiedMario = new Set<any>();
    private marios = new Map<any, MarioMirror>();
    private actorModels: J3DModelInstanceSimple[] = [];
    private dataCache = new Map<string, J3DModelData | null>();
    private bmtCache = new Map<string, J3DModelMaterialData | null>();
    private files = new Map<string, RARC.RARCFile>();
    public onStatus: (text: string) => void = () => { };
    public onError: (e: any) => void = (e) => console.error(e);
    /** A frame has been drawn for the current scene. */
    public drawn = false;
    /** The stage's game code (the enemies...), run alongside the ghost. */
    public sim: SimRunner | null = null;
    private simFiles: FileMap | null = null;
    private simMirrors = new Map<LiveActor, SimMirror>();
    private simPlaces = new Set<string>();
    /** the goop layers' models (TPollutionLayer: map/pollution/pollutionNN.bmd, texture 0 the goop map) */
    private goop: { stage: any; frame: number; insts: (J3DModelInstanceSimple | null)[] } | null = null;

    constructor(public canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false, depth: false, stencil: false });
        if (!gl) throw new Error('This browser has no WebGL 2.');
        this.swapChain = createSwapChainForWebGL2(gl, new GfxPlatformWebGL2Config());
        this.device = this.swapChain.getDevice();
        (this.camera as any).clipSpaceNearZ = this.device.queryVendorInfo().clipSpaceNearZ;
        this.viewerInput = {
            camera: this.camera, time: 0, deltaTime: 0, backbufferWidth: 1, backbufferHeight: 1, onscreenTexture: null,
            antialiasingMode: AntialiasingMode.FXAA, mouseLocation: { mouseX: -1, mouseY: -1 }, debugConsole: { addInfoLine() { } },
        };
    }

    // ------------------------------------------------------------ the disc
    public common: DiscCommon | null = null;
    /** common: another layer's (the comparison view's second layer shares the first's) */
    public async setDisc(fs: GameFS, common: DiscCommon | null = null) {
        const table = parseStageArc(await fs.read('data/stageArc.bin'));
        const mario = parseArchive(await fs.read('data/mario.szs'), Yaz0.decompressSW);
        const yoshi = fs.has('data/yoshi.szs') ? parseArchive(await fs.read('data/yoshi.szs'), Yaz0.decompressSW) : null;
        this.destroyScene();
        this.fs = fs; this.stageTable = table; this.marioArc = mario; this.yoshiArc = yoshi;
        this.common = common || await DiscCommon.load(fs);
        this.sim = new SimRunner(this.common);
    }

    public sceneFor(area: number, episode: number) { return sceneForRoute(this.stageTable, area, episode); }
    public hasScene(name: string) { return !!this.fs && this.fs.has(`data/scene/${name}.szs`); }

    /** Load a scene archive (e.g. "dolpic0"); resolves once it is the one drawn (or another was asked for). */
    public async loadScene(name: string) {
        const fs = this.fs;
        if (!fs || name === this.scene || name === this.loading) return;
        if (!this.hasScene(name)) { this.destroyScene(); this.scene = name; return; }
        this.loading = name;
        this.onStatus(`Loading ${name} from the disc…`);
        try {
            const buf = await fs.read(`data/scene/${name}.szs`);
            const device = this.device;
            const desc = new SunshineSceneDesc(name, name);
            desc.mapObjects = false;   // (the viewer's objects are drawn instead)
            const context: any = { device, dataFetcher: { fetchData: async () => new ArrayBufferSlice(buf) } };
            const r = await desc.createScene(device, context) as SunshineRenderer;
            if (this.loading !== name) { r.destroy(device); return; }
            this.destroyScene();
            this.renderer = r;
            this.scene = name;
            this.playerSun = findLight(r, '太陽（プレイヤー）');
            this.objectSun = findLight(r, '太陽（オブジェクト）');
            this.files = listFiles(r.rarc); this.introBck = undefined;
            r.beforePrepare = () => this.lights();
        } catch (e) { this.onError(e); }
        finally { if (this.loading === name) { this.loading = ''; this.onStatus(''); } }
    }

    private destroyScene() {
        if (this.renderer) this.renderer.destroy(this.device);
        for (const v of this.bmtCache.values()) if (v) v.destroy(this.device);
        this.setLive(false);
        this.renderer = null; this.scene = ''; this.mirrors = []; this.byObj.clear(); this.boundGroup = null; this.marios.clear();
        this.actorModels = []; this.dataCache.clear(); this.bmtCache.clear(); this.files.clear();
        this.drawn = false;
        this.simFiles = null; this.simMirrors.clear(); this.simPlaces.clear();
    }

    // ------------------------------------------------------------ the viewer's objects
    private modelData(path: string): J3DModelData | null {
        if (!this.dataCache.has(path)) {
            const f = this.files.get(path.toLowerCase());
            let d: J3DModelData | null = null;
            if (f) try { d = new J3DModelData(this.device, this.renderer!.renderHelper.renderInstManager.gfxRenderCache, BMD.parse(f.buffer)); } catch (e) { console.warn('[game layer]', path, e); }
            if (d) this.renderer!.destroyables.push(d);
            this.dataCache.set(path, d);
        }
        return this.dataCache.get(path)!;
    }

    private materialTable(path: string, texOnly: boolean): J3DModelMaterialData | null {
        const key = path + (texOnly ? '|tex' : '');
        if (!this.bmtCache.has(key)) {
            const f = this.files.get(path.toLowerCase());
            let d: J3DModelMaterialData | null = null;
            if (f) try {
                d = new J3DModelMaterialData(this.device, this.renderer!.renderHelper.renderInstManager.gfxRenderCache, BMT.parse(f.buffer));
                if (texOnly) d.materialData = null;   // (TMapObjBase: only its textures)
            } catch (e) { console.warn('[game layer]', path, e); }
            this.bmtCache.set(key, d);
        }
        return this.bmtCache.get(key)!;
    }

    /**
     * The viewer's object specs carry a few wrong idle animations (its build matched a "wait"
     * animation from another object's files): map objects keep only their own; Peach plays what
     * TBaseNPC gives her (sPeach_AnmIndex's wait, or peachParasolIn_'s parasol wait when she holds it).
     */
    private gameSpec(spec: Spec): Spec {
        if (!spec.bck) {
            const pm = /^peach\/peach_(hair_ponytail|hair_normal|parasol)\.bmd$/.exec(spec.f);
            if (pm) {
                const par = this.peachParasol;
                const b = pm[1] === 'parasol' ? 'peach_parasol_wait_parasol' : pm[1] === 'hair_ponytail' ? (par ? 'peach_hair_pony_parasol_wait' : 'peach_hair_ponytail_wait') : (par ? 'peach_hair_normal_parasol_wait' : 'peach_hair_normal_wait');
                return { ...spec, bck: `peach/${b}.bck` };
            }
            return spec;
        }
        if (spec.f === 'peach/peach_model.bmd') return { ...spec, bck: this.peachParasol ? 'peach/peach_parasol_wait.bck' : 'peach/peach_wait.bck' };
        const mf = spec.f.split('/'), bf = spec.bck.split('/');
        if (mf[0] === 'mapobj' && bf[0] === 'mapobj' && !bf[1].toLowerCase().startsWith(mf[1].replace(/\.(bmd|bdl)$/i, '').toLowerCase().slice(0, 5))) return { ...spec, bck: undefined };
        return spec;
    }
    /**
     * Peach's parts (TNpcParts: her hair on "kubi", the parasol on "jnt_hand_R", NpcInitData.cpp's
     * sPeach_*Data) ride the game model's joints, as posed by its own animation, not the viewer's.
     */
    private attachNpcParts() {
        const PARTS: Record<string, string> = { 'peach/peach_hair_ponytail.bmd': 'kubi', 'peach/peach_hair_normal.bmd': 'kubi', 'peach/peach_parasol.bmd': 'jnt_hand_R' };
        const bodies = this.mirrors.filter((m) => m.inst.name === 'peach/peach_model.bmd' && !m.on);
        if (!bodies.length) return;
        const pos = (m: Mirror) => { const e = m.obj.matrixWorld.elements; return [e[12], e[13], e[14]]; };
        for (const m of this.mirrors) {
            const jn = PARTS[m.inst.name];
            if (!jn || m.on) continue;
            const p = pos(m);
            let best: Mirror | null = null, bd = 400 * 400;
            for (const b of bodies) { const q = pos(b), d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = b; } }
            if (!best) continue;
            const j = best.inst.modelData.bmd.jnt1.joints.findIndex((x) => x.name === jn);
            if (j >= 0) m.on = { m: best, joint: j };
        }
    }
    /** whether the stage's Peach holds her parasol (the viewer gave her the parasol part) */
    private peachParasol = false;

    private makeInstance(spec0: Spec): J3DModelInstanceSimple | null {
        const spec = this.gameSpec(spec0);
        const data = this.modelData(spec.f);
        if (!data) return null;
        const m = new J3DModelInstanceSimple(data);
        m.name = spec.f;
        m.passMask = SMSPass.MAIN;
        if (spec.bmt) { const t = this.materialTable(spec.bmt, !!spec.tex); if (t) m.setModelMaterialData(t); }
        const base = spec.f.replace(/\.(bmd|bdl)$/, '');
        // (the Chain Chomp's colours are the viewer's: its heat, then gold once cooled)
        const btk = this.files.get(base + '.btk'), brk = spec.f.startsWith('bwanwan/') ? null : this.files.get(base + '.brk');
        try { if (btk) m.bindTTK1(BTK.parse(btk.buffer)); if (brk) m.bindTRK1(BRK.parse(brk.buffer)); } catch { }
        if (spec.bck) { const f = this.files.get(spec.bck); try { if (f) m.bindANK1(BCK.parse(f.buffer)); } catch { } }
        return m;
    }

    /**
     * The viewer's objects group (loadObjects), each frame: every object in it cloned from a
     * library model the disc has (userData.mi, its library index; mp: where each comes from) has
     * the game's model follow it, and its own meshes are drawn into depth only. Objects the
     * viewer adds later (thrown bombs, a Shine's copy) are picked up; removed ones dropped.
     */
    private syncGroup(group: any, mp: Record<string, Spec>) {
        this.peachParasol = Object.values(mp || {}).some((sp) => sp && /^peach\/peach_parasol\.bmd$/.test(sp.f));
        const r = this.renderer!;
        if (this.boundGroup !== group) {
            this.dropMirrors(this.mirrors);
            this.mirrors = []; this.byObj.clear(); this.actorModels = [];
            this.boundGroup = group;
        }
        if (!group) return;
        const seen = new Set<any>(), made: J3DModelInstanceSimple[] = [];
        group.traverse((o: any) => {
            const key = o.userData && o.userData.mi;
            if (key === undefined || key === null) return;
            seen.add(o);
            if (this.byObj.has(o)) return;
            const list = this.mirror(o, String(key), mp);
            this.byObj.set(o, list);
            for (const m of list) { this.mirrors.push(m); made.push(m.inst); if (m.actor) this.actorModels.push(m.inst); }
        });
        if (made.length) this.attachNpcParts();
        if (made.length) {
            const cache = r.renderHelper.renderInstManager.gfxRenderCache;
            setAmbient(made.filter((m) => (m as any).isPlayer), r.objectAmbient);
            swapTextures(this.device, cache, r.rarc, made);
            r.modelInstances.push(...made);
        }
        if (this.byObj.size > seen.size) {
            const gone: Mirror[] = [];
            for (const [o, list] of this.byObj) if (!seen.has(o)) { gone.push(...list); this.byObj.delete(o); }
            if (gone.length) {
                this.dropMirrors(gone);
                const g = new Set(gone);
                this.mirrors = this.mirrors.filter((m) => !g.has(m));
                const gi = new Set(gone.map((m) => m.inst));
                this.actorModels = this.actorModels.filter((m) => !gi.has(m));
            }
        }
    }

    private dropMirrors(list: Mirror[]) {
        if (!list.length) return;
        for (const m of list) for (const mat of m.proxied) mat.colorWrite = true;
        const r = this.renderer;
        if (!r) return;
        const drop = new Set<any>(list.map((m) => m.inst));
        r.modelInstances = r.modelInstances.filter((x) => !drop.has(x));
    }

    private mirror(o: any, key: string, mp: Record<string, Spec>): Mirror[] {
        const [base, variant] = key.split('_s');
        const spec = mp && mp[base];
        if (!spec || !spec.f) return [];
        const inst = this.makeInstance(spec);
        if (!inst) return [];
        const actor = !spec.f.startsWith('mapobj/');
        if (actor) (inst as any).isPlayer = true;   // (lit as TLightCommon lights objects, below)
        const mir: Mirror = { obj: o, inst, bones: null, mats: [], lift: spec.lift || 0, actor, proxied: [] };
        // Skinned (walking / idle) copies: the viewer's bones "m<i>_j<joint>".
        const bones: any[] = [];
        const re = new RegExp(`^m${base}_j(\\d+)$`);
        o.traverse((b: any) => { const k = b.name ? re.exec(b.name) : null; if (k) bones[+k[1]] = b; });
        if (bones.length) { mir.bones = bones; pinJoints(inst, () => mir.bones); }
        else if (/\/shine\.bmd$/.test(spec.f)) pinShineDemo(inst, o);
        if (variant !== undefined && spec.shrink) {
            const f = this.files.get(spec.shrink);
            const n = o.parent && o.parent.userData.variants ? o.parent.userData.variants.length : 1;
            try {
                if (f) {
                    const a = BCK.parse(f.buffer);
                    mir.pin = new PinnedAnimationController(30);
                    inst.bindANK1(a, mir.pin);
                    mir.pin.setTimeInFrames(n > 1 ? (a.duration * +variant) / (n - 1) : 0);
                }
            } catch { }
        }
        // Its own meshes: depth only from now on, and the TEV colours the viewer sets on them
        // (NPC colours, Boos, pictures, the Chomp's heat) copied by material name.
        o.traverse((x: any) => {
            if (!x.isMesh || ownerOf(x, o) !== o) return;
            for (const m of [].concat(x.material) as any[]) {
                mir.proxied.push(m);
                const nm = m.name || '', name = nm.slice(nm.indexOf(' ') + 1);
                const mi = inst.materialInstances.find((y) => y.name === name);
                if (mi) mir.mats.push({ m, mi, c: [] });
            }
        });
        // NPC colours and the pollution threshold (TBaseNPC::setIndividualDifference_, as the
        // viewer has them: loadObjects' npcColors on the body and each part, npcK0 on the body).
        if (o.userData.npcColors) for (const sp of o.userData.npcColors) npcColour(inst, sp);
        for (let p = o; p; p = p.parent) if (p.userData && p.userData.npcK0) {
            const k = p.userData.npcK0, c = { r: k[0] / 255, g: k[1] / 255, b: k[2] / 255, a: k[3] / 255 };
            for (const mi of inst.materialInstances) if (!/_eye_mat$/.test(mi.name)) mi.setColorOverride(ColorKind.K0, c);
            break;
        }
        const out = [mir];
        for (const [file, joint] of spec.parts || []) {
            const pi = this.makeInstance({ f: file });
            const j = inst.modelData.bmd.jnt1.joints.findIndex((x) => x.name === joint);
            if (!pi || j < 0) continue;
            if (actor) (pi as any).isPlayer = true;
            out.push({ obj: o, inst: pi, bones: null, mats: [], lift: 0, actor, on: { m: mir, joint: j }, proxied: [] });
        }
        return out;
    }

    private syncObjects() {
        const root = this.boundGroup;
        for (const mir of this.mirrors) {
            const o = mir.obj, inst = mir.inst;
            inst.visible = this.live && visibleIn(o, root);
            for (const m of mir.proxied) if (m.colorWrite !== !this.live) m.colorWrite = !this.live;
            if (!inst.visible) continue;
            if (mir.on) {
                mir.on.m.inst.calcAnim();
                mat4.copy(inst.modelMatrix, mir.on.m.inst.shapeInstanceState.jointToWorldMatrixArray[mir.on.joint]);
            } else {
                mat4.copy(inst.modelMatrix, o.matrixWorld.elements as any);
                if (mir.lift) { mat4.fromTranslation(_m, [0, mir.lift, 0]); mat4.mul(inst.modelMatrix, inst.modelMatrix, _m); }
            }
            for (const e of mir.mats) {
                const m = e.m;
                const sets: [number[][] | undefined, ColorKind[]][] = [[m.gxRegs, REG_KINDS], [m.gxKRegs, K_KINDS], [m.gxMatC, MAT_KINDS]];
                let n = 0;
                for (const [vals, kinds] of sets) {
                    if (!vals) { n += kinds.length; continue; }
                    for (let i = 0; i < kinds.length; i++, n++) {
                        if (!vals[i]) continue;
                        const c = e.c[n] || (e.c[n] = { r: 1, g: 1, b: 1, a: 1 });
                        setColor(c, vals[i]);
                        e.mi.setColorOverride(kinds[i], c);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ the game code's objects
    /**
     * Runs the stage's game code to the viewer's time and draws what it moves with the disc's
     * models at their animation frames; the viewer's own stand-ins for those objects (the same
     * class at the same placement) are hidden.
     */
    /**
     * Runs the stage's game code to the viewer's time ahead of the viewer posing Mario (so the input
     * replay's Mario, SimRunner.history, is there for this frame); render() does it otherwise.
     */
    public advanceSim(inp: SimInput | null) {
        const r = this.renderer;
        if (!inp || !this.sim || !r || !this.live) return;
        if (!this.simFiles) this.simFiles = fileMap(r.rarc);
        this.sim.update(this.scene, this.simFiles, inp);
    }

    private syncSim(inp: SimInput | null, group: any) {
        const r = this.renderer;
        const on = !!(inp && this.sim && r);
        if (on) {
            if (!this.simFiles) this.simFiles = fileMap(r!.rarc);
            this.sim!.update(this.scene, this.simFiles, inp!);
        }
        const st = on ? this.sim!.stage : null;
        const list = st ? this.sim!.drawables() : [];
        if (st) this.syncGoop(st);
        else if (this.goop) for (const g of this.goop.insts) if (g) g.visible = false;
        // the viewer's stand-ins
        this.simPlaces.clear();
        for (const d of list) this.simPlaces.add(d.type + '|' + d.place.map((v) => v.toFixed(1)).join(','));
        if (group) for (const o of group.children) {
            const b = o.userData && o.userData.base;
            if (!b || !o.userData.type || !CLASSES.has(o.userData.type)) continue;
            const k = o.userData.type + '|' + b.p.map((v: number) => v.toFixed(1)).join(',');
            // (the viewer's Chain Chomp keeps its stake and chain links as separate nodes)
            const bw = o.userData.bw, parts: any[] = bw ? [bw.pkNode, ...(bw.links || [])].filter(Boolean) : [];
            if (st && this.simPlaces.has(k)) { o.visible = false; o.userData.simHidden = true; for (const p of parts) p.visible = false; }
            else if (o.userData.simHidden) { o.visible = true; o.userData.simHidden = false; for (const p of parts) p.visible = true; }
        }
        // the game's models
        const seen = new Set<LiveActor>();
        const made: J3DModelInstanceSimple[] = [];
        for (const d of list) {
            const a = d.a;
            seen.add(a);
            let m = this.simMirrors.get(a);
            // (nozzle boxes switch models; a buried object drops its own)
            if (m && (m as any).model !== a.mactor!.model) { m.inst.visible = false; this.simMirrors.delete(a); m = undefined; }
            if (!m) {
                const inst = this.makeInstance({ f: a.mactor!.model, bmt: a.mactor!.bmt || undefined } as any);
                if (!inst) continue;
                (inst as any).isPlayer = true;
                m = { inst, bck: '', pin: new PinnedAnimationController(30) };
                (m as any).model = a.mactor!.model; (m as any).mactor = a.mactor;
                const mm = m;
                // TPakkun's root joints swell with the water in it (PakkunRootCallback / 2)
                inst.jointMatrixCalcCallback = (dst: mat4, _md: any, j: number, parent: ReadonlyMat4) => {
                    // the game's own joint calc (TBossPakkunMtxCalc: motion blend, belly, head), worked out by the sim
                    // TFireWanwanTailNode::setBarAnmMtx: tail_null1's matrix set outright (the next link's place)
                    const bar = (a as any).barMtx as number[] | undefined;
                    if (bar && _md.bmd.jnt1.joints[j] && _md.bmd.jnt1.joints[j].name === 'tail_null1') {
                        const w = mat4.fromValues(bar[0], bar[4], bar[8], 0, bar[1], bar[5], bar[9], 0, bar[2], bar[6], bar[10], 0, bar[3], bar[7], bar[11], 1);
                        const inv = mat4.invert(mat4.create(), parent);
                        if (inv) { mat4.mul(dst, inv, w); return; }
                    }
                    const L = (a as any).locals as mat4[] | undefined;
                    if (L && L[j] && (a as any).mactor === (mm as any).mactor) { mat4.copy(dst, L[j]); return; }
                    const sc = (a as any).rootScale ? (a as any).rootScale() : 1;
                    if (sc === 1) return;
                    if (j === 1) mat4.scale(dst, dst, [sc, sc, sc]);
                    else if (j === 2) mat4.scale(dst, dst, [1 / sc, 1 / sc, 1 / sc]);
                };
                if ((a as any).fadeColor) booMaterials(inst);
                this.simMirrors.set(a, mm);
                made.push(inst);
                this.actorModels.push(inst);
            }
            const inst = m.inst;
            inst.visible = this.live && a.drawn();
            if (!inst.visible) continue;
            const B = a.baseTR, sc = a.scale;
            mat4.set(inst.modelMatrix, B[0] * sc.x, B[4] * sc.x, B[8] * sc.x, 0, B[1] * sc.y, B[5] * sc.y, B[9] * sc.y, 0, B[2] * sc.z, B[6] * sc.z, B[10] * sc.z, 0, B[3], B[7], B[11], 1);
            // Boos (TTelesa): KCOLOR0 on every material is the fade colour (its alpha how visible),
            // the body's TEVREG0 the base colour (SMS_InitPacket_OneTevKColor / OneTevColorAndOneTevKColor)
            const fade = (a as any).fadeColor as number[] | undefined;
            if (fade) {
                const base = (a as any).baseColor as number[];
                const k = { r: fade[0] / 255, g: fade[1] / 255, b: fade[2] / 255, a: fade[3] / 255 };
                for (const mi of inst.materialInstances) {
                    mi.setColorOverride(ColorKind.K0, k);
                    if (mi.name === '_mat_body' && base) mi.setColorOverride(ColorKind.C0, { r: base[0] / 255, g: base[1] / 255, b: base[2] / 255, a: base[3] / 255 });
                }
            }
            // TEVREG0 the game code sets (GXColorS10): the Fire Chomps' body and tail colour
            const tc = (a as any).tevColor0 as number[] | undefined;
            if (tc) {
                // (a material by name, else by index: SMS_InitPacket_OneTevColor's material)
                const only = (a as any).tevColorMaterial as string | undefined, idx = ((a as any).tevColorMaterialIndex as number | undefined) ?? 0;
                const c = { r: tc[0] / 255, g: tc[1] / 255, b: tc[2] / 255, a: tc[3] / 255 };
                inst.materialInstances.forEach((mi, i) => { if (only ? mi.name === only : i === idx) mi.setColorOverride(ColorKind.C0, c); });
            }
            const name = a.mactor!.bckName();
            if (name !== m.bck) {
                m.bck = name || '';
                const f = name ? this.files.get((a.mactor!.data.folder + '/' + name + '.bck').toLowerCase()) : null;
                try { if (f) inst.bindANK1(BCK.parse(f.buffer), m.pin); else inst.bindANK1(null as any); } catch { }
            }
            const fc = a.mactor!.getFrameCtrl(0);
            if (fc) m.pin.setTimeInFrames(fc.frame);
            // its material animations (BPK / BTP / BTK / BRK) at the game's frames
            const st = a.mactor!.anmState();
            const mm = m as any;
            if (!mm.mat) mm.mat = [null, '', '', '', '', ''].map(() => ({ name: '', pin: new PinnedAnimationController(30) }));
            for (const t of [1, 2, 3, 4]) {
                const cur = st[t];
                if (!cur) continue;
                const slot = mm.mat[t];
                if (cur.name !== slot.name) {
                    slot.name = cur.name;
                    const f = this.files.get((a.mactor!.data.folder + '/' + cur.name + ['', '.bpk', '.btp', '.btk', '.brk'][t]).toLowerCase());
                    try {
                        if (f) {
                            if (t === 1) inst.bindTRK1(BPK.parse(f.buffer), slot.pin);
                            else if (t === 2) inst.bindTPT1(BTP.parse(f.buffer), slot.pin);
                            else if (t === 3) inst.bindTTK1(BTK.parse(f.buffer), slot.pin);
                            else inst.bindTRK1(BRK.parse(f.buffer), slot.pin);
                        }
                    } catch { }
                }
                slot.pin.setTimeInFrames(cur.frame);
            }
        }
        if (made.length) {
            swapTextures(this.device, r!.renderHelper.renderInstManager.gfxRenderCache, r!.rarc, made);
            r!.modelInstances.push(...made);
        }
        for (const [a, m] of this.simMirrors) if (!seen.has(a)) m.inst.visible = false;
    }

    /**
     * The goop as the stage's game code leaves it: each pollution layer's model drawn with its own
     * materials and animations, its texture 0 the layer's goop map (mPollutionMap, GX I8 tiles),
     * re-sent after every simulated frame.
     */
    private syncGoop(st: any) {
        const P = st.world.pollution;
        if (!P) return;
        if (!this.goop || this.goop.stage !== st) {
            if (this.goop) for (const g of this.goop.insts) if (g) g.visible = false;
            const made: J3DModelInstanceSimple[] = [];
            const insts = P.layers.map((L: any) => {
                if (L.planeType === 6) return null;
                const inst = this.makeInstance({ f: `map/pollution/${L.name}.bmd` });
                if (inst) made.push(inst);
                return inst;
            });
            if (made.length) { swapTextures(this.device, this.renderer!.renderHelper.renderInstManager.gfxRenderCache, this.renderer!.rarc, made); this.renderer!.modelInstances.push(...made); }
            this.goop = { stage: st, frame: -1, insts };
        }
        const G = this.goop;
        for (const g of G.insts) if (g) g.visible = this.live;
        if (G.frame === st.frame) return;
        G.frame = st.frame;
        P.layers.forEach((L: any, i: number) => {
            const inst = G.insts[i];
            if (!inst || !L.map) return;
            const tex = ((inst as any).tex1Data || (inst as any).modelMaterialData?.tex1Data);
            const gfx = tex && (tex as any).gfxTextures ? (tex as any).gfxTextures[0] : null;
            if (!gfx) return;
            const w = 1 << L.pos.lw, h = 1 << L.pos.lh;
            const rgba = new Uint8Array(w * h * 4), m = L.map as Uint8Array;
            // I8: 8x4 texel blocks
            let o = 0;
            for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 8)
                for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++, o++) {
                    const d = ((by + y) * w + bx + x) * 4, v = m[o];
                    rgba[d] = rgba[d + 1] = rgba[d + 2] = rgba[d + 3] = v;
                }
            try { this.device.uploadTextureData(gfx, 0, [rgba]); } catch { }
        });
    }

    /**
     * The stage's opening camera (TMarDirector's STATE_UNK1: gpCamera->startDemoCamera("startcamera"),
     * map/camera/startcamera.bck): TCameraBck reads its joint 0 as the look point and joint 1, under
     * it, as the camera, joint 1's Y scale as the field of view; 2 BCK frames a game frame. At QF
     * q from the demo's start: the view, or null past its end (or with no such file).
     */
    public introCamera(q: number): { pos: number[]; at: number[]; fov: number; frames: number } | null {
        if (this.introBck === undefined) {
            const f = this.files.get('map/camera/startcamera.bck');
            try { this.introBck = f ? BCK.parse(f.buffer) : null; } catch { this.introBck = null; }
        }
        const A = this.introBck;
        if (!A || A.jointAnimationEntries.length < 2) return null;
        const frame = q / 2;
        if (frame > A.duration) return null;
        const t0 = new JointTransformInfo(), t1 = new JointTransformInfo();
        calcANK1JointAnimationTransform(t0, A.jointAnimationEntries[0], frame, frame + 1);
        calcANK1JointAnimationTransform(t1, A.jointAnimationEntries[1], frame, frame + 1);
        const m0 = mat4.fromRotationTranslationScale(mat4.create(), t0.rotation, t0.translation, t0.scale);
        const m1 = mat4.fromRotationTranslationScale(mat4.create(), t1.rotation, t1.translation, [1, 1, 1]);
        const p = mat4.mul(mat4.create(), m0, m1);
        return { pos: [p[12], p[13], p[14]], at: [m0[12], m0[13], m0[14]], fov: t1.scale[1], frames: A.duration };
    }
    private introBck: any = undefined;

    /** For the console and tests: what the layer draws for the viewer's objects. */
    public debug() {
        return this.mirrors.map((m) => ({ f: m.inst.name, vis: m.inst.visible, node: m.obj.name || m.obj.type, mi: m.obj.userData.mi,
            pos: [m.inst.modelMatrix[12], m.inst.modelMatrix[13], m.inst.modelMatrix[14]].map(Math.round), bones: !!m.bones }));
    }

    private lights() {
        const vm = this.camera.viewMatrix;
        const marios = [...this.marios.values()].flatMap((m) => m.models);
        if (this.playerSun) setPlayerLights(marios, this.playerSun, vm);
        if (this.objectSun && this.actorModels.length) setPlayerLights(this.actorModels, this.objectSun, vm);
        // TODO: the specular light (GX_LIGHT2, TLightCommon::setLight: GXInitSpecularDir toward the
        // sun, GXInitLightShininess(50)) with Dolphin's lighting maths (gx_material.ts, now as
        // LightingShaderGen has it: distance attenuation normalised when the channel has a diffuse
        // function, as these SPEC channels do) lights most of the side facing the sun full white,
        // which the game doesn't do. Something about it is still missing; off until it's found.
        for (const m of marios) { const l = m.getGXLightReference(2); l.Color.r = l.Color.g = l.Color.b = 0; }
        for (const m of this.actorModels) { const l = m.getGXLightReference(2); l.Color.r = l.Color.g = l.Color.b = 0; }
    }

    /** Off: the viewer's own meshes draw in colour again. */
    public setLive(on: boolean) {
        if (this.live === on) return;
        this.live = on;
        for (const mir of this.mirrors) for (const m of mir.proxied) m.colorWrite = !on;
        if (!on) { for (const m of this.proxiedMario) m.colorWrite = true; this.proxiedMario.clear(); }
    }

    /** Copy what the layer drew into a three.js texture (the viewer's screen copies for water and effects). */
    public copyInto(gl: WebGL2RenderingContext, at: number[] | null = null) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        // (at: [x, y] in the texture, GL's y up: one half of the comparison view into its place)
        if (at) gl.texSubImage2D(gl.TEXTURE_2D, 0, at[0], at[1], gl.RGB, gl.UNSIGNED_BYTE, this.canvas);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    // ------------------------------------------------------------ drawing
    /**
     * Draw the frame: cam is the viewer's three.js camera (matrixWorld, fov in degrees, aspect,
     * near/far), w x h the drawing buffer's size, marios the posed Marios on the stage
     * [{ key, rig, yoshi }]. Call after the viewer has placed everything and updated its world matrices.
     */
    public render(cam: any, w: number, h: number, group: any, mp: Record<string, Spec>, marios: { key: any; rig: any; yoshi: any }[], timeMs: number, sim: SimInput | null = null) {
        const r = this.renderer;
        const canvas = this.canvas;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (!r) return false;
        this.setLive(true);
        this.syncGroup(group, mp);
        const seen = new Set<any>();
        for (const mo of marios) {
            if (!mo.rig) continue;
            let mm = this.marios.get(mo.key);
            if (!mm) { mm = new MarioMirror(this, r); this.marios.set(mo.key, mm); }
            mm.sync(mo.rig, mo.yoshi);
            seen.add(mo.key);
            const proxy = (root: any) => root && root.traverse((x: any) => { if (x.isMesh) for (const m of [].concat(x.material) as any[]) { if (m.colorWrite) m.colorWrite = false; this.proxiedMario.add(m); } });
            proxy(mo.rig.root);
            if (mo.yoshi) proxy(mo.yoshi.root);
        }
        for (const [k, mm] of this.marios) if (!seen.has(k)) {
            const drop = new Set<any>(mm.models);
            r.modelInstances = r.modelInstances.filter((x) => !drop.has(x));
            this.marios.delete(k);
        }
        this.syncSim(sim, group);
        this.syncObjects();
        mat4.copy(this.camera.worldMatrix, cam.matrixWorld.elements);
        this.camera.worldMatrixUpdated();
        this.camera.fovY = (cam.fov * Math.PI) / 180;
        this.camera.aspect = cam.aspect;
        this.camera.setClipPlanes(cam.near, cam.far);
        const vi = this.viewerInput;
        vi.time = timeMs; vi.deltaTime = 16; vi.backbufferWidth = w; vi.backbufferHeight = h;
        this.swapChain.configureSwapChain(w, h);
        this.device.beginFrame();
        vi.onscreenTexture = this.swapChain.getOnscreenTexture();
        r.render(this.device, vi);
        this.device.endFrame();
        this.drawn = true;
        return true;
    }
}

/** One of the viewer's NPC colour specs ([material, mode, a, b, kind, c0, c1], tools/build_objects.py npc_colour): SMS_InitChangeNpcColor's registers. */
function npcColour(m: J3DModelInstanceSimple, sp: any[]) {
    const [mat, , , , kind, c0, c1] = sp;
    const mi = m.materialInstances.find((x) => x.name === mat || mat.endsWith(x.name));
    if (!mi || kind === undefined) return;
    const c = (v: number[]) => ({ r: v[0] / 255, g: v[1] / 255, b: v[2] / 255, a: 1 });
    if (kind === 0 && c0) mi.setColorOverride(ColorKind.MAT0, c(c0));
    else if (kind === 1 && c0) mi.setColorOverride(ColorKind.C0, c(c0));
    else if (kind === 2) { if (c0) mi.setColorOverride(ColorKind.C1, c(c0)); if (c1) mi.setColorOverride(ColorKind.C2, c(c1)); }
}

/** The tagged object (userData.mi) a mesh belongs to: the nearest one up its parents. */
function ownerOf(x: any, root: any) {
    for (let p = x; p; p = p.parent) { if (p === root) return root; if (p.userData && p.userData.mi !== undefined && p.userData.mi !== null) return p; }
    return null;
}

function listFiles(arc: RARC.JKRArchive): Map<string, RARC.RARCFile> {
    const out = new Map<string, RARC.RARCFile>();
    const walk = (d: RARC.RARCDir, prefix: string) => {
        for (const f of d.files) out.set((prefix + f.name).toLowerCase(), f);
        for (const s of d.subdirs) if (s.name !== '.' && s.name !== '..') walk(s, prefix + s.name + '/');
    };
    walk(arc.root, '');
    return out;
}

function findLight(r: SunshineRenderer, name: string) {
    let found: any = null;
    const walk = (o: any) => { if (found) return; if (o.type === 'Group') o.children.forEach(walk); else if (o.type === 'Light' && o.name === name) found = o; };
    if (r.sceneBin) walk(r.sceneBin);
    return found;
}

/** GXSetChanAmbColor(GX_COLOR0A0, …): the light group's ambient colour on the models' materials. */
function setAmbient(models: J3DModelInstanceSimple[], amb: { r: number, g: number, b: number, a: number } | null) {
    if (!amb) return;
    for (const m of models)
        m.modelMaterialData.materialData?.forEach((md: any) => { md.material.colorAmbRegs[0] = { r: amb.r / 255, g: amb.g / 255, b: amb.b / 255, a: amb.a / 255 }; });
}

(window as any).GameLayer = GameLayer;
(window as any).GameDisc = { openDisc, openFolder, rememberHandle, rememberedHandle, forgetHandle };
(window as any).V1Data = V1Data;
