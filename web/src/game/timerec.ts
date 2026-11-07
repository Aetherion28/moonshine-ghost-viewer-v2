// The frame profiler (System/TimeRec.cpp, System/SnapTimeObj.cpp): TTimeRec keeps two pairs of
// TTimeArray (CPU, GX) and flips them each frame; TSnapTimeObj, the measurement group's
// "... SnapTime" view objects (MarDirectorSetupObjects.cpp), snaps a time at CUE_DRAW_INIT /
// CUE_DRAW when unk14 bit 1 is on. Nothing in the game sets that bit, so the retail game records
// nothing; the classes are here as the game has them. The GX tick (drawSyncCallback's OSGetTick at
// the draw-sync token) has no counterpart in the sim: snapGXTime records 0 and suppleGXTime fills it.

import { NameRef } from './engine.js';

export const CUE_DRAW = 0x8, CUE_DRAW_INIT = 0x80;

export class TimeArray {
    static readonly MAX_SIZE = 64;
    mEntries: { time: number; color: number }[] = [];
    mSize = 0;
    append(time: number, color: number) {
        let result = false;
        if (this.mSize < TimeArray.MAX_SIZE) {
            this.mEntries[this.mSize++] = { time: time >>> 0, color: color >>> 0 };
            result = true;
        }
        return result;
    }
    size() { return this.mSize; }
    clear() { this.mSize = 0; }
}

/** OSGetTick stand-in: the host's clock in bus ticks (40.5 MHz) */
const osGetTick = () => Math.floor((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 40500) >>> 0;

export class TimeRec {
    static _instance: TimeRec | null = null;
    mTimeAry: [TimeArray, TimeArray][] = [[new TimeArray(), new TimeArray()], [new TimeArray(), new TimeArray()]];
    mCrIdx = 0;
    mFlags = 0;
    constructor(public mTokenBase: number) { }
    static start(tokenBase: number) { if (!TimeRec._instance) TimeRec._instance = new TimeRec(tokenBase); return TimeRec._instance; }
    static end() { TimeRec._instance = null; }
    crTimeAry() { return this.mTimeAry[this.mCrIdx]; }
    appendGX(tick: number, color: number) { return this.crTimeAry()[1].append(tick, color); }
    flip() {
        TimeRec.suppleGXTime();
        this.mCrIdx ^= 1;
        this.crTimeAry()[0].clear();
        this.crTimeAry()[1].clear();
    }
    snapGXTime(color: number) {
        if (this.appendGX(0, color) && !(this.mFlags & 1)) this.drawSyncCallback(this.mTokenBase + this.crTimeAry()[1].size() - 1);
    }
    static snapGXTimeSt(color: number) { if (TimeRec._instance) TimeRec._instance.snapGXTime(color); }
    static snapCPUTime(color: number) { if (TimeRec._instance) TimeRec._instance.crTimeAry()[0].append(osGetTick(), color); }
    static suppleGXTime() {
        const I = TimeRec._instance;
        if (!I) return;
        const array = I.crTimeAry()[1];
        if (array.size() < 3) return;
        let curr = array.mEntries[array.size() - 1].time;
        let i = array.size() - 1;
        while (i > 0) {
            --i;
            if (array.mEntries[i].time === 0) array.mEntries[i].time = curr;
            else curr = array.mEntries[i].time;
        }
    }
    drawSyncCallback(token: number) { this.crTimeAry()[1].mEntries[token - this.mTokenBase].time = osGetTick(); }
}

export class SnapTimeObj extends NameRef {
    unk14 = 0;
    constructor(public unk10: number, name: string) { super(name); }
    perform(cue: number) {
        if (this.unk14 & 1) {
            if (cue & CUE_DRAW_INIT) { TimeRec.snapGXTimeSt(0); TimeRec.snapCPUTime(0); }
            if (cue & CUE_DRAW) { TimeRec.snapCPUTime(this.unk10); TimeRec.snapGXTimeSt(this.unk10); }
        }
    }
}

/** MarDirectorSetupObjects.cpp's measurement group (計測グループ): inert in the retail game (unk14 0) */
export function makeMeasurementGroup() {
    return ([[0xFFFFFFFF, 'Mirror Draw SnapTime'], [0xFF00FFFF, 'Pollution Check SnapTime'], [0x0000FFFF, 'Pollution Draw SnapTime'],
        [0xFFFFFFFF, 'Map Draw SnapTime'], [0x0000FFFF, 'MapObj Draw SnapTime'], [0xFF00FFFF, 'Player Draw SnapTime'],
        [0xFF00FFFF, 'Water Draw SnapTime'], [0xFFFF00FF, 'Sky Draw SnapTime'], [0xFF00FFFF, 'PollutionModel Draw SnapTime'],
        [0xFF0000FF, 'Shadow Draw SnapTime'], [0x000000FF, 'Silhouette Draw SnapTime'], [0xFFFFFFFF, 'Chara Draw SnapTime'],
        [0x00FF00FF, 'Indirect Draw SnapTime'], [0xFFFFFFFF, 'Particle Draw SnapTime']] as [number, string][]).map(([c, n]) => new SnapTimeObj(c >>> 0, n));
}
