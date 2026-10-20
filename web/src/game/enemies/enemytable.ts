// TStageEnemyInfoTable / TStageEnemyInfo (Enemy/enemytable.cpp) and
// TConductor::genEnemyFromPollution (Enemy/conductor.cpp).
//
// The table is in the stage's map/tables.bin (setupObjects genObjects it before scene.bin;
// TMarNameRefGen: "StageEnemyInfoHeader" makes the table, "StageEnemyInfo" its entries): a TNameRefPtrAryT, so its payload is a child count and the
// children; each entry is a manager name, a flag mask and a weight. Its constructor registers it
// with the conductor (registerEnemyInfoTable).
//
// genEnemyFromPollution (main.dol 0x802482c8) runs first in TConductor::perform on movement cues
// while TMarDirector::isGameplayModeNow (unk124 == 0: no talk, no demo). On ticks with
// mMoveTickCount % mGenerateTime == 1 it picks a flag-1 entry (one rand in getMatchedInfo, only
// if the matching weights sum to non-zero), and if that manager exists rolls a radius (rand 2)
// and an angle (rand 3) around Mario, puts the spot on the ground +1, and if the goop is there
// rolls the chance (rand 4: the ナメクリ出現エリアマネージャー cylinder's probability holding the
// spot, else mGenerateProp) to put the manager's far-out enemy there.

import { fr, rand, MsRandF, JMASSin, JMASCos, V3 } from '../math.js';
import { World, NameRef, Stream, EnemyManager, Conductor, readParams, PSchema, CUE_MOVE } from '../engine.js';
import { register } from '../scene.js';
import { getFarOutEnemy } from './generator.js';
import type { AreaCylinderManager } from './bosspakkun.js';

/** TConductor::TCondParams (/conductor.prm) */
const COND_PARAMS = {
    mEnemyFarClip: ['f', 5000], mGenerateRadiusMax: ['f', 1000], mGenerateRadiusMin: ['f', 200],
    mGenerateTime: ['i', 300], mGenerateProp: ['f', 0.01],
} satisfies PSchema;
type CondParams = { [K in keyof typeof COND_PARAMS]: number };

export class StageEnemyInfo extends NameRef {
    managerName = ''; flags = 0; weight = 0;
    constructor(name = '<TStageEnemyInfo>') { super(name); }
    load(s: Stream) { this.managerName = s.str() || ''; this.flags = s.s32(); this.weight = s.u32(); }
    isMatching(f: number) { return (f & this.flags) !== 0; }
}

export class StageEnemyInfoTable extends NameRef {
    list: StageEnemyInfo[] = [];
    constructor(public w: World, name = '<TStageEnemyInfoTable>') { super(name); cond(w).enemyInfoTable = this; w.conductor.performHead = (cue) => conductorPerformHead(w, cue); }
    /** getMatchedInfo (0x802a1d44): a weighted pick of the entries matching f. */
    getMatchedInfo(f: number): StageEnemyInfo | null {
        let sum = 0;
        for (const e of this.list) if (e.isMatching(f)) sum = (sum + e.weight) | 0;
        if (sum === 0) return null;
        // fctiwz(fr((f32)sum * fr(rand() * (1/32768))))
        let x = Math.trunc(fr(fr(sum) * fr(rand() * (1 / 32768))));
        for (const e of this.list) {
            if (!e.isMatching(f)) continue;
            x = (x - e.weight) | 0;
            if (x <= 0) return e;
        }
        return null;
    }
}

interface CondState {
    enemyInfoTable: StageEnemyInfoTable | null;
    pollutionSpawnAreaManager: AreaCylinderManager | null;
    /** mPollutionSpawningEnabled (0xFC): TRUE from the constructor; nothing in the game clears it */
    pollutionSpawningEnabled: boolean;
    condParams: CondParams | null;
}
const STATE = new WeakMap<Conductor, CondState>();
function cond(w: World): CondState {
    let s = STATE.get(w.conductor);
    if (!s) { s = { enemyInfoTable: null, pollutionSpawnAreaManager: null, pollutionSpawningEnabled: true, condParams: null }; STATE.set(w.conductor, s); }
    return s;
}

/** TConductor::genEnemyFromPollution */
export function genEnemyFromPollution(w: World) {
    const c = cond(w);
    if (!c.pollutionSpawningEnabled || !c.enemyInfoTable) return;
    if (!c.condParams) {
        c.condParams = readParams('/conductor.prm', w.files, COND_PARAMS) as CondParams;
        // (init: search("ナメクリ出現エリアマネージャー"))
        c.pollutionSpawnAreaManager = w.search('ナメクリ出現エリアマネージャー') as AreaCylinderManager | null;
    }
    const P = c.condParams;
    // (divw: the C remainder)
    if ((w.moveTickCount % P.mGenerateTime) !== 1) return;
    const info = c.enemyInfoTable.getMatchedInfo(1);
    if (!info) return;
    const mgr = w.conductor.getManagerByName(info.managerName) as EnemyManager | null;
    if (!mgr) return;
    const mp = w.mario.pos;
    const t = new V3(mp.x, mp.y, mp.z);
    // MsRandF(min, max): fmadds (max - min) * x + min
    const r = MsRandF(P.mGenerateRadiusMin, P.mGenerateRadiusMax);
    // fmuls 360 * x, fmuls 182.04445 * that, fctiwz, & 0xFFFF
    const a = Math.trunc(fr(fr(182.04444885253906) * fr(360 * fr(rand() * (1 / 32768)))));
    t.x = fr(r * JMASSin(a) + t.x);   // fmadds
    t.z = fr(r * JMASCos(a) + t.z);
    t.y = fr(w.checkGround(t.x, t.y, t.z)[0] + 1);
    const pol = w.pollution;
    if (!pol || !pol.isPolluted(t.x, t.y, t.z)) return;
    const am = c.pollutionSpawnAreaManager;
    const cyl = am ? am.getCylinderContains(t) : null;
    const prop = cyl ? fr(cyl.probability) : P.mGenerateProp;
    if (fr(rand() * (1 / 32768)) > prop) return;
    const e = getFarOutEnemy(mgr);
    if (!e) return;
    e.resetToPosition(t);
    e.calcRootMatrix();
    // (getModel()->calc(): the model's joints, no rolls)
}

/** TConductor::perform's head: genEnemyFromPollution on movement cues in gameplay mode. */
export function conductorPerformHead(w: World, cue: number) {
    if ((cue & CUE_MOVE) && !w.talkMode && !w.demoMode) genEnemyFromPollution(w);
}

register('StageEnemyInfoHeader', (w, n) => new StageEnemyInfoTable(w, n));
register('StageEnemyInfo', (_w, n) => new StageEnemyInfo(n));
