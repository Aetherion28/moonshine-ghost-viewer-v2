// Corona Mountain's bath water (TBathWaterManager, Map/BathWaterManager.cpp; scene.bin "BathWater",
// named "バスタブの水"): the hot water in Bowser's tub (mapobj/bathtub.ts, "バスタブ") is two sets of
// balls (TBathWater, each up to 500 TDrops of /MapObj/bathwater_wave.prm and bathwater_overflow.prm):
// every 4th tick each ball moves by its velocity, is pushed out of the tub's bowl (a sphere of
// radius unk3C round mPos, cut off unk44 down: TDrop::calcBathtub), falls by gravity (towards the
// tub's tilted up while it tumbles), and pushes apart from the others (intersects); the balls that
// fall out under the tub are put back at the bowl's rim (getPos) or dropped. Each set burns Mario
// when he touches a ball (tryHitMario), the first one when he's under the water's cap disc
// (tryHitMario2); he's then thrown back onto the rim (throwMario). While the tub sloshes
// (TBathtubData::unk64) an overflow ball is launched over the low side every 8th tick.
//
// The surface the riders float on (getWaterHeight: Peach's and Bowser Jr.'s TBathtubBinder) is the
// renderer's: the flat one (displaysMesh 0 in /MapObj/bathwaterglobal.prm) has none (0), the mesh
// one (displaysMesh 1) draws the balls (ball.bmd scaled by modelScale..modelScale2) and the cap
// discs from above, orthographically, into the Z buffer, copies it (meshTexWidth^2 texels over
// meshWidth units round the water's centre) and reads it back as a height grid
// (TBathWaterMeshRenderer::makeHeightMap). Here that render is done on the CPU (MeshRenderer.prerender):
// each grid texel takes the highest of the balls' sphere tops and the discs at its centre, in the
// 24-bit depth's steps. The game does this on the draw cue; here it runs at the end of every move tick,
// after the drops (the riders, performed before this, read the one of the tick before, as in the game
// they read the one drawn the frame before). getHeightMap() hands the grid out for the viewer.
//
// Not here: drawing (the flat renderer's sprites and EFB alpha copy, the mesh renderer's normal map,
// texture coordinates, display lists, the mist and the TBathWaterPreprocessor), the flood sound
// (MSD_SE_BS_KOOPA_FLOOD at unk78 with unk84, which is kept), TBathWaterGlobalParams' colours.
// TODO: ball.bmd is taken as a unit sphere and the texel at its centre; the GPU's rasterisation of its
// polygons (and the exact depth conversion) differs a little.

import { fr, V3, Quat } from './math.js';
import { World, Stream, NameRef, CUE_MOVE, HitActor, MSG, HF, HC, readParams, PSchema } from './engine.js';
import { AT } from './actortypes.js';
import { register } from './scene.js';
import { quatRotate } from './enemies/animal.js';
import type { Bathtub, BathtubData } from './mapobj/bathtub.js';

const PI = 3.1415927;

/** TBathWaterParams (PARAM_INIT order) */
export const BATHWATER_PARAMS = {
    suppliesDrops: ['u8', 1], bathtubGravity: ['u8', 1], intersects: ['u8', 1], isVisible: ['u8', 1], checksMario: ['u8', 1],
    numDrops: ['i', 120], dropRadius: ['f', 300], texScale: ['f', 3], hitScale: ['f', 5], modelScale: ['f', 1.5], modelScale2: ['f', 1],
    modelScaleY: ['f', 1], gravity: ['f', 18], bounceY: ['f', 0.05], bounceXZ: ['f', 0.5], damp: ['f', 0.985], jump: ['f', 65],
    overGravity: ['f', 0], emitVel: ['f', 20], lifeTime: ['i', 0],
} satisfies PSchema;
export type BathWaterParams = { [K in keyof typeof BATHWATER_PARAMS]: number };
/** TBathWaterGlobalParams (/MapObj/bathwaterglobal.prm): the ones read here (the rest are colours) */
export const BATHWATER_GLOBAL_PARAMS = {
    showsCap: ['u8', 1], displaysMesh: ['u8', 0], meshTexWidth: ['i', 80], meshWidth: ['f', 7000],
} satisfies PSchema;
type GlobalParams = { [K in keyof typeof BATHWATER_GLOBAL_PARAMS]: number };

