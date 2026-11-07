// Per-frame vertex positions for a J3D model (MarioUtil/DrawUtil.cpp TTrembleModelEffect: the game
// points the model's vertex buffer at its own copy of VTX1's position array each movement). Here the
// shapes' vertices are re-run through their loaders with the new position array (in VTX1's own
// format: s16 fixed point or f32, big-endian) and uploaded over the model data's vertex buffers.
// The model data is shared: every instance of the model shows the same positions.

import ArrayBufferSlice from '../noclip/ArrayBufferSlice.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { J3DModelData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import * as GX from '../noclip/gx/gx_enum.js';

const uploaded = new WeakMap<J3DModelData, number>();

/** pos: the position array (3 per vertex, VTX1's order and type); version: re-uploaded only when it changes */
export function setVtxPositions(device: GfxDevice, md: J3DModelData, pos: Int16Array | Float32Array, version: number) {
    if (uploaded.get(md) === version) return;
    uploaded.set(md, version);
    const bytes = new ArrayBuffer(pos.length * (pos instanceof Int16Array ? 2 : 4)), v = new DataView(bytes);
    if (pos instanceof Int16Array) for (let i = 0; i < pos.length; i++) v.setInt16(i * 2, pos[i]);
    else for (let i = 0; i < pos.length; i++) v.setFloat32(i * 4, pos[i]);
    const slice = new ArrayBufferSlice(bytes);
    for (const sd of md.shapeData) {
        const sh = sd.shape;
        if (!sh.vtxLoader || !sh.vtxArrays || !sh.vtxArrays[GX.Attr.POS]) continue;
        const arrays = sh.vtxArrays.slice();
        arrays[GX.Attr.POS] = { ...arrays[GX.Attr.POS], buffer: slice };
        const desc = sd.vertexBufferDescriptors[0];
        let offs = desc.byteOffset ?? 0;
        for (const g of sh.mtxGroups) {
            sh.vtxLoader.loadVertexData(g.loadedVertexData, arrays);
            const vb = g.loadedVertexData.vertexBuffers[0];
            device.uploadBufferData(desc.buffer, offs, new Uint8Array(vb));
            offs += vb.byteLength;
        }
    }
}
