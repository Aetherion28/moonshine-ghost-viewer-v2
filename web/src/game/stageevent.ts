// System/StageEventInfo.cpp: TStageEventInfo, the entries of tables.bin's イベントテーブル
// (TNameRefAryT<TStageEventInfo>, made by TMarNameRefGen as EventTable), and the part of
// TMarDirector::setup2 (System/MarDirectorSetup2.cpp) that gives each entry's map object its event id.

import { NameRef, Stream } from './engine.js';
import { register } from './scene.js';

export class StageEventInfo extends NameRef {
    unkC = 0;
    unk10 = ''; unk14 = ''; unk18 = ''; unk1C = ''; unk20 = ''; unk24 = '';
    unk28: NameRef | null = null;
    constructor(name = '<StageEventInfo>') { super(name); }
    load(s: Stream) {
        super.load(s);
        this.unkC = s.u32();
        this.unk10 = s.str(); this.unk14 = s.str(); this.unk18 = s.str();
        this.unk1C = s.str(); this.unk20 = s.str(); this.unk24 = s.str();
    }
}

/** TNameRefAryT<TStageEventInfo> */
export class StageEventInfoTable extends NameRef {
    list: StageEventInfo[] = [];
}

register('EventTable', (w, n) => new StageEventInfoTable(n));
register('StageEventInfo', (w, n) => new StageEventInfo(n));