// ---------------------------------------------------------------- JMath::TRandomFast
const f32buf = new DataView(new ArrayBuffer(4));
export class RandomFast {
    constructor(public value = 0) { }
    get() { this.value = (Math.imul(this.value, 0x19660d) + 0x3c6ef35f) >>> 0; return this.value; }
    get_ufloat_1() { f32buf.setUint32(0, ((this.get() >>> 9) | 0x3f800000) >>> 0); return fr(f32buf.getFloat32(0) - 1); }
    get_float(min: number, max: number) { return fr(min + fr(fr(max - min) * this.get_ufloat_1())); }
    get_float01() { return this.get_float(0, 1); }
}

// ---------------------------------------------------------------- TBathtubData helpers (Map/BathWaterManager.hpp)
const at = (D: BathtubData, r: number, c: number) => D.unk18[r * 4 + c];
const dot = (a: V3, b: V3) => fr(fr(fr(a.x * b.x) + fr(a.y * b.y)) + fr(a.z * b.z));
/** getGravityDir */
function getGravityDir(D: BathtubData, amount: number) {
    if (!D.unk65) {
        const up = new V3(0, 1, 0);
        const q = new Quat().setRotateFromTo(D.unk0C, up, amount);
        return quatRotate(q, up).fround();
    }
    return new V3(0, 1, 0);
}
/** getPos: the i-th of j points round the bowl, a spiral from the rim (i = 0) to the bottom */
function getPos(D: BathtubData, i: number, j: number, h: number) {
    const angle = fr(i * fr(PI / 10)), t = fr(i / j), amp = fr(t * fr(D.unk3C - h));
    const r = D.mPos.clone();
    const s = fr(amp * fr(Math.sin(angle)));
    r.x = fr(r.x + fr(at(D, 0, 0) * s)); r.y = fr(r.y + fr(at(D, 0, 1) * s)); r.z = fr(r.z + fr(at(D, 0, 2) * s));
    const c = fr(amp * fr(Math.cos(angle)));
    r.x = fr(r.x + fr(at(D, 2, 0) * c)); r.y = fr(r.y + fr(at(D, 2, 1) * c)); r.z = fr(r.z + fr(at(D, 2, 2) * c));
    const y = fr(fr(1 - t) * -fr(D.unk44 - h));
    r.x = fr(r.x + fr(at(D, 1, 0) * y)); r.y = fr(r.y + fr(at(D, 1, 1) * y)); r.z = fr(r.z + fr(at(D, 1, 2) * y));
    return r;
}
const capRadius = (D: BathtubData) => fr(Math.sqrt(fr(fr(D.unk3C * D.unk3C) - fr(D.unk44 * D.unk44))));

