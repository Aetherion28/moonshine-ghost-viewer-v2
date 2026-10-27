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
import { PlayerMario } from './game/player/player.js';
import { GameFS, openDisc, openFolder, rememberHandle, rememberedHandle, forgetHandle } from './disc.js';
import { parseStageArc, sceneForRoute } from './stagearc.js';
import { SMSPass, SunshineRenderer, SunshineSceneDesc } from './sms_scene.js';
import { MarioModel, YoshiModel, parseArchive, setPlayerLights } from './mario.js';
import { swapTextures, npcDress, npcPartColours, npcGoop } from './actors.js';
import { SimRunner, LiveRunner, DiscCommon, SimInput, fileMap, FileMap } from './game/runner.js';
import { WireDraw, WireLine } from './wiredraw.js';
import { MantaShadowQuads, mantaVolumeMaterials, setMantaVolumeAlpha } from './mantashadow.js';
import { MarioShadow } from './marioshadow.js';
import { BossMantaManager } from './game/enemies/bossmanta.js';
import { MapWireConst } from './game/mapwire.js';
import { CLASSES } from './game/scene.js';
import { LiveActor, MActor } from './game/engine.js';
import { Mtx } from './game/math.js';
import { ModelGate } from './game/mapobj/modelgate.js';
import { ShiningStone } from './game/mapobj/mamma.js';
import { BathWaterManager } from './game/bathwater.js';
import { mapJoints, MapJointModel, pollutionJoints } from './game/mapevent.js';
import { calcANK1JointAnimationTransform } from '../noclip/Common/JSYSTEM/J3D/J3DGraphAnimator.js';
import { JointTransformInfo } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { V1Data } from './v1data/index.js';
import { ThpPlayer } from './movie/player.js';
import { GfxFormat, GfxTexture, makeTextureDescriptor2D } from './../noclip/gfx/platform/GfxPlatform.js';

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
            // (shape 4, the cap on the body model, is never drawn: initModel's onFlag(J3DShpFlag_Visible);
            // TMarioCap's ma_cap1 / ma_cap3 are drawn in its place)
            if (rig.capModel !== undefined && M.body.shapeInstances[4]) M.body.setShapeVisible(4, false);
            M.setEyes(typeof rig.eyeTex === 'number' ? rig.eyeTex : null);   // (the viewer's marioEyes: asleep, waking)
            const part = (m: J3DModelInstanceSimple | null, node: any) => {
                if (!m) return;
                m.visible = !!node && worldVisible(node);
                if (m.visible) mat4.copy(m.modelMatrix, node.matrixWorld.elements as any);
            };
            for (const [k, m] of Object.entries(M.hands)) part(m, rig.parts[`hand_${k[0]}_${k[1]}`]);
            part(M.cap, rig.parts.cap);
            // TMarioCap::perform: the cap (ma_cap1) while E_CAP_MODEL_HAT is on, else his hair (ma_cap3),
            // both on M_head; the diving helmet (E_CAP_MODEL_HELMET) on jnt_head (rig.capModel: the
            // live sim's TMarioCap::unk4; undefined for a ghost: the cap as the viewer shows it)
            const cm = rig.capModel as number | undefined;
            if (cm !== undefined && M.cap && M.cap.visible && !(cm & 1)) M.cap.visible = false;
            if (M.capless) { part(M.capless, rig.parts.cap); if (cm === undefined || (cm & 1)) M.capless.visible = false; }
            if (M.helmet) {
                const j = M.jointIndex('jnt_head'), b = rig.bones && j >= 0 ? rig.bones[j] : null;
                M.helmet.visible = cm !== undefined && !!(cm & 2) && !!b;
                if (M.helmet.visible) mat4.copy(M.helmet.modelMatrix, b.matrixWorld.elements as any);
            }
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
    /**
     * The game's interlaced (480i) copy filter (copyfilter.ts). Off by default: most runners play
     * in progressive scan (480p), where the game's filter is no blur.
     */
    public copyFilter = false;
    /** The specular light (GX_LIGHT2) on Mario and the actors; see lights(). */
    public specular = false;
    /** A frame has been drawn for the current scene. */
    public drawn = false;
    /** The stage's game code (the enemies...), run alongside the ghost. */
    public sim: SimRunner | null = null;
    private simFiles: FileMap | null = null;
    private simMirrors = new Map<LiveActor, SimMirror>();
    private simPlaces = new Set<string>();
    /** the goop layers' models (TPollutionLayer: map/pollution/pollutionNN.bmd, texture 0 the goop map) */
    private goop: { stage: any; frame: number; insts: (J3DModelInstanceSimple | null)[]; bufs: { last: Uint8Array; rgba: Uint8Array; sent: boolean }[] } | null = null;

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
        this.ghostSim = null;
    }

    /**
     * The hidden gamepad mode: sim becomes a LiveRunner (the stage played live from a pad, no ghost)
     * while on; off puts the ghost's SimRunner back. Returns the live runner (null when off / no disc).
     */
    private ghostSim: SimRunner | null = null;
    public setLivePlay(on: boolean): LiveRunner | null {
        if (!this.common) return null;
        const cur = this.sim instanceof LiveRunner;
        if (on && !cur) { this.ghostSim = this.sim; this.sim = new LiveRunner(this.common); }
        else if (!on && cur) { this.sim = this.ghostSim || new SimRunner(this.common); this.ghostSim = null; }
        return this.sim instanceof LiveRunner ? this.sim : null;
    }

    public sceneFor(area: number, episode: number) { return sceneForRoute(this.stageTable, area, episode); }
    public hasScene(name: string) { return !!this.fs && this.fs.has(`data/scene/${name}.szs`); }

    private prefetched = new Map<string, Promise<ArrayBuffer>>();
    /** Read a scene archive ahead of loadScene (the next stage of a replay or a live run, during the stage before) */
    public prefetchScene(name: string | null) {
        const fs = this.fs;
        if (!fs || !name || name === this.scene || name === this.loading || this.prefetched.has(name) || !this.hasScene(name)) return;
        if (this.prefetched.size >= 3) this.prefetched.delete(this.prefetched.keys().next().value as string);
        const p = fs.read(`data/scene/${name}.szs`);
        p.catch(() => this.prefetched.delete(name));
        this.prefetched.set(name, p);
    }
    /** Load a scene archive (e.g. "dolpic0"); resolves once it is the one drawn (or another was asked for). */
    public async loadScene(name: string) {
        const fs = this.fs;
        if (!fs || name === this.scene || name === this.loading) return;
        if (!this.hasScene(name)) { this.destroyScene(); this.scene = name; return; }
        this.loading = name;
        this.onStatus(`Loading ${name} from the disc…`);
        try {
            const pre = this.prefetched.get(name);
            this.prefetched.delete(name);
            const buf = pre ? await pre : await fs.read(`data/scene/${name}.szs`);
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
            // (a WireDraw per scene: its program and vertex layout live in this renderer's cache, which
            // goes with the scene; one kept from the stage before drew nothing on the next)
            const wd = this.wireDraw = new WireDraw();
            const mq = this.mantaQuads = new MantaShadowQuads();
            r.extraMain = (dev, rim, vi) => {
                if (!this.live) return;
                wd.prepare(dev, rim, vi, this.wireLines());
                if (this.mantaColor && this.mantaDrawn) mq.prepare(dev, rim, vi, this.mantaColor);
                if (this.marioShadow) this.marioShadow.prepare(dev, rim, vi);
            };
            // Mario's shadow (marioshadow.ts: /common/shadowCircle.bmd and shadowCircleLow.bmd as volumes)
            this.marioShadow = null;
            const cf = this.common && this.common.common ? this.common.common.files : null;
            const hiF = cf ? cf.get('shadowcircle.bmd') : null, loF = cf ? cf.get('shadowcirclelow.bmd') : null;
            if (hiF && loF) try {
                const cache = r.renderHelper.renderInstManager.gfxRenderCache;
                const md = (f: any) => new J3DModelData(this.device, cache, BMD.parse(new ArrayBufferSlice(f.buffer as ArrayBuffer, f.byteOffset, f.byteLength)));
                this.marioShadow = new MarioShadow(md(hiF), md(loF), (m) => { m.passMask = SMSPass.MAIN; r.modelInstances.push(m); });
            } catch (e) { console.warn('[game layer] shadowCircle', e); }
            let la: any = null;
            const findAry = (o: any) => { if (la) return; if (o.type === 'Group') { if (o.klass === 'LightAry') la = o; else o.children.forEach(findAry); } };
            if (r.sceneBin) findAry(r.sceneBin);
            const l0 = la && la.children[0];
            this.shadowLight = l0 ? [l0.x, l0.y, l0.z] : null;
        } catch (e) { this.onError(e); }
        finally { if (this.loading === name) { this.loading = ''; this.onStatus(''); } }
    }

    private destroyScene() {
        if (this.renderer) { this.renderer.destroy(this.device); this.wireDraw.destroy(this.device); if (this.mantaQuads) this.mantaQuads.destroy(this.device); this.mantaQuads = null; }
        this.gateStop();
        for (const v of this.bmtCache.values()) if (v) v.destroy(this.device);
        this.setLive(false);
        this.renderer = null; this.scene = ''; this.mirrors = []; this.byObj.clear(); this.boundGroup = null; this.marios.clear();
        this.actorModels = []; this.fittingInsts = []; this.fittingFor = null; this.dataCache.clear(); this.bmtCache.clear(); this.files.clear();
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
            // (the page's own copy of the goop layer (scene.bin's Pollution: the layer's .bmd with its
            // starting map baked in) is left out: syncGoop draws the goop as the stage's game code leaves it)
            if (o.userData && o.userData.type === 'Pollution') {
                o.traverse((x: any) => { if (x.isMesh) for (const m of [].concat(x.material) as any[]) { if (m.colorWrite) m.colorWrite = false; this.proxiedMario.add(m); } });
                return;
            }
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
        const list = st ? [...this.sim!.drawables(), ...this.simModelDrawables(st)] : [];
        if (st) this.syncGoop(st);
        else if (this.goop) for (const g of this.goop.insts) if (g) g.visible = false;
        this.syncMapJoints(st);
        // the viewer's stand-ins
        this.simPlaces.clear();
        for (const d of list) this.simPlaces.add(d.type + '|' + d.place.map((v) => v.toFixed(1)).join(','));
        if (group) for (const o of group.children) {
            // the Bianco windmill's blocks (objparts.ts windmillBlocks: the viewer's stand-ins riding the
            // wheel): the sim makes the game's own (bigWindmillBlock, code-made: no scene place to match)
            if (o.userData && o.userData.move && o.userData.move.orbit) {
                if (st) { if (!o.userData.simHidden) { o.visible = false; o.userData.simHidden = true; } }
                else if (o.userData.simHidden) { o.visible = true; o.userData.simHidden = false; }
                continue;
            }
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
        // getMantaColor: the manager's colour (to the angry one over 15 draws once the battle's state is 2)
        const mm0 = st ? st.objects.find((o: any) => o instanceof BossMantaManager) as BossMantaManager | undefined : undefined;
        this.mantaColor = null; this.mantaDrawn = false;
        if (mm0 && mm0.saveParams) {
            if (mm0.battleState === 2 && this.mantaFrame !== st.frame) { this.mantaFrame = st.frame; mm0.unk84 = Math.min(15, mm0.unk84 + 1); }
            const P: any = mm0.MP, t = mm0.unk84 / 15, L = (a: number, b: number) => Math.trunc((1 - t) * a + t * b) & 0xFF;
            this.mantaColor = [L(P.mSLMantaRed, P.mSLAngryMantaRed), L(P.mSLMantaGreen, P.mSLAngryMantaGreen), L(P.mSLMantaBlue, P.mSLAngryMantaBlue), L(P.mSLMantaAlpha, P.mSLAngryMantaAlpha)];
        }
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
                // an NPC: its colours and the parts on its joints (TBaseNPC::setIndividualDifference_)
                const look = (a as any).look, kind = (a as any).kindIndex;
                if (look && kind !== undefined) {
                    const parts: { inst: J3DModelInstanceSimple; joint: number }[] = [];
                    for (const p of npcDress(inst, kind, look)) {
                        const path = [...this.files.keys()].find((k) => k.endsWith('/' + p.file.toLowerCase()));
                        const pi = path ? this.makeInstance({ f: path } as any) : null;
                        if (!pi) continue;
                        (pi as any).isPlayer = true;
                        npcPartColours(pi, p.colors, p.idx);
                        const j = inst.modelData.bmd.jnt1.joints.findIndex((x) => x.name === p.joint);
                        parts.push({ inst: pi, joint: j < 0 ? 0 : j });
                        made.push(pi);
                        this.actorModels.push(pi);
                    }
                    (mm as any).parts = parts;
                }
                // the Phantamanta: its mesh as the shadow volume (mantashadow.ts): this instance its back
                // faces, a twin on the same pose its front faces
                if ((a as any).shadowOnly) {
                    mantaVolumeMaterials(inst, true);
                    const tw = new J3DModelInstanceSimple(inst.modelData);
                    tw.passMask = inst.passMask; (tw as any).isPlayer = true;
                    mantaVolumeMaterials(tw, false);
                    (mm as any).twin = tw;
                    made.push(tw); this.actorModels.push(tw);
                }
                this.simMirrors.set(a, mm);
                made.push(inst);
                this.actorModels.push(inst);
            }
            const inst = m.inst;
            inst.visible = this.live && a.drawn();
            const twin = (m as any).twin as J3DModelInstanceSimple | undefined;
            if (twin) twin.visible = inst.visible;
            const parts = (m as any).parts as { inst: J3DModelInstanceSimple; joint: number }[] | undefined;
            if (parts) for (const p of parts) p.inst.visible = inst.visible;
            if (!inst.visible) continue;
            const B = a.baseTR, sc = a.scale;
            mat4.set(inst.modelMatrix, B[0] * sc.x, B[4] * sc.x, B[8] * sc.x, 0, B[1] * sc.y, B[5] * sc.y, B[9] * sc.y, 0, B[2] * sc.z, B[6] * sc.z, B[10] * sc.z, 0, B[3], B[7], B[11], 1);
            if (twin && this.mantaColor) {
                mat4.copy(twin.modelMatrix, inst.modelMatrix);
                const ka = this.mantaColor[3] / 255;
                setMantaVolumeAlpha(inst, ka); setMantaVolumeAlpha(twin, ka);
                this.mantaDrawn = true;
            }
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
            if ((a as any).gateMovie) this.gateMovieOn(inst);
            // TEVREG1 (initPacketMatColor(GX_TEVREG1)): the surfing Blooper's colour, on every material
            const t1 = (a as any).tevColor1 as number[] | undefined;
            if (t1) { const c = { r: t1[0] / 255, g: t1[1] / 255, b: t1[2] / 255, a: t1[3] / 255 }; for (const mi of inst.materialInstances) mi.setColorOverride(ColorKind.C1, c); }
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
                try { const k = f ? BCK.parse(f.buffer) : null; inst.bindANK1(k as any, m.pin); if (twin) twin.bindANK1(k as any, m.pin); } catch { }
            }
            const fc = a.mactor!.getFrameCtrl(0);
            if (fc) m.pin.setTimeInFrames(fc.frame);
            // (an NPC's goop: KCOLOR0's alpha, as it's washed)
            const k0 = (a as any).look ? (a as any).unk174 as number[] : null;
            if (k0) npcGoop(inst, (a as any).kindIndex, k0);
            if (parts && parts.length) {
                inst.calcAnim();
                for (const p of parts) mat4.copy(p.inst.modelMatrix, inst.shapeInstanceState.jointToWorldMatrixArray[p.joint] || inst.modelMatrix);
            }
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
        for (const [a, m] of this.simMirrors) if (!seen.has(a)) { m.inst.visible = false; const ps = (m as any).parts; if (ps) for (const p of ps) p.inst.visible = false; }
    }

    /**
     * The game objects that keep their MActors themselves (not a LiveActor's mactor): each model
     * as a stand-in drawable for syncSim (its mactor, base matrix, scale and whether it's drawn),
     * made once per model so its mirror stays.
     *  - TModelGate ("JellyGate"): unk78 on its actor matrix, drawn while open (unk70 bit 0: perform returns before unk78->perform otherwise)
     *  - TShiningStone: the four coloured stones (unk68) and the stone (unk6C), on its base matrix, always performed
     */
    private simModelProxies = new WeakMap<MActor, LiveActor>();
    /** the posed Mario whose surf Blooper is drawn (rig.surfGesso: the viewer sets it in live play) */
    private surfRig: any = null;
    private surfBase: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    private surfClock = 0;
    private simModelDrawables(st: any): { a: LiveActor; type: string; place: [number, number, number] }[] {
        const out: { a: LiveActor; type: string; place: [number, number, number] }[] = [];
        const add = (o: any, m: MActor | null, base: Mtx, drawn: () => boolean) => {
            if (!m) return;
            let p = this.simModelProxies.get(m);
            if (!p) {
                p = { mactor: m, baseTR: base, scale: o.scale, drawn } as any as LiveActor;
                this.simModelProxies.set(m, p);
            }
            const n = st.nodeOf.get(o);
            out.push({ a: p, type: n ? n.type : '', place: [o.pos.x, o.pos.y, o.pos.z] });
        };
        // TMario's mSurfGesso (gpMapObjManager's surfgeso of that colour) on his base matrix while he
        // surfs (MarioDraw.cpp: checkStatusType(0x10000)); the viewer's posed Mario gives the matrix
        const sg = this.surfRig && this.surfRig.surfGesso;
        if (sg && sg.mactor) {
            const B = this.surfBase, e = this.surfRig.root.matrixWorld.elements;
            for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) B[r * 4 + c] = e[c * 4 + r];
            let p = this.simModelProxies.get(sg.mactor);
            if (!p) {
                const c1 = sg.unk154 as number[] | undefined;
                p = { mactor: sg.mactor, baseTR: B, scale: { x: 1, y: 1, z: 1 }, drawn: () => !!(this.surfRig && this.surfRig.surfGesso === sg), tevColor1: c1 } as any as LiveActor;
                this.simModelProxies.set(sg.mactor, p);
            }
            // (surfgeso_run1, run on: the item it came from is gone)
            const fc = sg.mactor.getFrameCtrl(0);
            if (fc) { const now = performance.now(); fc.frame = fc.end > 0 ? (fc.frame + Math.min(4, (now - this.surfClock) / (1000 / 30)) * 0.5) % fc.end : 0; this.surfClock = now; }
            out.push({ a: p, type: '', place: [sg.pos.x, sg.pos.y, sg.pos.z] });
        }
        for (const o of st.objects) {
            if (o instanceof ModelGate) { add(o, o.unk78, o.baseTR, () => !!(o.unk70 & 1)); const pp = o.unk78 && this.simModelProxies.get(o.unk78); if (pp) (pp as any).gateMovie = true; }
            else if (o instanceof ShiningStone) {
                for (const m of o.unk68) add(o, m, o.baseMtx, () => true);
                add(o, o.unk6C, o.baseMtx, () => true);
            }
        }
        return out;
    }

    /**
     * Corona's bath water surface for the viewer to draw (it draws the water): the mesh renderer's
     * height grid (BathWaterManager.getHeightMap) as triangles over its cell centres, the cells at
     * the far plane (no water over them) left out; with the flat renderer, the water's cap disc.
     * null without the bath water (or before the tub's set up).
     */
    public bathWaterSurface(): { positions: Float32Array; index: Uint32Array } | null {
        const st: any = this.live && this.sim ? this.sim.stage : null;
        if (!st) return null;
        const bw = st.objects.find((o: any) => o instanceof BathWaterManager) as BathWaterManager | undefined;
        if (!bw) return null;
        const hm = bw.getHeightMap();
        if (hm) {
            const { n, cell, origin, heights } = hm;
            const positions = new Float32Array(n * n * 3);
            let far = Infinity;
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) far = Math.min(far, heights[i * 128 + j]);
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
                const k = (i * n + j) * 3;
                positions[k] = origin.x + (i + 0.5) * cell; positions[k + 1] = heights[i * 128 + j] + origin.y; positions[k + 2] = origin.z + (j + 0.5) * cell;
            }
            const idx: number[] = [];
            const wet = (i: number, j: number) => heights[i * 128 + j] > far;
            for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < n; j++) {
                if (!wet(i, j) || !wet(i + 1, j) || !wet(i, j + 1) || !wet(i + 1, j + 1)) continue;
                const a = i * n + j, b = (i + 1) * n + j, c = i * n + j + 1, d = (i + 1) * n + j + 1;
                idx.push(a, c, b, b, c, d);
            }
            return { positions, index: Uint32Array.from(idx) };
        }
        const cap = bw.getCapDisc();
        if (!cap) return null;
        const N = 48, positions = new Float32Array((N + 1) * 3), idx: number[] = [];
        positions.set([cap.center.x, cap.center.y, cap.center.z]);
        for (let k = 0; k < N; k++) {
            const t = (k / N) * Math.PI * 2;
            positions.set([cap.center.x + Math.cos(t) * cap.radius, cap.center.y, cap.center.z + Math.sin(t) * cap.radius], (k + 1) * 3);
            idx.push(0, 1 + ((k + 1) % N), 1 + k);
        }
        return { positions, index: Uint32Array.from(idx) };
    }

    /** the map model's moved joints: the sim's MapJointModel it follows, and the version last applied */
    private mapMoved: { inst: J3DModelInstanceSimple; jm: MapJointModel | null; version: number; shapes: number[][] } | null = null;
    /**
     * map/map/map.bmd drawn with the stage's game code's joints (TJointModel / TJointObj, mapevent.ts's
     * MapJointModel): each joint's local matrix from its J3DTransformInfo (the J3DModel::calc the map
     * events trigger after setTransformInfo), and the shapes of a killed / asleep joint hidden
     * (TJointObj::kill / sleep set J3DShpFlag_Visible, i.e. hidden, on the shapes of the joint's own
     * mesh: getShapeInOneJoint walks J3DJoint::getMesh, the materials placed under that joint).
     * Without a simulated stage: the model's own joints and every shape shown.
     */
    private syncMapJoints(st: any) {
        const inst = this.renderer ? this.renderer.mapInstance : null;
        if (!inst) { this.mapMoved = null; return; }
        if (!this.mapMoved || this.mapMoved.inst !== inst) {
            const md = inst.modelData, shapes: number[][] = [];
            md.shapeData.forEach((sd, i) => {
                const j = md.materialJointIndices[sd.shape.materialIndex];
                if (j === undefined) return;
                (shapes[j] || (shapes[j] = [])).push(i);
            });
            this.mapMoved = { inst, jm: null, version: -1, shapes };
        }
        const mm = this.mapMoved;
        const jm = st && st.world ? mapJoints(st.world) : null;
        if (jm === mm.jm && (!jm || jm.version === mm.version)) return;
        mm.jm = jm; mm.version = jm ? jm.version : -1;
        if (!jm || !jm.joints.length) {
            inst.jointMatrixCalcCallback = null;
            for (const l of mm.shapes) if (l) for (const i of l) inst.setShapeVisible(i, true);
            return;
        }
        // (the local matrices once per change; the callback replaces the model's rest pose)
        const locals = jm.joints.map((_, j) => jm.jointLocal(j));
        inst.jointMatrixCalcCallback = (dst: mat4, _md: any, j: number) => { const L = locals[j]; if (L) mat4.copy(dst, L); };
        mm.shapes.forEach((l, j) => { if (l) { const v = jm.shownJoint(j); for (const i of l) inst.setShapeVisible(i, v); } });
    }

    /**
     * The goop as the stage's game code leaves it: each pollution layer's model drawn with its own
     * materials and animations, its texture 0 the layer's goop map (mPollutionMap, GX I8 tiles),
     * re-sent after every simulated frame.
     */
    /** for the page's debug readout: the goop layers and what's drawn of them */
    public goopDebug() {
        const st = this.sim ? (this.sim as any).stage : null, P = st && st.world ? st.world.pollution : null;
        const r = this.renderer;
        return {
            layers: P ? P.layers.map((L: any, i: number) => ({ name: L.name, plane: L.planeType, nz: L.map ? L.map.reduce((n: number, v: number) => n + (v ? 1 : 0), 0) : -1, inst: this.goop && this.goop.insts[i] ? this.goop.insts[i]!.visible : null })) : null,
            models: r ? r.modelInstances.filter((m: any) => /pollut|goop|osen/i.test((m.modelData && m.modelData.bmd && m.modelData.bmd.name) || m.name || '')).map((m: any) => [m.name || (m.modelData.bmd && m.modelData.bmd.name), m.visible]) : null,
        };
    }
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
            this.goop = { stage: st, frame: -1, insts, bufs: [] };
        }
        const G = this.goop;
        for (const g of G.insts) if (g) g.visible = this.live;
        // each layer's joints as its TJointModel leaves them (a killed joint's shapes hidden: Bianco's "reset" goop)
        P.layers.forEach((L: any, i: number) => {
            const inst = G.insts[i], jm = inst ? pollutionJoints(L) : null;
            if (!inst) return;
            const v = jm ? jm.version : -1;
            if ((inst as any)._goopJv === v) return;
            (inst as any)._goopJv = v;
            const md = inst.modelData;
            md.shapeData.forEach((sd, k) => {
                const j = md.materialJointIndices[sd.shape.materialIndex];
                inst.setShapeVisible(k, !jm || j === undefined || jm.shownJoint(j));
            });
        });
        if (G.frame === st.frame) return;
        G.frame = st.frame;
        P.layers.forEach((L: any, i: number) => {
            const inst = G.insts[i];
            if (!inst || !L.map) return;
            const tex = ((inst as any).tex1Data || (inst as any).modelMaterialData?.tex1Data);
            const gfx = tex && (tex as any).gfxTextures ? (tex as any).gfxTextures[0] : null;
            if (!gfx) return;
            const w = 1 << L.pos.lw, h = 1 << L.pos.lh, m = L.map as Uint8Array;
            // (only a layer whose texels changed since its last upload goes to the GPU again, from buffers kept per layer)
            const kept = G.bufs[i] && G.bufs[i].last.length === m.length ? G.bufs[i] : (G.bufs[i] = { last: new Uint8Array(m.length), rgba: new Uint8Array(w * h * 4), sent: false });
            if (kept.sent && sameBytes(kept.last, m)) return;
            kept.last.set(m); kept.sent = true;
            const rgba = kept.rgba;
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
        // What is known (graphics_findings.md): the game loads GX_LIGHT2 with the same light as
        // GX_LIGHT0 (TLightCommon::setLight: getLightColor/getLightPosition(index * 2), the sun),
        // as setPlayerLights does, and Mario's last TEV stage adds it as CPREV + lerp(C1, spec, 1/2)
        // - 1/2 (KCSEL_1_2, TEVBIAS_SUBHALF, C1 about 0.63), so with the light off Mario comes out
        // about 0.19 darker than the game everywhere; on, he and the NPCs wash out (a blue Pianta goes
        // nearly white). The footage is in between. layer.specular = true turns it on, for testing.
        if (this.specular) return;
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

    /**
     * Delfino Plaza's paint gates' view of where they go (TModelGate::perform's CUE_DRAW): the THP
     * movie TMarDirector::thpInit opens on that map (/data/ex128x144_q0.thp, looped), each frame's
     * Y, U and V planes as the gate model's textures 0, 1 and 2 (I8: Y full size, U and V half),
     * which its TEV turns back into colour (the planes as the THP's JPEG has them: full-range YCbCr).
     * Without the movie on the disc the gate keeps its own textures.
     */
    private gate: { player: ThpPlayer | null; shown: ImageBitmap | null; cx: CanvasRenderingContext2D | null; tex: GfxTexture[]; w: number; h: number; renderer: any } | null = null;
    private gateMovieOn(inst: J3DModelInstanceSimple) {
        const fs = this.fs;
        if (!fs) return;
        let G = this.gate;
        if (G && G.renderer !== this.renderer) { this.gateStop(); G = null; }
        if (!G) {
            const path = fs.list().find((p) => p.endsWith('ex128x144_q0.thp')) || null;
            G = this.gate = { player: path ? new ThpPlayer(fs as any, path, { audio: false }) : null, shown: null, cx: null, tex: [], w: 0, h: 0, renderer: this.renderer };
            if (G.player) void G.player.open();
        }
        const P = G.player;
        if (!P) return;
        if (P.state === 'ended' && P.info) { P.stop(); const path = (P as any).path; G.player = new ThpPlayer(this.fs as any, path, { audio: false }); void G.player.open(); return; }   // (THPPlayerPrepare's loop)
        const pic = P.picture();
        if (pic && pic !== G.shown) {
            G.shown = pic;
            const w = pic.width, h = pic.height;
            if (!G.cx || G.w !== w || G.h !== h) {
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                G.cx = c.getContext('2d', { willReadFrequently: true });
                for (const t of G.tex) this.device.destroyTexture(t);
                G.tex = [[w, h], [w >> 1, h >> 1], [w >> 1, h >> 1]].map(([tw, th]) => this.device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, tw, th, 1)));
                G.w = w; G.h = h;
            }
            const cx = G.cx!;
            cx.drawImage(pic, 0, 0);
            const px = cx.getImageData(0, 0, w, h).data, hw = w >> 1, hh = h >> 1;
            const Y = new Uint8Array(w * h * 4), U = new Uint8Array(hw * hh * 4), V = new Uint8Array(hw * hh * 4);
            for (let i = 0; i < w * h; i++) {
                const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
                const y = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b));
                Y[i * 4] = Y[i * 4 + 1] = Y[i * 4 + 2] = Y[i * 4 + 3] = y;
            }
            for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
                const i = ((y * 2) * w + x * 2) * 4, r = px[i], g = px[i + 1], b = px[i + 2], o = (y * hw + x) * 4;
                const u = Math.max(0, Math.min(255, -0.168736 * r - 0.331264 * g + 0.5 * b + 128)), v = Math.max(0, Math.min(255, 0.5 * r - 0.418688 * g - 0.081312 * b + 128));
                U[o] = U[o + 1] = U[o + 2] = U[o + 3] = u; V[o] = V[o + 1] = V[o + 2] = V[o + 3] = v;
            }
            this.device.uploadTextureData(G.tex[0], 0, [Y]); this.device.uploadTextureData(G.tex[1], 0, [U]); this.device.uploadTextureData(G.tex[2], 0, [V]);
        }
        if (G.tex.length === 3) {
            const M = inst.materialInstanceState.textureMappings;
            for (let k = 0; k < 3; k++) if (M[k] && M[k].gfxTexture !== G.tex[k]) { M[k].gfxTexture = G.tex[k]; (M[k] as any).width = k ? G.w >> 1 : G.w; (M[k] as any).height = k ? G.h >> 1 : G.h; }
        }
    }
    private gateStop() {
        const G = this.gate;
        if (!G) return;
        if (G.player) G.player.stop();
        for (const t of G.tex) this.device.destroyTexture(t);
        this.gate = null;
    }

    /** the Phantamanta's shadow: its full-screen passes, this frame's getMantaColor (null: no manta manager) and whether a manta's volume is drawn */
    private mantaQuads: MantaShadowQuads | null = null;
    /** Mario's shadow (TMBindShadowManager for the Marios) and the light group's first light's position */
    private marioShadow: MarioShadow | null = null;
    private shadowLight: number[] | null = null;
    private mantaColor: number[] | null = null;
    private mantaDrawn = false;
    private mantaFrame = -1;

    /** A joint's index in one of FLUDD's nozzle models (watergun2/<nozzle>/<nozzle>.bmd), -1 if none: the viewer turns it as TWaterGun's joint callbacks do. */
    private nozzleJoints = new Map<string, string[]>();
    public nozzleJoint(nozzle: string, joint: string): number {
        if (!this.marioArc) return -1;
        let names = this.nozzleJoints.get(nozzle);
        if (!names) {
            const f = this.marioArc.findFile(`watergun2/${nozzle}/${nozzle}.bmd`);
            try { names = f ? BMD.parse(f.buffer).jnt1.joints.map((j) => j.name) : []; } catch { names = []; }
            this.nozzleJoints.set(nozzle, names);
        }
        return names.indexOf(joint);
    }

    // ------------------------------------------------------------ the tightrope wires
    private wireDraw = new WireDraw();
    /** the stage the sim ran this frame (its wires are drawn), else null */
    private wireStage: any = null;
    /**
     * The viewer's wires for when the stage isn't simulated: each one's points as TMapWire::init
     * leaves them (start, the sagging points, end; x, y, z each).
     */
    public staticWires: number[][] = [];
    /** True while the layer draws the wires itself (the viewer's own are then left out). */
    public get drawsWires() { return this.live && !!this.renderer; }
    /** TMapWire's end fittings (/common/map/WireFitting.bmd at mStartFittingModel / mEndFittingModel's base matrices) */
    private fittingInsts: J3DModelInstanceSimple[] = [];
    private fittingFor: any = null;
    private syncFittings() {
        const r = this.renderer, M = this.wireStage && this.wireStage.world ? this.wireStage.world.mapWires : null;
        const want = this.live && r && M && M.wires.length ? M : null;
        if (want !== this.fittingFor) {
            this.fittingFor = want;
            for (const m of this.fittingInsts) m.visible = false;
            if (want && r && this.common && this.common.common) {
                const f = this.common.common.files.get('map/wirefitting.bmd');
                if (f) {
                    const cache = r.renderHelper.renderInstManager.gfxRenderCache;
                    let data: J3DModelData | null = (r as any)._fitData || null;
                    if (!data) try { data = (r as any)._fitData = new J3DModelData(this.device, cache, BMD.parse(new ArrayBufferSlice(f.buffer as ArrayBuffer, f.byteOffset, f.byteLength))); } catch (e) { console.warn('[game layer] WireFitting', e); }
                    const mats: Mtx[] = data ? want.wires.flatMap((w: any) => w.fittings || []) : [];
                    while (this.fittingInsts.length < mats.length) {
                        const m = new J3DModelInstanceSimple(data!); m.passMask = SMSPass.MAIN;
                        this.fittingInsts.push(m); r.modelInstances.push(m); this.actorModels.push(m);
                    }
                    mats.forEach((B, i) => {
                        const m = this.fittingInsts[i];
                        mat4.set(m.modelMatrix, B[0], B[4], B[8], 0, B[1], B[5], B[9], 0, B[2], B[6], B[10], 0, B[3], B[7], B[11], 1);
                        m.visible = true;
                    });
                }
            }
        }
    }
    private wireLines(): WireLine[] {
        const M = this.wireStage && this.wireStage.world ? this.wireStage.world.mapWires : null;
        if (M && M.wires && M.wires.length)
            return M.wires.map((w: any) => ({ pts: w.polyline().flatMap((p: any) => [p.x, p.y, p.z]), width: MapWireConst.mDrawWidth, height: MapWireConst.mDrawHeight, upper: M.upper, lower: M.lower }));
        return this.staticWires.map((pts) => ({ pts, width: MapWireConst.mDrawWidth, height: MapWireConst.mDrawHeight, upper: [0x78, 0x78, 0x78], lower: [0x32, 0x32, 0x32] }));
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
        this.surfRig = null;
        for (const mo of marios) {
            if (!mo.rig) continue;
            let mm = this.marios.get(mo.key);
            if (!mm) { mm = new MarioMirror(this, r); this.marios.set(mo.key, mm); }
            mm.sync(mo.rig, mo.yoshi);
            if (mo.rig.surfGesso) this.surfRig = mo.rig;
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
        this.wireStage = sim && this.sim ? this.sim.stage : null;
        if (this.marioShadow) {
            const S = this.marioShadow, st = this.wireStage, col = st && st.world ? st.world.col : null;
            S.begin();
            if (col && this.shadowLight) {
                if (st.world.map != null) S.setStage(st.world.map);   // (mCurrArea.getStage(): the area)
                const e = cam.matrixWorld.elements, eye = [e[12], e[13], e[14]];
                for (const mo of marios) {
                    const rig = mo.rig;
                    if (!rig || !rig.bones || !worldVisible(rig.root) || rig.sinking) continue;
                    const m = rig.root.matrixWorld.elements;
                    S.addMario({ x: m[12], y: m[13], z: m[14] }, rig.bones, col, this.shadowLight, eye);
                }
            }
        }
        this.syncFittings();
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
        r.copyFilterOn = this.copyFilter;
        r.render(this.device, vi);
        this.device.endFrame();
        this.drawn = true;
        return true;
    }
}

/** whether two byte arrays of the same length hold the same bytes (compared 4 at a time where they line up) */
function sameBytes(a: Uint8Array, b: Uint8Array) {
    const n = a.length;
    if (!(a.byteOffset & 3) && !(b.byteOffset & 3)) {
        const a4 = new Uint32Array(a.buffer, a.byteOffset, n >> 2), b4 = new Uint32Array(b.buffer, b.byteOffset, n >> 2);
        for (let k = 0; k < a4.length; k++) if (a4[k] !== b4[k]) return false;
        for (let k = a4.length * 4; k < n; k++) if (a[k] !== b[k]) return false;
        return true;
    }
    for (let k = 0; k < n; k++) if (a[k] !== b[k]) return false;
    return true;
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
(window as any).GameSim = { setCorrectDrift(on: boolean) { PlayerMario.correctDrift = !!on; } };
(window as any).V1Data = V1Data;
