// TNpcParts (NPC/NpcParts.cpp) and its TSharedParts (Strategic/SharedParts.cpp): the models an NPC
// wears on its joints (hats, glasses, Peach's hair and hands, the luggage, the jellyfish), chosen by
// the scene's parts flags (NpcInitData.cpp's TNpcModelData: a joint and a file per LOD, only LOD 0
// has one). Drawn by the viewer as world.extras, at the baseTR TSharedParts::perform sets.
//
// The render state the constructor sets (SMS_UnifyMaterial, setLightType, Peach's texture swap, the
// jellyfish's effect matrix) is kept on the part for the viewer (layer.ts); the BCK motion blend
// (initBckSimpleMotionBlend: TMotionBlendCtrl) is worked out here, its joints in `locals`.

import { World, LiveActor, MActor, LF, CUE_CALC_ANIM, ANM_BCK, ANM_BTP, ANM_BRK } from '../engine.js';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import type { mat4 } from 'gl-matrix';
import { AT as T } from '../actortypes.js';
import { fr, MsRandF } from '../math.js';
import { anmFrameRate } from '../version.js';
import NPC_INIT_DATA from '../../data/npc_init.json';

/** cNpcPartsNameRootJoint */
const ROOT_JOINT = '__ROOT_JOINT__';
/** cPeachPartsTextureName / cPeachHostTextureName */
const PEACH_PARTS_TEX = 'H_peach_main_dummy', PEACH_HOST_TEX = 'H_peach_main_s3tc';
/** LIGHT_TYPE_* (LightUtil.hpp) */
export const LIGHT_TYPE_PLAYER = 0, LIGHT_TYPE_OBJECT = 1, LIGHT_TYPE_MAPOBJECT = 2, LIGHT_TYPE_INDIRECT = 3;
/** The TNpcModelData whose unk2B is set (NpcInitData.cpp): SMS_UnifyMaterial on the part's model */
const UNIFY_FILES = new Set(['mareMhat_A.bmd', 'mareMhat_B.bmd', 'mareMhat_E.bmd', 'mareMmakigai_A.bmd', 'mareMmakigai_B.bmd', 'mareMbivalve_B.bmd',
    'mareMB_set.bmd', 'mareMChat_F.bmd', 'mareMCagohige.bmd', 'mareMCkuchihige.bmd', 'mareMDhoragai_A.bmd', 'mareWpearl_A.bmd', 'mareWhatW_A.bmd',
    'mareWhatW_D.bmd', 'mareWkai_A.bmd', 'mareWkai_B.bmd', 'mareWbivalveW_A.bmd']);
/** CLBPalFrame */
const palFrame = (x: number) => { const v = fr(x * fr(1 / anmFrameRate())); return Math.trunc(v + (v > 0 ? 0.5 : -0.5)); };

/** TMotionBlendCtrl (simple: unk0 & 1) on a part's BCK: the old animation kept at its frame, blended out by unk4 each calc */
export class PartMotionBlend {
    ratio = 0; oldIdx = -1; oldFrame = 0; step: number;
    constructor(n: number) { this.step = n <= 0 ? 1 : fr(1 / palFrame(n)); }
    /** execSimpleMotionBlend */
    exec() { const r = fr(this.ratio - this.step); this.ratio = r <= 0 ? 0 : r; }
}
/** MActor::initBckSimpleMotionBlend: setAnmFromIndex keeps the current BCK (keepCurAnm) and starts the blend at 1 (setNewAnm) */
function initBckSimpleMotionBlend(a: MActor, n: number) {
    const b = new PartMotionBlend(n);
    (a as any).motionBlend = b;
    const set = a.setBckFromIndex.bind(a);
    a.setBckFromIndex = (i: number) => {
        const fc = a.getFrameCtrl(ANM_BCK), cur = a.getCurAnmIdx(ANM_BCK);
        if (cur !== -1) { b.oldIdx = cur; b.oldFrame = fc ? fc.frame : 0; }
        set(i);
        b.ratio = 1;
    };
}

interface PartsOwner extends LiveActor {
    actorType: number;
    unk1D8: number;
    look: { c0: number[]; c1: number[]; parts: number };
    anmJoints: any[] | null;
    lodAnm: { lod: number };
    isJellyFishMare(): boolean;
}

