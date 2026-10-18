// JPA particles (JSystem/JParticle) for the viewer: the emitter and particle maths of
// JPABaseEmitter::calc / createParticle, JPAParticle, JPABaseField and JPADraw's calc visitors,
// and the shapes JPADraw's exec visitors draw (billboards, directional crosses, stripes), fed by
// tools/build_jpa.py's JPA_RES. Only what the viewer's effects use is filled in; the rest is
// marked. Needs three.js.
//
// The game's emitters draw from one running random sequence. Here each calc reseeds from the
// emitter's seed and its calc count, so a stretch of frames can be simulated on its own and
// scrubbing shows the same particles every time.

const JPA = (() => {
  const S16 = (v) => (Math.trunc(v) << 16) >> 16;
  const sinS = (a) => Math.sin(a * Math.PI / 32768), cosS = (a) => Math.cos(a * Math.PI / 32768);   // JMASSin / JMASCos

  // JMath::TRandom_fast_
  class Rng {
    constructor(seed) { this.v = seed >>> 0; }
    get() { this.v = (Math.imul(this.v, 0x19660d) + 0x3c6ef35f) >>> 0; return this.v; }
    f() { return (this.get() >>> 9) / 8388608; }   // get_ufloat_1: [0, 1)
    rf() { return this.f() * 2 - 1; }               // getRandomRF
    sf() { return this.f() - 0.5; }                 // getRandomSF
    ss() { return (this.get() & 0xffff) - 0x8000; } // getRandomSS
    rs() { return (this.get() & 0x7fff) - 0x4000; } // getRandomRS
  }
  const hash = (a, b, c) => {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  };

  // 3x3 row-major rotations (JPAMath)
  function xyzRot(x, y, z) {
    const cx = cosS(x), sx = sinS(x), cy = cosS(y), sy = sinS(y), cz = cosS(z), sz = sinS(z);
    return [cz * cy, -sz * cx + cz * sy * sx, sz * sx + cz * sy * cx,
      sz * cy, cz * cx + sz * sy * sx, -cz * sx + sz * sy * cx,
      -sy, cy * sx, cy * cx];
  }
  function xyRot(x, y) {
    const cx = cosS(x), sx = sinS(x), cy = cosS(y), sy = sinS(y);
    return [cy, sy * sx, sy * cx, 0, cx, -sx, -sy, cy * sx, cy * cx];
  }
  function yzRot(y, z) {
    const cy = cosS(y), sy = sinS(y), cz = cosS(z), sz = sinS(z);
    return [cz * cy, -sz, cz * sy, sz * cy, cz, sz * sy, -sy, 0, cy];
  }
  function yRot(y) { const c = cosS(y), s = sinS(y); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function vecToRota(a, b) {   // JPAVecToRotaMtx: turns b onto a
    let ax = a[1] * b[2] - a[2] * b[1], ay = a[2] * b[0] - a[0] * b[2], az = a[0] * b[1] - a[1] * b[0];
    const sn = Math.hypot(ax, ay, az), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (sn > 1.1920929e-7) { ax /= sn; ay /= sn; az /= sn; } else ax = ay = az = 0;
    const k = 1 - c;
    return [c * (1 - ax * ax) + ax * ax, ax * ay * k + az * sn, ax * az * k - ay * sn,
      ay * ax * k - az * sn, c * (1 - ay * ay) + ay * ay, ay * az * k + ax * sn,
      az * ax * k + ay * sn, az * ay * k - ax * sn, c * (1 - az * az) + az * az];
  }
  const mul3 = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];
  const mv3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const norm = (v) => { const l = len(v); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
  const setLen = (v, n) => { const l = len(v); return l > 0 ? [v[0] / l * n, v[1] / l * n, v[2] / l * n] : [0, 0, 0]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const isZero = (v) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2] <= 3.8e-6;   // TVec3::isZero (32 * FLT_EPSILON)

  // Derived values the block constructors work out (JPAExtraShape, JPABaseShape).
  function prepare(res) {
    if (res.ready) return res;
    const es = res.es;
    if (es) {
      es.alphaInc = es.alphaIn !== 0 ? (es.alphaBase - es.alphaInVal) / es.alphaIn : 1;
      es.alphaDec = es.alphaOut !== 1 ? (es.alphaOutVal - es.alphaBase) / (1 - es.alphaOut) : 1;
      es.incX = es.scaleIn !== 0 ? (1 - es.scaleInX) / es.scaleIn : 1;
      es.incY = es.scaleIn !== 0 ? (1 - es.scaleInY) / es.scaleIn : 1;
      es.decX = es.scaleOut !== 1 ? (es.scaleOutX - 1) / (1 - es.scaleOut) : 1;
      es.decY = es.scaleOut !== 1 ? (es.scaleOutY - 1) / (1 - es.scaleOut) : 1;
    }
    const bs = res.bs;
    bs.stripe = bs.type === 5 || bs.type === 6;
    bs.alpha = !!(es && es.alphaFlags & 1);
    bs.listOrder = !(bs.flags & 1);
    res.ready = true;
    return res;
  }

  function makeEmitter(res, seed) {
    prepare(res);
    const em = res.em;
    return {
      res, seed: seed >>> 0, calcs: 0, frame: 0, timer: 0, emitTimer: 0, emitNext: true,
      first: true, stopEmit: false, enableDelete: false, maxFrame: em.maxFrame,
      rate: em.rate, volumeSize: em.volumeSize, volumeSweep: em.volumeSweep, life: em.life, weight: em.weight,
      initVelOmni: em.initVelOmni, initVelDir: em.initVelDir, spread: em.spread, keyScl: 1,
      R: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [0, 0, 0], dynScale: [1, 1, 1], ptclScale: [1, 1, 1],
      ptcl: [],   // list head first: newest particles at the front (JSUList::prepend)
      dead: false,
    };
  }
  // Starting part-way into a run: the emitter's frame count and spawn timer after `calcs` calcs
  // (with an emit interval, only the calcs it emitted on count towards the spawn timer).
  function advanceTo(e, calcs) {
    e.calcs = e.frame = calcs;
    const er = emitRate(e.res.em);
    let emits = calcs;
    if (er !== 1) {
      emits = calcs > 0 ? 1 + Math.floor((calcs - 1) * er) : 0;
      const t = calcs * er;
      e.emitTimer = t - Math.floor(t);
      e.emitNext = calcs === 0 || Math.floor(t) > Math.floor((calcs - 1) * er);
    }
    const r = e.rate * emits;
    e.timer = r - Math.floor(r);
    e.first = calcs === 0;
  }
  // JPABaseEmitter::mEmitRate: an emitter with an emit interval only creates particles on one
  // calc in interval + 1.
  const emitRate = (em) => (em.emitInterval ? 1 / (em.emitInterval + 1) + 1e-7 : 1);

  function keyValue(k, t) {   // JPAGetKeyFrameInterpolation
    const K = k.keys, n = K.length / 4;
    if (t < K[0]) return K[1];
    if (K[(n - 1) * 4] <= t) return K[(n - 1) * 4 + 1];
    let b = 0, fr = n;
    while (fr > 1) { const i = fr >> 1; if (t >= K[b + i * 4]) { b += i * 4; fr -= i; } else fr = i; }
    // JMAHermiteInterpolation(t, t0, v0, out0, t1, v1, in1)
    const t0 = K[b], v0 = K[b + 1], o0 = K[b + 3], t1 = K[b + 4], v1 = K[b + 5], i1 = K[b + 6];
    const L = t1 - t0, f9 = t - t0, f1 = 1 / L, f2 = f9 * f9 * f1, f10 = f2 * f1, f11 = f9 * f10, f12 = f11 * f1;
    return v0 * (1 + (2 * f12 - 3 * f10)) + v1 * (-2 * f12 + 3 * f10) + o0 * (f9 + (f11 - 2 * f2)) + i1 * (f11 - f2);
  }
  function calcKeyFrameAnime(e) {
    const res = e.res, keys = res.key;
    if (!keys.length) return;
    let bit = 1, idx = 0;
    for (const k of keys) {
      let stop = false;
      do { if (res.em.keyMask & bit) stop = true; bit <<= 1; idx++; } while (!stop && idx < 32);
      let time = e.frame;
      if (k.loop) { const kf = Math.trunc(k.keys[k.keys.length - 4]) + 1; time -= Math.trunc(e.frame / kf) * kf; }
      const v = keyValue(k, time);
      switch (idx - 1) {
        case 0: e.rate = v; break;
        case 1: e.volumeSize = Math.trunc(v) & 0xffff; break;
        case 2: e.volumeSweep = v; break;
        case 4: e.life = Math.trunc(v); break;
        case 5: e.weight = v; break;
        case 6: case 7: e.initVelOmni = v; break;
        case 8: e.initVelDir = v; break;
        case 9: e.spread = v; break;
        case 10: e.keyScl = v; break;   // JPADraw::setKeyScl
        default: break;                 // 3: unk20C, unused
      }
    }
  }

  // JPABaseEmitter::calcEmitterGlobalParams, from the bound matrix (setGlobalRTMatrix: rotation
  // and translation, scale dropped). M: THREE.Matrix4 elements (column-major).
  function globalParams(e, M) {
    const r = e.R;
    for (let c = 0; c < 3; c++) {
      const x = M[c * 4], y = M[c * 4 + 1], z = M[c * 4 + 2], l = Math.hypot(x, y, z) || 1;
      r[c] = x / l; r[3 + c] = y / l; r[6 + c] = z / l;
    }
    e.T[0] = M[12]; e.T[1] = M[13]; e.T[2] = M[14];
    const em = e.res.em, d = e.dynScale;
    const E = xyzRot(S16(em.rot[0] * 182), S16(em.rot[1] * 182), S16(em.rot[2] * 182));
    const sc = em.scale;
    e.CC = mul3(r, E);
    e.FC = mul3(r, mul3(E, [sc[0], 0, 0, 0, sc[1], 0, 0, 0, sc[2]]));
    e.u30 = [sc[0] * d[0], sc[1] * d[1], sc[2] * d[2]];
    const tr = mv3(r, [em.trans[0] * d[0], em.trans[1] * d[1], em.trans[2] * d[2]]);
    e.u24 = [tr[0] + e.T[0], tr[1] + e.T[1], tr[2] + e.T[2]];
    e.axisY = [e.CC[1], e.CC[4], e.CC[7]];
    const dn = norm(em.dir);
    e.u3C = dn;
    e.u12C = dn[0] === 0 && dn[1] === 0 && dn[2] === 1 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : vecToRota(dn, [0, 0, 1]);
  }

  function createParticle(e, rng) {
    const res = e.res, em = res.em, bs = res.bs, es = res.es;
    const vs = e.volumeSize, sweep = e.volumeSweep, minR = em.volumeMinRad;
    let pos = [0, 0, 0], f31 = null;
    const radius = (dens) => { let d = rng.f(); if (dens) d = Math.sqrt(d); return vs * (minR + d * (1 - minR)); };
    switch (em.volumeType) {
      case 4: break;   // point
      case 6: pos = [0, 0, vs * rng.sf()]; break;   // line (fixed interval: TODO)
      case 5: {        // circle
        const a = S16(rng.get()); rng.get();
        const m = yRot(sweep < 1 ? S16(a * sweep) : a);
        const r = radius(em.flags & 1);
        pos = [m[2] * r, 0, m[8] * r];
        break;
      }
      case 0: pos = [rng.sf() * vs, rng.sf() * vs, rng.sf() * vs]; break;   // cube
      case 1: {        // sphere
        let m;
        if (sweep < 1) { const y = S16(sweep * rng.ss()); m = xyRot(rng.rs(), y); }
        else m = xyzRot(S16(rng.get()), S16(rng.get()), S16(rng.get()));
        const r = radius(em.flags & 1);
        pos = [m[2] * r, m[5] * r, m[8] * r];
        break;
      }
      case 2: {        // cylinder
        const a = sweep < 1 ? S16(sweep * rng.ss()) : S16(rng.get());
        const r = radius(em.flags & 1);
        pos = [r * sinS(a), 2 * vs * rng.sf(), r * cosS(a)];
        break;
      }
      case 3: {        // torus
        const th = sweep < 1 ? S16(sweep * rng.ss()) : S16(rng.get());
        const m = yRot(th), rad = vs * minR, ph = S16(rng.get());
        const q = mv3(m, [0, rad * sinS(ph), rad * cosS(ph)]);
        pos = [vs * sinS(th) + q[0], q[1], vs * cosS(th) + q[2]];
        f31 = q;
        break;
      }
    }
    if (!f31) f31 = [pos[0], 0, pos[2]];
    const f21 = [pos[0] * e.u30[0], pos[1] * e.u30[1], pos[2] * e.u30[2]];
    const local = mv3(e.FC, pos);
    const rscale = em.velRndm * rng.rf() + 1;
    let omni = [0, 0, 0], axis = [0, 0, 0], rnd = [0, 0, 0], dir = [0, 0, 0];
    if (e.initVelOmni !== 0) omni = setLen(em.volumeType === 4 ? [rng.sf(), rng.sf(), rng.sf()] : f21, e.initVelOmni);
    if (em.initVelAxis !== 0) axis = em.volumeType === 4 ? setLen([rng.sf(), 0, rng.sf()], em.initVelAxis) : setLen(f31, em.initVelAxis);
    if (em.initVelRndm !== 0) rnd = [rng.sf() * em.initVelRndm, rng.sf() * em.initVelRndm, rng.sf() * em.initVelRndm];
    if (e.initVelDir !== 0) {
      if (e.spread > 0) {
        const y = S16(32768 * rng.rf() * e.spread), z = S16(rng.get());
        dir = mv3(mul3(e.u12C, yzRot(y, z)), [0, 0, 1]);
      } else dir = e.u3C.slice();
      dir = [dir[0] * e.initVelDir, dir[1] * e.initVelDir, dir[2] * e.initVelDir];
    }
    let v = [dir[0] + rnd[0] + omni[0] + axis[0], dir[1] + rnd[1] + omni[1] + axis[1], dir[2] + rnd[2] + omni[2] + axis[2]];
    if (em.velRndm !== 0) v = [v[0] * rscale, v[1] * rscale, v[2] * rscale];
    if (em.flags & 4) v = [v[0] * em.scale[0], v[1] * em.scale[1], v[2] * em.scale[2]];
    v = mv3(e.CC, v);
    const p = {
      born: true, dead: false, follow: !!(em.flags & 8), u14: e.u24.slice(), local, global: [0, 0, 0], vel: [0, 0, 0],
      base: v, dirN: norm(v), moment: 0, air: 1, weight: 1, drag: 1, curDrag: 1, fVel: [0, 0, 0], fAcc: [0, 0, 0],
      age: 0, prog: 0, life: 1,
    };
    p.moment = em.moment !== 0 ? em.moment * (em.momentRndm * rng.rf() + 1) : 0;
    p.air = Math.min(1, em.airResist + em.airResistRndm * rng.sf());
    p.weight = e.weight * (1 - em.weightRndm * rng.f());
    p.global = [p.local[0] * e.dynScale[0] + p.u14[0], p.local[1] * e.dynScale[1] + p.u14[1], p.local[2] * e.dynScale[2] + p.u14[2]];
    let life = e.life;
    if (em.lifeRndm !== 0) life *= 1 - em.lifeRndm * rng.f();
    p.life = life;
    // JPADraw::initParticle
    p.u0 = e.axisY.slice();
    p.prm = bs.prmFlags & 1 ? bs.prm : [255, 255, 255, 255];
    p.env = bs.envFlags & 1 ? bs.env : [255, 255, 255, 255];
    p.alpha = 1;
    p.loopOff = Math.trunc(rng.f() * bs.loopOffset);
    if (es) {
      if (es.rotate) {
        p.rot = (Math.trunc(es.rotAngle * 32768 + rng.sf() * es.rotAngleRndm * 65536)) & 0xffff;
        const sgn = rng.rf() < es.rotDir ? 1 : -1;
        p.rotSpd = S16(sgn * es.rotSpeed * (es.rotSpeedRndm * rng.rf() + 1) * 32768);
      } else { p.rot = 0; p.rotSpd = 0; }
      p.sx = p.sy = p.sc = e.keyScl * (rng.rf() * es.scaleRndm + 1);
      p.wave = rng.rf() * es.waveRndm + 1;
    } else { p.rot = 0; p.rotSpd = 0; p.sx = p.sy = p.sc = e.keyScl; p.wave = 1; }
    e.ptcl.unshift(p);
  }

  // JPABaseField: what the effects use (gravity, random, drag; air / magnet / newton / vortex /
  // convection: TODO).
  function fieldFade(f, prog) {
    let cut = false, r = 1;
    if (f.status & 0x8 && prog < f.fadeInStart) { r = 0; cut = true; }
    if (f.status & 0x10 && prog >= f.fadeOutEnd) { r = 0; cut = true; }
    if (!cut) {
      if (f.status & 0x40 && prog >= f.fadeOutStart) { const d = f.fadeOutEnd - f.fadeOutStart; if (d > 0) r = (f.fadeOutEnd - prog) / d; }
      else if (f.status & 0x20 && prog < f.fadeInEnd) { const d = f.fadeInEnd - f.fadeInStart; if (d > 0) r = (prog - f.fadeInStart) / d; }
    }
    return r;
  }
  function fieldVelocity(f, p, v) {
    let s = fieldFade(f, p.prog);
    const w = s <= 0 ? [0, 0, 0] : s < 1 ? [v[0] * s, v[1] * s, v[2] * s] : v;
    const tgt = f.addType === 0 ? p.fAcc : f.addType === 1 ? p.base : f.addType === 2 ? p.fVel : null;
    if (tgt) { tgt[0] += w[0]; tgt[1] += w[1]; tgt[2] += w[2]; }
  }
  function fieldsSet(e) {
    for (const f of e.res.fld) {
      if (f.type === 0 || f.type === 1) {   // gravity / air: the direction, in the emitter's frame unless global
        const d = f.status & 0x2 ? f.dir : mv3(e.R, f.dir);
        f.v = [d[0] * f.mag, d[1] * f.mag, d[2] * f.mag];
      }
    }
  }
  function affectFields(e, p, frng) {
    for (const f of e.res.fld) {
      if (f.status & 0x80 && (p.global[0] - f.pos[0]) ** 2 + (p.global[1] - f.pos[1]) ** 2 + (p.global[2] - f.pos[2]) ** 2 >= f.maxDist * f.maxDist) continue;
      switch (f.type) {
        case 0: case 1: fieldVelocity(f, p, f.v); break;
        case 5:
          if (p.age === 0 || (f.cycle && Math.trunc(p.age) % f.cycle === 0)) {
            fieldVelocity(f, p, [(frng.f() - 0.5) * f.mag, (frng.f() - 0.5) * f.mag, (frng.f() - 0.5) * f.mag]);
          }
          break;
        case 6:
          if (p.age === 0) p.drag = Math.min(1, f.magRndm * (frng.f() - 0.5) + f.mag);
          p.curDrag *= 1 - fieldFade(f, p.prog) * (1 - p.drag);
          break;
        default: break;
      }
    }
  }

  // JPADraw's particle calc visitors: rotation, scale and alpha over the particle's life
  // (colour and texture animation: TODO, the effects here have none).
  function scaleAt(es, p, timer, X) {
    const inT = es.scaleIn, outT = es.scaleOut;
    if (timer < inT) return p.sc * ((X ? es.incX : es.incY) * timer + (X ? es.scaleInX : es.scaleInY));
    if (timer > outT) return p.sc * ((X ? es.decX : es.decY) * (timer - outT) + 1);
    return p.sc;
  }
  function timing(es, p, X) {
    const cyc = X ? es.cycleX : es.cycleY, rev = X ? es.anmTypeX : es.anmTypeY, age = Math.trunc(p.age);
    if (!rev) return (age % cyc) / cyc;
    const odd = Math.trunc(age / cyc) & 1, fr = (age % cyc) / cyc;
    return odd + (fr - odd * 2 * fr);
  }
  function calcDraw(e, p) {
    const res = e.res, es = res.es, bs = res.bs;
    p.rot = (p.rot + p.rotSpd) & 0xffff;
    if (es && es.scaleFlags & 1) {
      const sp = () => len(p.vel) * 0.01;
      let tm = es.scaleFlags & 8 ? timing(es, p, true) : p.prog;
      p.sx = scaleAt(es, p, tm, true);
      if (es.scaleFlags & 0x20 && bs.type !== 1) p.sx *= sp();
      if (bs.type !== 0) {
        if (!(es.scaleFlags & 2)) p.sy = p.sx;
        else {
          if (es.scaleFlags & 4) tm = timing(es, p, false);
          else if (es.scaleFlags & 8) tm = p.prog;
          p.sy = scaleAt(es, p, tm, false);
          if (es.scaleFlags & 0x10) p.sy *= sp();
        }
      }
    }
    if (bs.alpha && !bs.stripe) {
      const t = p.prog;
      p.alpha = t < es.alphaIn ? t * es.alphaInc + es.alphaInVal : t > es.alphaOut ? es.alphaBase + es.alphaDec * (t - es.alphaOut) : es.alphaBase;
      if (es.alphaFlags & 2) {
        const th = Math.trunc(p.age) * 16384 * p.wave, w = es.wave;
        if (es.alphaWaveType === 0) p.alpha *= p.wave * ((sinS(th * (1 - w[0])) - 1) * 0.5 * w[2]) + 1;
        else if (es.alphaWaveType === 1) p.alpha *= (p.wave * ((sinS(th * (1 - w[0])) + sinS(th * (1 - w[1])) - 2) * 0.5 * w[2]) + 2) * 0.5;
        else { const m = w[2] * 0.5 * p.wave; p.alpha *= (m * (sinS(th * (1 - w[0])) - 1) + 1) * (m * (sinS(th * (1 - w[1])) - 1) + 1); }
        if (p.alpha < 0) p.alpha = 0;
      }
    }
  }

  // One JPAEmitterManager::calcBase step for this emitter, bound to world matrix M.
  // Returns false once the emitter is gone (JPAEmitterManager::deleteEmitter).
  function calc(e, M) {
    if (e.dead) return false;
    // checkMaxFrame (continuous emitters never end until becomeInvalidEmitter)
    let over = false;
    if (e.maxFrame !== 0) {
      if (e.maxFrame < 0) { e.enableDelete = true; over = true; }
      else if (e.frame >= e.maxFrame) { e.enableDelete = true; over = true; }
    }
    if (over && !e.ptcl.length) { e.dead = true; return false; }
    const rng = new Rng(hash(e.seed, e.calcs, 1)), frng = new Rng(hash(e.seed, e.calcs, 2));
    e.calcs++;
    calcKeyFrameAnime(e);
    globalParams(e, M);   // the bind-to-matrix callback, then calcEmitterGlobalParams
    fieldsSet(e);
    if (!e.enableDelete) {
      // calcCreateParticle (not fixed interval)
      if (e.emitNext) {
        let n = 0;
        let rate = e.rate;
        if (e.res.em.rateRndm !== 0) rate += rate * e.res.em.rateRndm * rng.rf();
        e.timer += rate;
        if (e.timer >= 1) { n = Math.trunc(e.timer); e.timer -= n; }
        else if (rate > 0 && e.first) n = 1;
        if (e.stopEmit) n = 0;
        for (let i = 0; i < n; i++) createParticle(e, rng);
      }
      const er = emitRate(e.res.em);
      if (er === 1) e.emitNext = true;
      else { e.emitTimer += er; if (e.emitTimer >= 1) { e.emitTimer -= 1; e.emitNext = true; } else e.emitNext = false; }
      e.first = false;
    }
    // doParticle
    const L = e.ptcl;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      if (p.born) p.born = false; else p.age += 1;
      if (p.age >= p.life) { p.prog = 1; p.dead = true; } else p.prog = p.age / p.life;
      if (p.dead) continue;
      // JPAParticle::calcVelocity
      p.fVel[0] = p.fVel[1] = p.fVel[2] = 0;
      if (p.follow) p.u14 = e.u24.slice();
      if (p.moment !== 0) { p.base[0] += p.moment * p.dirN[0]; p.base[1] += p.moment * p.dirN[1]; p.base[2] += p.moment * p.dirN[2]; }
      affectFields(e, p, frng);
      if (p.air < 1) { p.base[0] *= p.air; p.base[1] *= p.air; p.base[2] *= p.air; }
      for (let k = 0; k < 3; k++) { p.fVel[k] += p.fAcc[k]; p.vel[k] = p.curDrag * (p.base[k] + p.fVel[k]) * p.weight; }
      calcDraw(e, p);
      for (let k = 0; k < 3; k++) { p.local[k] += p.vel[k]; p.global[k] = p.local[k] * e.dynScale[k] + p.u14[k]; }
    }
    e.ptcl = L.filter((p) => !p.dead);
    e.frame++;
    return true;
  }
  // becomeInvalidEmitter: stops making particles; it goes once the last one dies.
  function invalidate(e) { e.maxFrame = -1; e.stopEmit = true; }

  // The draw visitors that keep state between frames (JPADrawExecDirectional* / Stripe*: the
  // particle's up vector unk0, crossed with its direction each draw). Run once a game frame,
  // after its calcs, as the game draws once a frame.
  function dirOf(e, p, i, out) {
    switch (e.res.bs.dirType) {
      case 0: out[0] = p.vel[0]; out[1] = p.vel[1]; out[2] = p.vel[2]; break;
      case 1: out[0] = p.local[0]; out[1] = p.local[1]; out[2] = p.local[2]; break;
      case 2: out[0] = -p.local[0]; out[1] = -p.local[1]; out[2] = -p.local[2]; break;
      case 3: { const d = e.res.em.dir; out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; break; }
      default: {   // previous particle in the list (or the emitter)
        const q = i > 0 ? e.ptcl[i - 1].global : e.u24;
        out[0] = q[0] - p.global[0]; out[1] = q[1] - p.global[1]; out[2] = q[2] - p.global[2];
      }
    }
    return out;
  }
  function drawStep(e) {
    const bs = e.res.bs, t = bs.type;
    if (!(t === 3 || t === 4 || t === 5 || t === 6 || t === 9)) return;
    const d = [0, 0, 0];
    e.ptcl.forEach((p, i) => {
      dirOf(e, p, i, d);
      let bc;
      if (isZero(d)) { if (!bs.stripe) { p.basis = null; return; } bc = [0, 1, 0]; } else bc = norm(d);
      let side = cross(p.u0, bc);
      if (isZero(side)) { if (!bs.stripe) { p.basis = null; return; } side = t === 5 ? [1, 0, 0] : [0, 1, 0]; } else side = norm(side);
      p.u0 = norm(cross(bc, side));
      p.basis = { up: p.u0.slice(), dir: bc, side };
      if (t === 6) {   // the stripe cross's second strip follows the velocity
        let bv = isZero(p.vel) ? [0, 1, 0] : norm(p.vel);
        let sv = cross(p.u0, bv);
        sv = isZero(sv) ? [0, 1, 0] : norm(sv);
        p.u0 = norm(cross(bv, sv));
        p.basis2 = { up: p.u0.slice(), dir: bv, side: sv };
      }
    });
  }

  // ---------------------------------------------------------------- drawing
  const BLEND_SRC = [THREE.ZeroFactor, THREE.OneFactor, THREE.DstColorFactor, THREE.OneMinusDstColorFactor, THREE.DstColorFactor,
    THREE.OneMinusDstColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
  const BLEND_DST = [THREE.ZeroFactor, THREE.OneFactor, THREE.SrcColorFactor, THREE.OneMinusSrcColorFactor, THREE.SrcColorFactor,
    THREE.OneMinusSrcColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
  const DEPTH = [THREE.NeverDepth, THREE.LessDepth, THREE.LessEqualDepth, THREE.EqualDepth, THREE.NotEqualDepth, THREE.GreaterEqualDepth, THREE.GreaterDepth, THREE.AlwaysDepth];
  const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
  const texCache = new Map();
  function texture(t) {
    if (texCache.has(t)) return texCache.get(t);
    const bin = atob(t.rgba), a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    const tx = new THREE.DataTexture(a, t.w, t.h, THREE.RGBAFormat);
    tx.wrapS = WRAP[t.wrapS] || THREE.ClampToEdgeWrapping; tx.wrapT = WRAP[t.wrapT] || THREE.ClampToEdgeWrapping;
    tx.magFilter = THREE.LinearFilter; tx.minFilter = THREE.LinearMipmapLinearFilter; tx.generateMipmaps = true;
    tx.flipY = false;   // GX: t = 0 is the first row
    tx.needsUpdate = true;
    texCache.set(t, tx);
    return tx;
  }
  // JPABaseShape's TEV (JPADrawSetupTev): stage 0 colour from the shape's mode, alpha TEXA * A0;
  // with an ETX1 block, the indirect texture offsets stage 0's lookup and a second texture
  // multiplies it in. A projected main texture (the screen, JPADrawExecGenPrjMtx) is sampled at
  // the fragment's own screen position.
  const TEV_COLOR = {
    0: 't.rgb', 1: 'vC0.rgb * t.rgb', 2: 'mix(vC0.rgb, vec3(1.0), t.rgb)', 3: 'mix(vC1, vC0.rgb, t.rgb)',
    4: 'vC1 + t.rgb * vC0.rgb', 5: 'vC0.rgb',
  };
  function makeMaterial(res, screenTex) {
    const bs = res.bs, ex = res.ex;
    const ind = ex && ex.indMode === 1, second = ex && ex.flags & 1, prj = !!bs.projection;
    const uniforms = { tMain: { value: null }, tInd: { value: null }, tSecond: { value: null }, uView: { value: new THREE.Vector2(1, 1) } };
    if (prj) uniforms.tMain.value = screenTex;
    else uniforms.tMain.value = texture(res.tex[bs.texIndex]);
    if (ind) {
      uniforms.tInd.value = texture(res.tex[ex.indTex]);
      const sc = Math.pow(2, (ex.expScale << 24) >> 24);   // GXSetIndTexMtx scale exponent (s8)
      uniforms.uIndM0 = { value: new THREE.Vector3(ex.mtx[0] * sc, ex.mtx[1] * sc, ex.mtx[2] * sc) };
      uniforms.uIndM1 = { value: new THREE.Vector3(ex.mtx[3] * sc, ex.mtx[4] * sc, ex.mtx[5] * sc) };
    }
    if (second) uniforms.tSecond.value = texture(res.tex[ex.secondTex]);
    const blend = bs.blendMode === 1;
    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        attribute vec4 c0; attribute vec3 c1;
        varying vec2 vUv; varying vec4 vC0; varying vec3 vC1;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() { vUv = uv; vC0 = c0; vC1 = c1; gl_Position = projectionMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D tMain, tInd, tSecond; uniform vec2 uView;
        ${ind ? 'uniform vec3 uIndM0, uIndM1;' : ''}
        varying vec2 vUv; varying vec4 vC0; varying vec3 vC1;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          ${prj ? `vec2 tc = gl_FragCoord.xy / uView;` : 'vec2 tc = vUv;'}
          ${ind ? `
          vec4 it = texture2D(tInd, vUv);
          vec3 stu = vec3(it.a, it.b, it.g) * 255.0 - 128.0;   // ITF_8, bias STU
          vec2 off = vec2(dot(uIndM0, stu), dot(uIndM1, stu));  // texels of the main texture
          tc += ${prj ? 'vec2(off.x, -off.y) / vec2(320.0, 224.0)' : 'off / vec2(textureSize0)'};` : ''}
          vec4 t = texture2D(tMain, tc);
          ${prj ? 't.a = 1.0;' : ''}
          vec3 c = clamp(${TEV_COLOR[bs.tevCol] || 't.rgb'}, 0.0, 1.0);
          float a = clamp(t.a * vC0.a, 0.0, 1.0);
          ${second ? 'vec4 t2 = texture2D(tSecond, vUv); c *= t2.rgb; a *= t2.a;' : ''}
          gl_FragColor = vec4(c, a);
        }`.replace('textureSize0', `${res.tex[bs.texIndex] ? res.tex[bs.texIndex].w + '.0, ' + res.tex[bs.texIndex].h + '.0' : '1.0, 1.0'}`),
      transparent: blend, depthTest: !!bs.zCmp, depthWrite: !!bs.zUpd, side: THREE.DoubleSide, fog: false,
    });
    m.depthFunc = DEPTH[bs.zFunc] || THREE.LessEqualDepth;
    if (blend) {
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = BLEND_SRC[bs.srcFactor]; m.blendDst = BLEND_DST[bs.dstFactor];
    } else m.blending = THREE.NoBlending;
    return m;
  }

  class Batch {   // one effect's quads in view space, rebuilt each draw
    constructor(res, max, screenTex) {
      this.res = prepare(res);
      const g = new THREE.BufferGeometry();
      this.P = new Float32Array(max * 3); this.U = new Float32Array(max * 2); this.C0 = new Float32Array(max * 4); this.C1 = new Float32Array(max * 3);
      this.I = new Uint32Array(max * 2);
      g.setAttribute('position', new THREE.BufferAttribute(this.P, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('uv', new THREE.BufferAttribute(this.U, 2).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('c0', new THREE.BufferAttribute(this.C0, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('c1', new THREE.BufferAttribute(this.C1, 3).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(new THREE.BufferAttribute(this.I, 1).setUsage(THREE.DynamicDrawUsage));
      this.max = max;
      this.mesh = new THREE.Mesh(g, makeMaterial(res, screenTex));
      this.mesh.frustumCulled = false;
      this.mesh.matrixAutoUpdate = false;
      this.n = 0; this.ni = 0;
    }
    begin() { this.n = 0; this.ni = 0; }
    vert(x, y, z, u, v, c0, c1) {
      if (this.n >= this.max) return -1;
      const i = this.n++;
      this.P[i * 3] = x; this.P[i * 3 + 1] = y; this.P[i * 3 + 2] = z;
      this.U[i * 2] = u; this.U[i * 2 + 1] = v;
      this.C0[i * 4] = c0[0]; this.C0[i * 4 + 1] = c0[1]; this.C0[i * 4 + 2] = c0[2]; this.C0[i * 4 + 3] = c0[3];
      this.C1[i * 3] = c1[0]; this.C1[i * 3 + 1] = c1[1]; this.C1[i * 3 + 2] = c1[2];
      return i;
    }
    quad(a, b, c, d) {
      if (a < 0 || b < 0 || c < 0 || d < 0 || this.ni + 6 > this.I.length) return;
      this.I.set([a, b, c, a, c, d], this.ni); this.ni += 6;
    }
    end() {
      const g = this.mesh.geometry, A = g.attributes, n = this.n;
      g.setDrawRange(0, this.ni);
      if (this.ni) {   // upload only the part written this time (never a count of 0: WebGL reads that as all)
        [['position', 3], ['uv', 2], ['c0', 4], ['c1', 3]].forEach(([k, w]) => { A[k].updateRange.offset = 0; A[k].updateRange.count = n * w; A[k].needsUpdate = true; });
        g.index.updateRange.offset = 0; g.index.updateRange.count = this.ni; g.index.needsUpdate = true;
      }
      this.mesh.visible = this.ni > 0;
    }
    // JPADraw::drawParticle for one emitter. V: the camera's view matrix elements.
    add(e, V) {
      const bs = this.res.bs, es = this.res.es, t = bs.type;
      const u4x = 25 * bs.sizeX * e.ptclScale[0], u4y = 25 * bs.sizeY * e.ptclScale[1];
      const piv = es && es.scaleFlags & 1;
      const cX = piv ? u4x * (es.pivotX - 1) : 0, cY = piv ? u4y * (es.pivotY - 1) : 0;
      const tx = bs.tiling[0], ty = bs.tiling[1];
      const TC = [[0, 0], [tx, 0], [tx, ty], [0, ty]];
      const toView = (p, out) => {
        out[0] = V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12];
        out[1] = V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13];
        out[2] = V[2] * p[0] + V[6] * p[1] + V[10] * p[2] + V[14];
        return out;
      };
      const pv = [0, 0, 0], w = [0, 0, 0];
      const list = bs.listOrder ? e.ptcl : e.ptcl.slice().reverse();
      const col = (p) => {
        const a = (bs.alpha && !bs.stripe ? p.alpha : 1) * p.prm[3] / 255;
        return [[p.prm[0] / 255, p.prm[1] / 255, p.prm[2] / 255, a], [p.env[0] / 255, p.env[1] / 255, p.env[2] / 255]];
      };
      if (t === 5 || t === 6) {   // JPADrawExecStripe(Cross): strips through the particles in list order
        if (list.length < 2) return;
        const strip = (second) => {
          const step = 1 / (list.length - 1);
          let prev = null;
          list.forEach((p, i) => {
            const B = second ? p.basis2 : p.basis;
            if (!B) return;
            const [c0, c1] = col(p), sn = sinS(p.rot), cs = cosS(p.rot);
            let a1, a2;
            if (!second) { const x = -p.sx * (u4x + cX), y = p.sx * (u4x - cX); a1 = [x * cs, 0, x * sn]; a2 = [y * cs, 0, y * sn]; }
            else { const x = p.sy * (u4y + cY), y = -p.sy * (u4y - cY); a1 = [x * -sn, 0, x * cs]; a2 = [y * -sn, 0, y * cs]; }
            // setXYZDir(side, dir, up): columns
            const place = (a) => { w[0] = B.side[0] * a[0] + B.dir[0] * a[1] + B.up[0] * a[2] + p.global[0]; w[1] = B.side[1] * a[0] + B.dir[1] * a[1] + B.up[1] * a[2] + p.global[1]; w[2] = B.side[2] * a[0] + B.dir[2] * a[1] + B.up[2] * a[2] + p.global[2]; return toView(w, pv); };
            const fv = bs.listOrder ? i * step : 1 - i * step;
            let q = place(a1); const v1 = this.vert(q[0], q[1], q[2], 0, fv, c0, c1);
            q = place(a2); const v2 = this.vert(q[0], q[1], q[2], 1, fv, c0, c1);
            if (prev) this.quad(prev[0], prev[1], v2, v1);
            prev = [v1, v2];
          });
        };
        strip(false);
        if (t === 6) strip(true);
        return;
      }
      for (const p of list) {
        const [c0, c1] = col(p);
        const x0 = -p.sx * (u4x + cX), y0 = p.sy * (u4y + cY), x1 = p.sx * (u4x - cX), y1 = -p.sy * (u4y - cY);
        const rot = es && es.rotate;
        const sn = rot ? sinS(p.rot) : 0, cs = rot ? cosS(p.rot) : 1;
        if (t === 3 || t === 4) {   // JPADrawExecDirectional(Cross): in the particle's own frame
          const B = p.basis;
          if (!B) continue;
          const offs = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
          if (t === 4) {
            const mx = (x1 + x0) * 0.5, hz = (x1 - x0) * 0.5;
            offs.push([mx, y0, hz], [mx, y0, -hz], [mx, y1, -hz], [mx, y1, hz]);
          }
          // the rotation about the shape's axis (rotTypeY / X / Z / XYZ / YJiggle)
          let Rm = null;
          if (rot) {
            switch (bs.rotType) {
              case 0: Rm = [cs, 0, -sn, 0, 1, 0, sn, 0, cs]; break;
              case 1: Rm = [1, 0, 0, 0, cs, -sn, 0, sn, cs]; break;
              case 2: Rm = [cs, -sn, 0, sn, cs, 0, 0, 0, 1]; break;
              case 3: { const a = (1 - cs) * 0.333333, c = a + 0.57735 * sn, b = a - 0.57735 * sn, d = a + cs; Rm = [d, b, c, c, d, b, b, c, d]; break; }
              default: Rm = [cs, -sn * 0.207912, -sn * 0.978148, 0, 0.978148, -0.207912, sn, cs * 0.207912, cs * 0.978148];
            }
          }
          const ids = offs.map((o, k) => {
            const r = Rm ? mv3(Rm, o) : o;
            w[0] = B.up[0] * r[0] + B.dir[0] * r[1] + B.side[0] * r[2] + p.global[0];
            w[1] = B.up[1] * r[0] + B.dir[1] * r[1] + B.side[1] * r[2] + p.global[1];
            w[2] = B.up[2] * r[0] + B.dir[2] * r[1] + B.side[2] * r[2] + p.global[2];
            toView(w, pv);
            const tc = TC[k & 3];
            return this.vert(pv[0], pv[1], pv[2], tc[0], tc[1], c0, c1);
          });
          this.quad(ids[0], ids[1], ids[2], ids[3]);
          if (t === 4) this.quad(ids[4], ids[5], ids[6], ids[7]);
          continue;
        }
        // JPADrawExecBillBoard / RotBillBoard (other shapes drawn the same way: TODO)
        toView(p.global, pv);
        const corner = (x, y, k) => { const tc = TC[k]; return this.vert(pv[0] + x * cs - y * sn, pv[1] + y * cs + x * sn, pv[2], tc[0], tc[1], c0, c1); };
        this.quad(corner(x0, y0, 0), corner(x1, y0, 1), corner(x1, y1, 2), corner(x0, y1, 3));
      }
    }
  }

  return { makeEmitter, advanceTo, calc, invalidate, drawStep, Batch, prepare };
})();
