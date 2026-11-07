// The light cones (Enemy/beam.cpp): TBeamManager gathers cone requests (TConeBeam: an apex, the
// centre of the base, the base's diameter) during the frame and draws them all at CUE_DRAW, then
// forgets them; the viewer draws them (wavedraw.ts BeamDraw). The Sirena lean mirror's light
// (TLeanMirror::draw) asks for one each frame.

import { fr, V3, MsSin, MsCos, MsAtan2 } from '../math.js';
import { World } from '../engine.js';
import { psVecNormalize } from '../camera/lib.js';
import type { BGCheckData } from '../collision.js';

/** coneInPlane: where the ray from origin along axis + offsetDir * sin(angle) crosses the plane */
function coneInPlane(origin: V3, angle: number, axis: V3, offsetDir: V3, n: number[], d: number, out: V3) {
    const dir = offsetDir.clone().scale(MsSin(angle));
    dir.add(axis);
    const t = fr(-fr(d + fr(n[0] * origin.x + n[1] * origin.y + n[2] * origin.z)) / fr(n[0] * dir.x + n[1] * dir.y + n[2] * dir.z));
    out.set(dir).scale(t).add(origin);
}

export class ConeBeam {
    /** unk00 the apex, unk0C the base's centre */
    unk00 = new V3(); unk0C = new V3();
    mScale = 0;
    /** unk1C: draw the fourth (glow) pass; unk1D: there, the apex's alpha 0 */
    unk1C = false; unk1D = true;
    mBGCheckData: BGCheckData | null = null;
    mVtxCount = 0;
    mVtx: V3[] = [];
    calcVertices(count: number) {
        let l140 = new V3(), l134 = new V3(0, 1, 0);
        const l128 = this.unk0C.clone();
        this.mVtxCount = count;
        l128.sub(this.unk00);
        l140.cross(l128, l134);
        if (l140.squared() <= 1 / 262144) { l134.set(1, 0, 0); l140.set(0, 0, 1); }
        else { l134.cross(l140, l128); psVecNormalize(l140, l140); psVecNormalize(l134, l134); }
        this.mVtx = [];
        if (!this.mBGCheckData) {
            for (let i = 0; i <= this.mVtxCount; i++) {
                const angle = fr(i * fr(360 / this.mVtxCount));
                const s = fr(fr(this.mScale * MsSin(angle)) * 0.5), c = fr(fr(this.mScale * MsCos(angle)) * 0.5);
                const v = new V3();
                v.add(l140.clone().scale(c)); v.add(l134.clone().scale(s)); v.add(this.unk0C);
                this.mVtx.push(v);
            }
        } else {
            const b = this.mBGCheckData;
            const len = fr(Math.sqrt(l128.squared()));
            const coneAngle = MsAtan2(len, this.mScale);
            psVecNormalize(l128, l128);
            for (let i = 0; i <= this.mVtxCount; i++) {
                const angle = fr(i * fr(360 / this.mVtxCount));
                const ec = new V3();
                ec.add(l140.clone().scale(MsCos(angle))); ec.add(l134.clone().scale(MsSin(angle)));
                const f8 = new V3();
                coneInPlane(this.unk00, coneAngle, l128, ec, b.n, b.d, f8);
                this.mVtx.push(f8);
            }
        }
    }
}

const BEAM_MGRS = new WeakMap<World, BeamManager>();
export class BeamManager {
    /** mColor */
    mColor = [128, 128, 64, 255];
    mBeamVtxCount = 10;
    mBeams: ConeBeam[] = [];
    static get(w: World) { let m = BEAM_MGRS.get(w); if (!m) BEAM_MGRS.set(w, m = new BeamManager(w)); return m; }
    constructor(public world: World) { }
    /** requestCone(pos: the base centre unless the line hits the map first, dir: the apex, scale, glow pass, apex alpha 0, cut by the map) */
    requestCone(pos: V3, dir: V3, scale: number, p4: boolean, p5: boolean, p6: boolean) {
        const beam = new ConeBeam();
        beam.unk1C = p4;
        this.mBeams.push(beam);
        let bg: BGCheckData | null = null;
        const hit = [0, 0, 0];
        if (p6) bg = this.world.col.intersectLine([pos.x, pos.y, pos.z], [dir.x, dir.y, dir.z], false, hit);
        const intersect = bg ? new V3(hit[0], hit[1], hit[2]) : dir.clone();
        beam.unk00.set(pos);
        beam.unk1D = p5;
        beam.unk0C.set(intersect);
        beam.mScale = scale;
        beam.mBGCheckData = bg;
        beam.calcVertices(this.mBeamVtxCount);
    }
    /** drawAllBeam (CUE_DRAW): the cones requested since, then none */
    drawAllBeam() { const b = this.mBeams; this.mBeams = []; return b; }
}