/** TSharedParts: a model on the owner's joint (mConnectedAnmMtxIndex; -1 its base TR matrix) */
export class NpcSharedPart extends LiveActor {
    shown = false;
    /** SMS_InitChangeNpcColor's tables and the colour index (the viewer applies them) */
    npcPartColor: { colors: any[]; idx: number } | null = null;
    /** SMS_UnifyMaterial: every material takes material 0's first texture */
    unifyMaterial = false;
    /** SMS_ChangeTextureAll(part, cPeachPartsTextureName, the host body's cPeachHostTextureName) */
    textureFromOwner: { dummy: string; host: string } | null = null;
    /** MActor::setLightType (the object light set for OBJECT and INDIRECT alike: 太陽（オブジェクト）) */
    lightType = LIGHT_TYPE_OBJECT;
    /** the jellyfish's materials but _starglow1 take SMS_GetLightPerspectiveForEffectMtx as texture matrix 0's effect matrix */
    effectMtxExcept: string | null = null;
    /** the motion blend's joints in their parents' (the viewer's joint callback) */
    locals: mat4[] | null = null;
    constructor(w: World, public owner: PartsOwner, public joint: number, m: MActor) {
        super(w, '<TSharedParts>');
        this.mactor = m;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        w.extras.push(this);
    }
    drawn() { return this.shown && !this.owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT) && this.owner.drawn(); }
    /** getConnectedMtx */
    getConnectedMtx(): number[] | null {
        const o = this.owner;
        if (this.joint === -1) return Array.from(o.baseTR);
        const all = o.anmJoints || (o.mactor ? o.mactor.anmMtxAll(o.baseTR, o.scale) : null);
        const m = all && all[this.joint];
        if (!m) return null;
        const r: number[] = [];
        for (let i = 0; i < 3; i++) for (let c = 0; c < 4; c++) r.push(m[c * 4 + i]);
        return r;
    }
    /** perform: nothing while the owner is dead / hidden / clipped (checkLiveFlag(7)); the model on the joint, its animations going */
    perform(cue: number) {
        if (this.owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) return;
        if (cue & CUE_CALC_ANIM) {
            const m = this.getConnectedMtx();
            if (m) for (let i = 0; i < 12; i++) this.baseTR[i] = m[i];
            this.calcMotionBlend();
            this.mactor!.frameUpdate();
        }
    }
}

export interface NpcSharedPart { calcMotionBlend(): void; }
NpcSharedPart.prototype.calcMotionBlend = function (this: NpcSharedPart) {
    // MActorAnmBck::updateIn (MotionBlend): execSimpleMotionBlend, then M3UMtxCalcSIAnmBlendQuat's calc
    const a = this.mactor!, b = (a as any).motionBlend as PartMotionBlend | undefined;
    if (!b) return;
    b.exec();
    if (b.ratio === 0 || b.oldIdx < 0) { this.locals = null; return; }
    const sk = Skeleton.of(a.data.files.scene(a.model));
    if (!sk) return;
    const anm = (i: number) => { const d = i >= 0 ? a.data.anms[ANM_BCK][i] : null; return d ? parseBCK(a.data.files.scene(a.data.folder + '/' + d.name + '.bck')) : null; };
    const fc = a.getFrameCtrl(ANM_BCK);
    const L: mat4[] = [];
    jointMatricesBlend(sk, { anm: anm(a.getCurAnmIdx(ANM_BCK)), frame: fc ? fc.frame : 0 }, { anm: anm(b.oldIdx), frame: b.oldFrame }, b.ratio, false,
        this.baseTR, [this.scale.x, this.scale.y, this.scale.z], [], L);
    this.locals = L;
};

/** SetMActorAnmFrame */
function setMActorAnmFrame(a: MActor | null, frame: number, bck: boolean, btp: boolean) {
    if (!a) return;
    if (bck) { const c = a.getFrameCtrl(ANM_BCK); if (c) c.frame = frame; }
    if (btp) { const c = a.getFrameCtrl(ANM_BTP); if (c) c.frame = frame; }
}

/** The common parts volumes (TNPCManager::makeCommonPartsModelDataKeeper_), then the manager's own folder (getPartsSDLModelData) */
function partsFile(o: PartsOwner, file: string): string | null {
    const w = o.world, M = o.manager as any;
    const t = o.actorType;
    const common = t >= T.NPC_MONTE_M && t <= T.NPC_MONTE_MH ? 'montemcommon'
        : t >= T.NPC_MONTE_W && t <= T.NPC_MONTE_WC ? 'montewcommon'
        : t >= T.NPC_MARE_M && t <= T.NPC_MARE_MD ? 'marem'
        : t >= T.NPC_MARE_W && t <= T.NPC_MARE_WB ? 'marew' : null;
    for (const f of [common, M && M.folder ? M.folder() : null]) {
        if (!f) continue;
        const p = (f + '/' + file).toLowerCase();
        if (w.files.scene(p)) return p;
    }
    return null;
}

