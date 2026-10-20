// The NPC managers (NPC/NpcManager.cpp): each kind's model, the folder it comes from, where its
// animations are (the Piantas' in monteMCommon / monteWCommon), and their clipping (the stage's
// far clip from npcFarClip.prm). The model swaps (straw, goop, the jellyfish's textures) and the
// parts' models are the viewer's.

import { World, Stream, EnemyManager, LiveManager, AnmData, LF } from '../engine.js';
import { register } from '../scene.js';
import { BaseNPC, npcParams, condParams } from './base.js';
import { AT } from '../actortypes.js';

/** Each manager class: its model file, the folder it's loaded from (createModelDataArrayBase) and where its animations are (createAnmData). */
const MANAGERS: Record<string, { model: string; folder?: string; anm?: string }> = {
    MonteMManager: { model: 'mom_model.bmd', anm: 'monteMCommon' }, MonteMAManager: { model: 'momA_model.bmd', anm: 'monteMCommon' },
    MonteMBManager: { model: 'momB_model.bmd', anm: 'monteMCommon' }, MonteMCManager: { model: 'momC_model.bmd', anm: 'monteMCommon' },
    MonteMDManager: { model: 'momD_model.bmd', anm: 'monteMCommon' },
    // (the special ones: TMonteMSpecialManager::createAnmData is TObjManager's, their own folder)
    MonteMEManager: { model: 'momE_model.bmd' }, MonteMFManager: { model: 'mom_model.bmd', folder: 'monteM' },
    MonteMGManager: { model: 'momC_model.bmd', folder: 'monteMC' }, MonteMHManager: { model: 'momA_model.bmd', folder: 'monteMA' },
    MonteWManager: { model: 'mow_model.bmd', anm: 'monteWCommon' }, MonteWAManager: { model: 'mowA_model.bmd', anm: 'monteWCommon' },
    MonteWBManager: { model: 'mowB_model.bmd', anm: 'monteWCommon' }, MonteWCManager: { model: 'mow_model.bmd', folder: 'monteW' },
    MareMManager: { model: 'mareM.bmd', folder: 'mareM' }, MareMAManager: { model: 'mareM.bmd', folder: 'mareM' }, MareMBManager: { model: 'mareM.bmd', folder: 'mareM' },
    MareMCManager: { model: 'mareM.bmd', folder: 'mareM' }, MareMDManager: { model: 'mareM.bmd', folder: 'mareM' },
    MareWManager: { model: 'mareW.bmd', folder: 'mareW' }, MareWAManager: { model: 'mareW.bmd', folder: 'mareW' }, MareWBManager: { model: 'mareW.bmd', folder: 'mareW' },
    KinopioManager: { model: 'kinopio_body.bmd' }, KinojiiManager: { model: 'kinoji_body.bmd' }, PeachManager: { model: 'peach_model.bmd' },
    RaccoonDogManager: { model: 'tanuki.bmd' }, SunflowerLManager: { model: 'sunflower.bmd' }, SunflowerSManager: { model: 'sunflower_s.bmd' },
};
/** TNPCManager::unk58: the stage's far clip (npcFarClip.prm, by map) */
const FAR_BY_MAP: Record<number, string> = {
    0: 'mSLFarAirport', 1: 'mSLFarDolpicTown', 2: 'mSLFarBiancoHills', 3: 'mSLFarRiccoHarbor', 4: 'mSLFarMammaBeach', 5: 'mSLFarPinnaBeach',
    13: 'mSLFarPinnaParco', 6: 'mSLFarSirenaBeach', 7: 'mSLFarHotelDelfino', 9: 'mSLFarMareVillage', 8: 'mSLFarMonteVillage', 10: 'mSLFarCoronaMountain',
};