// ---------------------------------------------------------------- TBathWater::TDrop
/** JGeometry::TBox3 (i, f) grown to take in p (it starts at 0, 0, 0) */
class Box { i = new V3(); f = new V3(); zero() { this.i.zero(); this.f.zero(); }
    extend(p: V3) {
        this.i.x = Math.min(this.i.x, p.x); this.i.y = Math.min(this.i.y, p.y); this.i.z = Math.min(this.i.z, p.z);
        this.f.x = Math.max(this.f.x, p.x); this.f.y = Math.max(this.f.y, p.y); this.f.z = Math.max(this.f.z, p.z);
    }
    copy(o: Box) { this.i.set(o.i); this.f.set(o.f); }
}
export class Drop {
    /** position, velocity, the push-outs this step, the velocity changes this step, the size share, age */
    unk0 = new V3(); unkC = new V3(); unk18 = new Box(); unk30 = new Box(); unk48 = 0; unk4C = 0;
    reset(p: V3, t: number) { this.unk48 = t; this.unk0.set(p); this.unkC.zero(); this.unk18.zero(); this.unk30.zero(); this.unk4C = 0; }
    copy(o: Drop) { this.unk0.set(o.unk0); this.unkC.set(o.unkC); this.unk18.copy(o.unk18); this.unk30.copy(o.unk30); this.unk48 = o.unk48; this.unk4C = o.unk4C; }
    /** doThing (fabricated): the push-outs moved by, the velocity damped and the changes added */
    doThing(damp: number) { this.unk0.add(this.unk18.i).add(this.unk18.f); this.unkC.scale(damp).add(this.unk30.i).add(this.unk30.f); }
    /** calcBathtub: pushed out of the bowl's wall / floor, or over its outer rim; gravity; the ones inside counted */
    calcBathtub(D: BathtubData, radius: number, grav1: V3, grav2: V3, acc: { count: number; accum: V3 }) {
        const m = new V3(at(D, 0, 1), at(D, 1, 1), at(D, 2, 1));
        const delta = V3.sub(this.unk0, D.mPos);
        const outerR = fr(D.unk40 + radius), innerR = fr(D.unk3C - radius);
        const distSq = fr(delta.squared()), proj = dot(m, delta);
        if (distSq <= fr(outerR * outerR)) {
            if (proj < 0) {
                if (distSq >= fr(innerR * innerR)) {
                    const dist = fr(Math.sqrt(distSq)), pen = fr(dist - innerR), inv = fr(-1 / dist);
                    const n = delta.clone().scale(inv);
                    this.unk18.extend(n.clone().scale(pen));
                    let c = -dot(n, this.unkC);
                    if (c < 0) c = 0;
                    this.unk30.extend(n.clone().scale(c).add(D.unk58));
                } else {
                    const f = fr(radius + fr(D.mPos.y - D.unk44));
                    if (this.unk0.y < f) {
                        this.unk18.extend(new V3(0, fr(f - this.unk0.y), 0));
                        this.unk30.extend(new V3(0, fr(-1 * this.unkC.y), 0).add(D.unk58));
                    } else { acc.count++; acc.accum.add(this.unk0); }
                }
            } else { acc.count++; acc.accum.add(this.unk0); }
            this.unk30.extend(grav1);
        } else {
            if (proj > 0 && proj < fr(radius + D.unk48) && distSq > fr(innerR * innerR) && distSq < fr(outerR * outerR)) {
                this.unk18.extend(m.clone().scale(fr(fr(radius + D.unk48) - proj)));
                const r = m.clone().scale(fr(1.5 * -dot(m, this.unkC)));
                const thing = delta.clone(), l = thing.length();
                if (l > 0) thing.scale(fr(fr(0.01 * radius) / l));   // setLength
                r.add(thing);
                this.unk30.extend(r);
                this.unk30.extend(grav2);
            } else { this.unk30.extend(grav2); acc.count++; acc.accum.add(this.unk0); }
        }
    }
}

