// The stage's camera data in map/tables.bin: マップツールカメラテーブル (Camera/CameraMapTool.cpp:
// TCameraMapTool, gpCamMapToolTable), the camera cubes カメラキューブテーブル (CubeMapTool.cpp:
// TCubeCameraInfo, a camera kind or a map tool for the space inside; CubeManagerBase.cpp:
// gpCubeCamera), the fast cubes 高速Ｃキューブテーブル (gpCubeFastC, which Pianta Village's roof
// check asks about: MapUtil.cpp's SMS_GetMonteVillageAreaInMario) and 位置テーブル (TStagePositionInfo,
// gpPositionHolder: the tower cameras' centres).

import { fr } from '../math.js';
import { Stream, parseSceneBin, SceneNode } from '../engine.js';
import { Vec, vec, isPointInCube } from './lib.js';

/** TCameraMapTool */
export class CameraMapTool {
    name = '';
    pos = vec(); pitch = 0; yaw = 0; unk20 = 0; mode = 0; unk28 = 0; demoLength = 0;
    load(s: Stream) {
        this.pos = vec(s.f32(), s.f32(), s.f32());
        this.pitch = s.f32(); this.yaw = s.f32();
        this.unk20 = s.u32(); this.mode = s.s32(); this.unk28 = s.s32(); this.demoLength = s.u32();
        if (this.unk28 < 0) this.unk28 = 0;
    }
}

/** TCubeGeneralInfo (+ TCubeCameraInfo's map tool) */
export class CubeInfo {
    name = '';
    c = vec(); r = vec(); s = vec(1, 1, 1); unk30 = 0x80; dataNo = 0;
    tool: CameraMapTool | null = null;
    load(st: Stream) {
        this.c = vec(st.f32(), st.f32(), st.f32());
        this.r = vec(st.f32(), st.f32(), st.f32());
        this.s = vec(fr(st.f32() * 100), fr(st.f32() * 100), fr(st.f32() * 100));
        this.unk30 = (st.u32() << 16) >> 16; st.u32(); this.dataNo = st.u32() | 0;
    }
}

/** TCubeManagerBase over one table */
export class CubeTable {
    list: CubeInfo[] = [];
    /** TCubeManagerMarioIn::unk1C (TMario::thinkCube) */
    marioIn = -1;
    getInCubeNo(p: Vec) { for (let i = 0; i < this.list.length; i++) { const c = this.list[i]; if (isPointInCube(p, c.c, c.r, c.s)) return i; } return -1; }
    isInCube(p: Vec, i: number) { if (i < 0 || i >= this.list.length) return false; const c = this.list[i]; return isPointInCube(p, c.c, c.r, c.s); }
    getDataNo(i: number) { return i >= 0 && i < this.list.length ? this.list[i].dataNo : -1; }
}

/** The camera's share of tables.bin. */
export class CameraTables {
    tools: CameraMapTool[] = [];
    cubes = new CubeTable();
    fastC = new CubeTable();
    positions = new Map<string, Vec>();
    /** gpCamMapToolTable->searchF(calcKeyCode(name), name) */
    tool(name: string) { for (const t of this.tools) if (t.name === name) return t; return null; }

    static load(tables: Uint8Array | null) {
        const T = new CameraTables();
        if (!tables) return T;
        const root = parseSceneBin(tables);
        const tableOf = (name: string) => {
            let found: SceneNode | null = null;
            const find = (n: SceneNode) => { if (found) return; if (n.name === name && n.children) { found = n; return; } for (const c of n.children || []) find(c); };
            find(root);
            return (found as SceneNode | null)?.children || [];
        };
        // the tool table first: the camera cubes name their tools (TCubeCameraInfo::load's searchF)
        for (const n of tableOf('マップツールカメラテーブル')) { const t = new CameraMapTool(); t.name = n.name; t.load(new Stream(n.data)); T.tools.push(t); }
        for (const n of tableOf('カメラキューブテーブル')) {
            const c = new CubeInfo(); c.name = n.name;
            const s = new Stream(n.data);
            c.load(s);
            if (n.type === 'CameraCubeInfo') c.tool = T.tool(s.str());
            T.cubes.list.push(c);
        }
        for (const n of tableOf('高速Ｃキューブテーブル')) { const c = new CubeInfo(); c.name = n.name; c.load(new Stream(n.data)); T.fastC.list.push(c); }
        for (const n of tableOf('位置テーブル')) { const s = new Stream(n.data); T.positions.set(n.name, vec(s.f32(), s.f32(), s.f32())); }
        return T;
    }
}
