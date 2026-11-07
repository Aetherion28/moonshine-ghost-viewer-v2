// TMultiPlayerData and TCameraMultiPlayer (Camera/CameraMultiPlayer.cpp): the players the
// multi-player camera keeps in view (CPolarSubCamera::createMultiPlayer / addMultiPlayer /
// removeMultiPlayer). Each entry is a position the camera follows and two values (unk4, unk8).

import type { V3 } from '../math.js';

export class MultiPlayerData {
    unk0: V3 | null = null;
    unk4 = 0;
    unk8 = 0;
    copyFrom(o: MultiPlayerData) { this.unk0 = o.unk0; this.unk4 = o.unk4; this.unk8 = o.unk8; }
}

export class CameraMultiPlayer {
    mPlayerCount = 0;
    mPlayers: MultiPlayerData[];
    constructor(public mMaxPlayers: number) {
        this.mMaxPlayers &= 0xFF;
        this.mPlayers = Array.from({ length: this.mMaxPlayers }, () => new MultiPlayerData());
    }
    addPlayer(p: V3, a: number, b: number) {
        if (this.mPlayerCount >= this.mMaxPlayers) return false;
        const data = this.mPlayers[this.mPlayerCount];
        data.unk0 = p; data.unk4 = Math.fround(a); data.unk8 = Math.fround(b);
        this.mPlayerCount = (this.mPlayerCount + 1) & 0xFF;
        return true;
    }
    removePlayer(p: V3) {
        let found = false;
        for (let i = 0; i < this.mPlayerCount; ++i) {
            const it = this.mPlayers[i];
            if (found || it.unk0 === p) {
                // (*it = *(it + 1): the last entry is left as it was)
                if (i !== this.mPlayerCount - 1) it.copyFrom(this.mPlayers[i + 1]);
                found = true;
            }
        }
        if (!found) return found;
        this.mPlayerCount = (this.mPlayerCount - 1) & 0xFF;
        return found;
    }
}