// ---------------------------------------------------------------- TBathWater
export class BathWater extends HitActor {
    unk68 = new RandomFast(0);
    /** the scroll counter (TBathWaterMeshRenderer's texture scroll: never counted up here, as in the game) */
    unk6C = 0;
    unk70 = 500; unk74 = 0;
    /** the drops' average and the flood sound's volume */
    unk78 = new V3(); unk84 = 0;
    unk88: Drop[] = [];
    unk8C!: BathWaterParams;
    constructor() { super('HitActor'); for (let i = 0; i < this.unk70; i++) this.unk88.push(new Drop()); }
    initialize(P: BathWaterParams, D: BathtubData) {
        this.unk8C = P; this.unk74 = P.numDrops;
        for (let i = 0; i < this.unk70; i++) this.unk88[i].reset(getPos(D, i, this.unk70, P.dropRadius), this.unk68.get_float01());
        this.initHitActor(AT.BATH_WATER, 1, HC.PLAYER, P.dropRadius, fr(P.dropRadius * 2), 0, 0);
        this.onHitFilter(HF.NO_COLLISION); this.onHitFilter(HF.NO_DAMAGE);
        this.unk78.zero(); this.unk84 = 0;
    }
    addDrop(p: V3, vy: number) {
        if (this.unk74 < this.unk8C.numDrops) {
            const d = this.unk88[this.unk74];
            d.reset(p, this.unk68.get_float01());
            d.unkC.y = vy;
            this.unk74++;
        }
    }
    eraseDrop(idx: number) {
        if (idx < this.unk74) { this.unk74--; if (idx < this.unk74) this.unk88[idx].copy(this.unk88[this.unk74]); return true; }
        return false;
    }
    /** tryHitMario: a ball touches Mario: he's burnt (by it, put at the ball's bottom) */
    tryHitMario(mario: HitActor) {
        const P = this.unk8C;
        const rr = fr(P.dropRadius * P.hitScale), upper = fr(mario.damageHeight + rr), radH = fr(rr + mario.damageRadius), radH2 = fr(radH * radH);
        const mx = mario.pos.x, my = mario.pos.y, mz = mario.pos.z;
        for (let i = 0; i < this.unk74; i++) {
            const d = this.unk88[i];
            const dy = fr(d.unk0.y - my);
            if (!(dy > upper) && !(dy < -rr)) {
                const dx = fr(mx - d.unk0.x), dz = fr(mz - d.unk0.z);
                if (fr(fr(dx * dx) + fr(dz * dz)) < radH2) {
                    this.attackRadius = P.dropRadius; this.calcEntryRadius();
                    this.attackRadius = fr(P.dropRadius * 2); this.calcEntryRadius();
                    this.pos.set(d.unk0); this.pos.y = fr(this.pos.y - P.dropRadius);
                    mario.receiveMessage(this, MSG.BURN);
                    return true;
                }
            }
        }
        return false;
    }
    /** tryHitMario2: Mario under the water's cap disc (in the water's depth) is burnt */
    tryHitMario2(mario: HitActor, D: BathtubData) {
        const mx = mario.pos.x, my = mario.pos.y, mz = mario.pos.z, mdh = mario.damageHeight;
        const cap = D.getThing(), rad = capRadius(D);
        if (cap.y < my) return false;
        const h = fr(D.unk3C - D.unk44);
        if (fr(my + mdh) < fr(cap.y - h)) return false;
        const dx = fr(mx - cap.x), dz = fr(mz - cap.z);
        if (fr(fr(dx * dx) + fr(dz * dz)) >= fr(rad * rad)) return false;
        this.attackRadius = rad;
        this.pos.set(D.getThing()); this.pos.y = fr(this.pos.y - h);
        this.attackHeight = h; this.calcEntryRadius();
        mario.receiveMessage(this, MSG.BURN);
        return true;
    }
    /** TDrop::calcWaterModel: one step of the balls */
    calcWaterModel(D: BathtubData) {
        const P = this.unk8C, drops = this.unk88;
        const gravity = P.gravity;
        const grav1 = getGravityDir(D, P.overGravity).scale(-gravity);
        const grav2 = new V3(0, -gravity, 0);
        let end2 = this.unk74;
        const dropRadius = P.dropRadius;
        const acc = { count: 0, accum: new V3() };
        if (at(D, 1, 1) > 0) {
            for (let i = 0; i < end2; i++) {
                const d = drops[i];
                d.unk0.add(d.unkC); d.unk18.zero(); d.unk30.zero();
                d.calcBathtub(D, dropRadius, grav1, grav2, acc);
            }
        } else {
            for (let i = 0; i < end2; i++) {
                const d = drops[i];
                d.unk0.add(d.unkC); d.unk18.zero(); d.unk30.zero();
                d.unk30.extend(grav2);
                acc.accum.add(d.unk0); acc.count++;
            }
        }
        let heightVal: number;
        if (acc.count * 30 > this.unk74) {
            acc.accum.scale(fr(1 / acc.count));
            const t = fr(fr(3 * acc.count) / this.unk74);
            heightVal = fr(Math.sqrt(t));
            if (heightVal > 1) heightVal = 1;
        } else heightVal = 0;
        this.unk78.set(acc.accum); this.unk84 = heightVal;

        const step = P.intersects;
        if (step) {
            const twoR = fr(2 * dropRadius), sep2 = fr(4 * fr(dropRadius * dropRadius));
            for (let ai = 0; ai < end2; ai++) {
                const a = drops[ai];
                for (let bi = ai + step; bi < end2; bi += step) {
                    const b = drops[bi];
                    const l = V3.sub(b.unk0, a.unk0);
                    if (!(fr(l.squared()) > sep2)) {
                        const dist = fr(l.length());
                        const n = l.clone().scale(fr(1 / dist));
                        const half = fr(fr(twoR - dist) / 2);
                        const hny = fr(half * n.y);
                        l.set(fr(n.x * half), fr(fr(n.y + 1) * hny), fr(n.z * half));
                        b.unk18.extend(l);
                        l.x = -l.x; l.z = -l.z; l.y = fr(fr(n.y - 1) * hny);
                        a.unk18.extend(l);
                        let mag = hny;
                        if (mag < fr(twoR - dist)) mag = fr(twoR - dist);
                        n.x = fr(n.x * fr(mag * P.bounceXZ)); n.y = fr(n.y * fr(mag * P.bounceY)); n.z = fr(n.z * fr(mag * P.bounceXZ));
                        b.unk30.extend(n);
                        n.x = -n.x; n.y = -n.y; n.z = -n.z;
                        a.unk30.extend(n);
                    }
                }
            }
        }

        let threshold = fr(D.mPos.y - D.unk3C);
        if (D.unk65) threshold = fr(D.mPos.y - fr(8 * D.unk3C));
        let respawnIdx = 0;
        for (let i = 0; i < end2; i++) {
            const d = drops[i];
            if (d.unk0.y < threshold) {
                if (P.suppliesDrops && !D.unk65) d.reset(getPos(D, respawnIdx++, this.unk70, dropRadius), this.unk68.get_float01());
                else if (this.eraseDrop(i)) { end2--; d.doThing(P.damp); }
            } else d.doThing(P.damp);
        }
        const lifeTime = P.lifeTime;
        if (lifeTime > 0) {
            // (sic: the end comes down as the drop goes up)
            for (let i = 0; i < end2; --end2, ++i) {
                const d = drops[i];
                d.unk4C++;
                if (d.unk4C > lifeTime) this.eraseDrop(i);
            }
        }
        if (this.unk74 < P.numDrops) {
            if (P.suppliesDrops && !D.unk65) drops[this.unk74++].reset(getPos(D, respawnIdx++, this.unk70, dropRadius), this.unk68.get_float01());
        } else if (this.unk74 > P.numDrops) this.unk74 = P.numDrops;
    }
}