export class NpcParts {
    /** unk0[lod][12] (only LOD 0's models exist) */
    unk0: (NpcSharedPart | null)[][] = [new Array(12).fill(null), new Array(12).fill(null)];
    constructor(flags: number, public unk60: PartsOwner) {
        const info: any = (NPC_INIT_DATA as any)[unk60.actorType - T.NPC_MONTE_M];
        if (!info) return;
        const M = unk60.manager as any;
        for (let i = 0; i < 12; i++) {
            const p = info.parts[i];
            if (!p || !(flags & (1 << i))) continue;
            // (j = 1: no TNpcModelData has a LOD 1 file)
            const j = 0;
            const path = partsFile(unk60, p.file);
            if (!path || !M) continue;
            const joint = p.joint === ROOT_JOINT ? -1 : (unk60.mactor ? unk60.mactor.jointIndex(p.joint) : -1);
            const part = new NpcSharedPart(unk60.world, unk60, joint, new MActor(path, M.getMActorAnmData()));
            part.npcPartColor = { colors: p.colors || [], idx: p.slot < 3 ? unk60.look.c1[p.slot] : -1 };
            part.unifyMaterial = UNIFY_FILES.has(p.file);
            this.unk0[j][i] = part;
            const ma = part.mactor!;
            const blendFrame = (n: number) => (n === -1 ? (unk60 as any).P.mMotionBlendFrame : n);
            switch (unk60.actorType) {
                case T.NPC_PEACH:
                    if (j !== 0 || (i !== 3 && i !== 4)) part.textureFromOwner = { dummy: PEACH_PARTS_TEX, host: PEACH_HOST_TEX };
                    if (j === 0 && (i === 0 || i === 3 || i === 4)) initBckSimpleMotionBlend(ma, blendFrame(-1));
                    break;
                case T.NPC_MARE_MB: if (j === 0 && i === 9) initBckSimpleMotionBlend(ma, 20); break;
                case T.NPC_MARE_WB: if (j === 0 && i === 10) initBckSimpleMotionBlend(ma, blendFrame(-1)); break;
            }
            part.lightType = LIGHT_TYPE_OBJECT;
        }
    }
    /** addJellyFishParts: one of gpMareJellyFishManager's models at random, its BCK 0 and BRK of that index at the frame */
    addJellyFishParts(frame: number) {
        const J = (this.unk60.world as any).mareJellyFishManager;
        const n = J ? J.modelFiles.length : 0;
        const k = Math.trunc(fr(MsRandF() * n));
        if (!J || !J.modelFiles[k]) return;
        const a = new MActor(J.modelFiles[k], J.getMActorAnmData());
        const part = this.unk0[0][11] = new NpcSharedPart(this.unk60.world, this.unk60, -1, a);
        part.lightType = LIGHT_TYPE_INDIRECT;
        part.effectMtxExcept = '_starglow1';
        a.setBckFromIndex(0);
        a.setFromIndex(ANM_BRK, k);
        const b = a.getFrameCtrl(ANM_BCK); if (b) b.frame = frame;
        const r = a.getFrameCtrl(ANM_BRK); if (r) r.frame = frame;
    }
    setPartsAnmFrame(frame: number) {
        switch (this.unk60.actorType) {
            case T.NPC_MARE_MB: setMActorAnmFrame(this.getPartsMActor(9, 0), frame, true, false); break;
            case T.NPC_MARE_WB: setMActorAnmFrame(this.getPartsMActor(10, 0), frame, true, true); break;
            case T.NPC_PEACH:
                setMActorAnmFrame(this.getPartsMActor(0, 0), frame, true, false);
                setMActorAnmFrame(this.getPartsMActor(3, 0), frame, true, false);
                setMActorAnmFrame(this.getPartsMActor(4, 0), frame, true, false);
                break;
        }
    }
    getPartsMActor(i: number, lod: number): MActor | null { const p = this.unk0[lod][i]; return p ? p.mactor : null; }
    getPart(i: number, lod: number) { return this.unk0[lod][i]; }
    /** partsFrameUpdate */
    partsFrameUpdate() { for (const p of this.unk0[this.unk60.lodAnm.lod]) if (p) p.mactor!.frameUpdate(); }
    /** partsPerform: the current LOD's parts (Peach's by her parasol / tired state) */
    partsPerform(cue: number) {
        const o = this.unk60, cur = this.unk0[o.lodAnm.lod];
        for (const L of this.unk0) for (const p of L) if (p && L !== cur) p.shown = false;
        for (let i = 0; i < 12; i++) {
            const p = cur[i];
            if (!p) continue;
            if (o.actorType === T.NPC_PEACH) {
                let on = true;
                if (o.unk1D8 & 4) { if (i === 1 || i === 2 || i === 4) on = false; }
                else if (o.unk1D8 & 1) { if (i === 1 || i === 2) on = false; }
                else if (i === 4 || i === 5 || i === 6) on = false;
                if (!on) { p.shown = false; continue; }
            }
            p.shown = true;
            p.perform(cue);
        }
    }
}
