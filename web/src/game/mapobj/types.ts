// The map objects' data (TMapObjData and its parts, MoveBG/MapObjBase.hpp), as objdata.ts has it.

/** TMapObjAnimData: a model and the animation it plays (mAnmType: ANM_BCK...). */
export interface MapObjAnimData { bmd: string | null; anm: string | null; type: number; unkC: string | null; bas: string | null; }
export interface MapObjAnimDataInfo { num: number; max: number; entries: MapObjAnimData[]; }
/** TMapObjHitInfo: hit filter, the collision's Y offset (unk8) and [attackR, attackH, damageR, damageH] per state. */
export interface MapObjHitInfo { num: number; filter: number; unk8: number; entries: [number, number, number, number][] | number[][]; }
/** TMapObjCollisionInfo: .col files (no extension, in the manager's folder) and their kind (flags & 3). */
export interface MapObjCollisionInfo { num: number; max: number; entries: { file: string | null; flags: number }[]; }
/** TMapObjPhysicalData (13 floats: gravity, bounce, wall bounce, stop speed, ground friction, ...) and the wall check flags. */
export interface MapObjPhysicalInfo { data: number[]; wall: number; }
export interface MapObjData {
    name: string | null; type: number; manager: string | null; group: string | null;
    anim: MapObjAnimDataInfo | null; hit: MapObjHitInfo | null; col: MapObjCollisionInfo | null;
    /** TMapObjSoundInfo: the sound IDs by startSound's index (-1: none); null: TMapObjGeneral::mDefaultSound */
    sound: number[] | null;
    physical: MapObjPhysicalInfo | null; sink: { sink: number; recover: number } | null;
    hold: { bmd: string; joint: string } | null; move: { bck: string } | null;
    unk30: number; flags: number;
}