// ---------------------------------------------------------------- renderers (what getHeight asks)
interface Renderer { prerender(D: BathtubData, waters: BathWater[], params: BathWaterParams[]): void; getHeight(x: number, z: number): number; }
/** TBathWaterFlatRenderer: no surface */
class FlatRenderer implements Renderer { prerender() { } getHeight() { return 0; } }

/** TBathWaterMeshRenderer: the height grid (unk20[x][z].y), its cell (unk80080) and origin (unk80050's translation) */
export class MeshRenderer implements Renderer {
    /** unk800AC: the grid's size (0 until the first render) */
    unk800AC = 0;
    unk20 = new Float32Array(128 * 128);
    unk80080 = new V3(1, 1, 1);
    /** unk80050's translation */
    origin = new V3();
    constructor(public G: GlobalParams) { }
    /** prerender + render's makeHeightMap: the balls and caps seen from 3R above the water's centre, 4R deep */
    prerender(D: BathtubData, waters: BathWater[], params: BathWaterParams[]) {
        const G = this.G;
        const negR = -D.unk3C, R3 = fr(3 * D.unk3C);
        const n = this.unk800AC = G.meshTexWidth & ~3;
        if (n < 1) return;
        const unk800B0 = fr(1 / n);
        const thing = D.getThing();
        const ey = fr(thing.y + R3), depthRange = fr(R3 - negR);
        const cell = fr(unk800B0 * G.meshWidth);
        const x0 = fr(fr(-0.5 * G.meshWidth) + thing.x), z0 = fr(fr(-0.5 * G.meshWidth) + thing.z);
        // the Z buffer: the highest surface at each texel's centre (cleared far = ey - depthRange)
        const top = new Float64Array(n * n).fill(-Infinity);
        for (let w = 0; w < waters.length; w++) {
            const P = params[w];
            if (!P.isVisible) continue;
            const bw = waters[w];
            for (let k = 0; k < bw.unk74; k++) {
                const d = bw.unk88[k];
                const t = d.unk48;
                const rad = fr(P.dropRadius * fr(fr(t * P.modelScale) + fr(fr(1 - t) * P.modelScale2)));
                const px = d.unk0.x, py = fr(d.unk0.y + fr(fr(P.modelScaleY * P.dropRadius) - rad)), pz = d.unk0.z;
                const i0 = Math.max(0, Math.floor((px - rad - x0) / cell)), i1 = Math.min(n - 1, Math.floor((px + rad - x0) / cell));
                const j0 = Math.max(0, Math.floor((pz - rad - z0) / cell)), j1 = Math.min(n - 1, Math.floor((pz + rad - z0) / cell));
                for (let i = i0; i <= i1; i++) {
                    const dx = x0 + (i + 0.5) * cell - px;
                    for (let j = j0; j <= j1; j++) {
                        const dz = z0 + (j + 0.5) * cell - pz, q = rad * rad - dx * dx - dz * dz;
                        if (q < 0) continue;
                        const y = py + Math.sqrt(q);
                        if (y > top[i * n + j]) top[i * n + j] = y;
                    }
                }
            }
        }
        if (G.showsCap && !D.unk65) {
            const rad = capRadius(D);
            const disc = (cy: number, r: number) => {
                for (let i = 0; i < n; i++) {
                    const dx = x0 + (i + 0.5) * cell - thing.x;
                    for (let j = 0; j < n; j++) {
                        const dz = z0 + (j + 0.5) * cell - thing.z;
                        if (dx * dx + dz * dz <= r * r && cy > top[i * n + j]) top[i * n + j] = cy;
                    }
                }
            };
            disc(thing.y, rad);
            disc(fr(thing.y + fr(0.5 * negR)), fr(fr(unk800B0 * G.meshWidth) + rad));
        }
        // render: unk80080 = (cell, -R - 3R, cell), the origin at the grid's corner, 3R above the water's centre
        this.unk80080.set(cell, fr(-D.unk3C - R3), cell);
        this.origin.set(x0, ey, z0);
        // makeHeightMap(unk80080.y): h * (24-bit depth / 2^24)
        const h = this.unk80080.y;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            let depth = (ey - top[i * n + j]) / depthRange;
            if (!(depth >= 0) || depth > 1) depth = 1;   // nothing there / clipped: the far plane
            const v = Math.min(0xFFFFFF, Math.floor(depth * 0x1000000));
            this.unk20[i * 128 + j] = fr(h * fr(v * (1 / 16777216)));
        }
    }
    /** getHeight: the grid cell under (x, z), clamped to the grid */
    getHeight(x: number, z: number) {
        const n = this.unk800AC;
        if (n < 1) return 0;
        let i = Math.trunc(fr(fr(x - this.origin.x) / this.unk80080.x));
        i = i < 0 ? 0 : i >= n ? n - 1 : i;
        let j = Math.trunc(fr(fr(z - this.origin.z) / this.unk80080.z));
        j = j < 0 ? 0 : j >= n ? n - 1 : j;
        return fr(this.unk20[i * 128 + j] + this.origin.y);
    }
}