export class NPCManager extends EnemyManager {
    /** unk54 the near clip, unk3C the clip radius */
    unk54 = 350; unk3C = 0; farClip = 15000;
    constructor(w: World, public kind: string, name = '') {
        super(w, name);
        const f = npcParams(w).far as any;
        this.farClip = f[FAR_BY_MAP[w.map] || 'mSLFarOthers'];
    }
    private get info() { return MANAGERS[this.kind]; }
    load(s: Stream) {
        super.load(s);
        this.unk3C = this.kind === 'SunflowerLManager' ? 500 : 250;
    }
    createModelData() {
        const I = this.info;
        const folder = I.folder ? I.folder.toLowerCase() : this.folder();
        this.modelFiles = [(folder + '/' + I.model).toLowerCase()];
    }
    getMActorAnmData() {
        if (!this.anmData) this.anmData = new AnmData(this.info.anm ? this.info.anm.toLowerCase() : this.folder(), this.world.files);
        return this.anmData;
    }
    /** clipEnemies: the frustum (near unk54, the stage's far clip, radius unk3C). TODO: SMS_IsInOtherFastCube (the fast cubes) isn't checked, nor Delfino Plaza's 15000 far clip under ground. */
    clipActors() {
        for (const o of this.objs as BaseNPC[]) {
            if (this.world.inView(o.pos, this.unk3C, this.farClip, this.unk54)) o.offLiveFlag(LF.CLIPPED_OUT);
            else o.onLiveFlag(LF.CLIPPED_OUT);
        }
    }
}

// The NPCs by class (MarNameRefGen_NPC.cpp), their actor types in ACTOR_TYPE_NPC_* order
const NPCS: [string, number][] = [
    ['NPCMonteM', AT.NPC_MONTE_M], ['NPCMonteMA', AT.NPC_MONTE_MA], ['NPCMonteMB', AT.NPC_MONTE_MB], ['NPCMonteMC', AT.NPC_MONTE_MC], ['NPCMonteMD', AT.NPC_MONTE_MD],
    ['NPCMonteME', AT.NPC_MONTE_ME], ['NPCMonteMF', AT.NPC_MONTE_MF], ['NPCMonteMG', AT.NPC_MONTE_MG], ['NPCMonteMH', AT.NPC_MONTE_MH],
    ['NPCMonteW', AT.NPC_MONTE_W], ['NPCMonteWA', AT.NPC_MONTE_WA], ['NPCMonteWB', AT.NPC_MONTE_WB], ['NPCMonteWC', AT.NPC_MONTE_WC],
    ['NPCMareM', AT.NPC_MARE_M], ['NPCMareMA', AT.NPC_MARE_MA], ['NPCMareMB', AT.NPC_MARE_MB], ['NPCMareMC', AT.NPC_MARE_MC], ['NPCMareMD', AT.NPC_MARE_MD],
    ['NPCMareW', AT.NPC_MARE_W], ['NPCMareWA', AT.NPC_MARE_WA], ['NPCMareWB', AT.NPC_MARE_WB], ['NPCKinopio', AT.NPC_KINOPIO], ['NPCKinojii', AT.NPC_KINOJII],
    ['NPCPeach', AT.NPC_PEACH], ['NPCRaccoonDog', AT.NPC_RACCOON_DOG], ['NPCSunflowerL', AT.NPC_SUNFLOWER_L], ['NPCSunflowerS', AT.NPC_SUNFLOWER_S],
    ['NPCDummy', AT.NPC_DUMMY], ['NPCBoard', AT.NPC_BOARD],
];
for (const [cls, type] of NPCS) register(cls, (w, n) => new BaseNPC(w, type, n));
for (const k of Object.keys(MANAGERS)) register(k, (w, n) => new NPCManager(w, k, n));

/** TBoardNpcManager: the signboards' manager (a TLiveManager), boardNpc.bmd from its folder, clipped as the enemies are */
export class BoardNpcManager extends LiveManager {
    load(s: Stream) { super.load(s); this.createModelData(); }
    createModelData() { this.createModelDataArray(['boardNpc.bmd']); }
    clipActors() { this.clipActorsAux(condParams(this.world).mEnemyFarClip, 200); }
}
register('BoardNpcManager', (w, n) => new BoardNpcManager(w, n));
// TMareJellyFishManager draws Noki Bay's jellyfish (a TObjManager whose perform does nothing): TODO with Noki Bay