// ---------------------------------------------------------------- TBathWaterManager
/** CalcJumpVelocityY (BathWaterManager.cpp's own): the velocity that lands from initial on desired's height at desired */
function calcJumpVelocityY(desired: V3, initial: V3, vy0: number, g: number, minY: number) {
    let y = initial.y, vy = vy0, count = 1;
    for (; ;) {
        y = fr(y + vy);
        if (vy < 0 && y <= desired.y) break;
        vy = fr(vy - g);
        if (vy < minY) vy = minY;
        count++;
    }
    return new V3(fr(fr(desired.x - initial.x) / count), vy0, fr(fr(desired.z - initial.z) / count));
}

export class BathWaterManager extends NameRef {
    unk10 = new RandomFast(0);
    unk14: BathWaterParams[] = [];
    unk18!: GlobalParams;
    unk1C = 0;
    unk20: BathWater[] = [new BathWater(), new BathWater()];
    unk24: Bathtub | null = null;
    unk28: Renderer[] = [];
    unk30: Renderer | null = null;
    static fileNames = ['MapObj/bathwater_wave.prm', 'MapObj/bathwater_overflow.prm'];
    constructor(public world: World, name = 'バスタブの水') { super(name); }
    load(s: Stream) {
        super.load(s);
        this.unk18 = readParams('/MapObj/bathwaterglobal.prm', this.world.files, BATHWATER_GLOBAL_PARAMS);
        for (let i = 0; i < 2; ++i) this.unk14[i] = readParams(BathWaterManager.fileNames[i], this.world.files, BATHWATER_PARAMS);
    }
    loadAfter() {
        super.loadAfter();
        this.unk28 = [new FlatRenderer(), new MeshRenderer(this.unk18)];
        this.unk30 = this.unk28[1];
        this.world.conductor.others.push(this);
    }
    /** initializeIfYet_: once the tub is set up, both sets put round its bowl and run 200 steps */
    initializeIfYet_() {
        if (this.unk24) return;
        const tub = this.world.search('バスタブ') as unknown as Bathtub | null;
        if (tub && tub.unk298) {
            const D = tub.getBathtubData();
            for (let a = 0; a < 2; ++a) {
                this.unk20[a].initialize(this.unk14[a], D);
                for (let it = 0; it < 200; it++) this.unk20[a].calcWaterModel(D);
            }
            this.unk24 = tub;
        }
    }
    getWaterHeight(x: number, z: number) {
        if (this.unk24 && this.unk30) return this.unk30.getHeight(x, z);
        return 0;
    }
    /** The mesh renderer's height grid for the viewer (null with the flat renderer / before the first one):
     *  heights[i * 128 + j] + origin.y is the surface over x = origin.x + (i + 0.5) * cell, z = origin.z + (j + 0.5) * cell, i, j < n. */
    getHeightMap(): { n: number; cell: number; origin: V3; heights: Float32Array } | null {
        const r = this.unk30;
        if (!this.unk24 || !(r instanceof MeshRenderer) || r.unk800AC < 1) return null;
        return { n: r.unk800AC, cell: r.unk80080.x, origin: r.origin, heights: r.unk20 };
    }
    /** throwMario: Mario thrown onto the rim (4150 out, 120 up, if he's within 4500 of the centre), else straight up at speed */
    throwMario(speed: number) {
        const D = this.unk24!.getBathtubData(), m = this.world.mario as any;
        const diff = V3.sub(m.pos, D.mPos);
        const xDir = new V3(at(D, 0, 0), at(D, 1, 0), at(D, 2, 0));
        const yDir = new V3(at(D, 0, 1), at(D, 1, 1), at(D, 2, 1));
        const zDir = new V3(at(D, 0, 2), at(D, 1, 2), at(D, 2, 2));
        const horiz = new V3(dot(diff, xDir), 0, dot(diff, zDir));
        void yDir;
        let vel: V3;
        if (horiz.length() < 4500) {
            const l = horiz.length();
            if (l > 0) horiz.scale(fr(4150 / l));   // setLength
            const R = D.unk18;
            const w = new V3(fr(fr(fr(R[0] * horiz.x) + fr(R[1] * horiz.y)) + fr(R[2] * horiz.z)), fr(fr(fr(R[4] * horiz.x) + fr(R[5] * horiz.y)) + fr(R[6] * horiz.z)),
                fr(fr(fr(R[8] * horiz.x) + fr(R[9] * horiz.y)) + fr(R[10] * horiz.z)));
            w.add(D.mPos); w.y = fr(w.y + 120);
            const g = m.mJumpParams ? m.mJumpParams.mGravity : 0.8;   // SMS_GetMarioGravity
            vel = calcJumpVelocityY(w, m.pos, 100, g, -75);
        } else vel = new V3(0, speed, 0);
        if (typeof m.throwMario === 'function') m.throwMario(vel, fr(vel.length()));   // SMS_ThrowMario
    }
    perform(cue: number) {
        if (!this.unk24) { this.initializeIfYet_(); return; }
        const tub = this.unk24, w = this.world;
        if (!(cue & CUE_MOVE)) return;
        this.unk30 = this.unk28[this.unk18.displaysMesh] || null;
        this.unk1C = (this.unk1C + 1) & 0xFF;
        if (!(this.unk1C & 3)) {
            for (let a = 0; a < 2; ++a) this.unk20[a].calcWaterModel(tub.getBathtubData());
            if (!tub.unk29A) {
                const mario = w.mario as unknown as HitActor;
                const gameOver = () => ((((w.mario as any).marioFlags ?? 0) & 0x400) !== 0);   // MARIO_FLAG_GAME_OVER
                for (let i = 0; i < 2; ++i)
                    if (!gameOver() && this.unk14[i].checksMario && this.unk20[i].tryHitMario(mario)) this.throwMario(this.unk14[i].jump);
                if (!gameOver() && this.unk20[0].tryHitMario2(mario, tub.getBathtubData())) this.throwMario(this.unk14[0].jump);
            }
            // the overflow: a ball over the low side every 8th tick while it sloshes
            const D = tub.getBathtubData();
            if ((this.unk1C & 7) === 4 && D.unk64) {
                const radius = this.unk14[1].dropRadius, rnd1 = this.unk10.get_float(-1, 1);
                const p = calcOverflowPos(D, radius, rnd1);
                if (p) this.unk20[1].addDrop(p, this.unk10.get_float01());
            }
            // (MSD_SE_BS_KOOPA_FLOOD at unk20[0].unk78, volume unk84: not here)
        }
        // the draw cue's prerender / render: the surface
        if (this.unk30) this.unk30.prerender(tub.getBathtubData(), this.unk20, this.unk14);
    }
}

/** fakeCalcPos (fabricated name, inlined in perform): the overflow ball's start, on the tub's low side, rnd1 across it */
function calcOverflowPos(D: BathtubData, radius: number, rnd1: number): V3 | null {
    const axis = new V3(at(D, 0, 1), 0, at(D, 2, 1));
    if (axis.x * axis.x + axis.y * axis.y + axis.z * axis.z <= 3.8146973e-6) return null;   // isZero
    const nAxis = axis.clone().normalize();
    const cross = new V3().cross(nAxis, new V3(0, 1, 0)).fround().normalize();
    const perturb = fr(0.18 * rnd1);
    nAxis.x = fr(nAxis.x + fr(cross.x * perturb)); nAxis.y = fr(nAxis.y + fr(cross.y * perturb)); nAxis.z = fr(nAxis.z + fr(cross.z * perturb));
    const h = fr(0.9 * fr(D.unk3C - radius)), l = nAxis.length();
    if (l > 0) nAxis.scale(fr(h / l));   // setLength
    const c = D.getThing();
    return new V3(fr(fr(radius * 0 + nAxis.x) + c.x), fr(fr(radius + nAxis.y) + c.y), fr(fr(radius * 0 + nAxis.z) + c.z));
}

register('BathWater', (w) => new BathWaterManager(w));
