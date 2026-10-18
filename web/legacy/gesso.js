// Gooper Blooper (TBossGesso) as the game runs him, for the ghost viewer: src/Enemy/bossgesso.cpp,
// bgtentacle.cpp, bgpoldrop.cpp and spline.cpp in the decomp. No three.js here (the viewer draws
// what this works out), so it can be checked against ghosts outside the browser.
//
// The game moves everything four times a frame (TMarDirector::direct: movement ticks of 5/600 s
// at 30 frames a second) and steps animations once a frame by SMSGetAnmFrameRate (2 animation
// frames a game frame). Per tick: the boss's nerve (TSpineBase::update), its attack mode
// (TBossGesso::moveObject), the beak, then each tentacle (TBGTentacle::perform: constraint,
// node physics, state). On the frame's last tick also its animations: the body's BCK (blended
// from the last one, M3UMtxCalcSIAnmBlendQuat), BTP and BTK, the tentacles' roots on the body's
// joints {2, 3, 5, 6} and each tentacle's guide (bgeso_shand). Hit checks run on the first tick.
//
// What the run did comes from the ghost: Mario's position, facing, floor contact and what he holds
// (the tentacles' and the beak's take hits are retail actors in Moonshine's attachment table).
// Mario's stick isn't recorded the way the game reads it (the camera turns it), so while he pulls
// it is taken to point where he moves, at full tilt. Water: see sprayHit.
(function (root) {
  'use strict';
  const RD = Math.PI / 180;
  const sinD = (a) => Math.sin(a * RD), cosD = (a) => Math.cos(a * RD);
  function wrap(t, l, r) {   // MsWrap
    if (l >= r) return l;
    const w = r - l;
    while (t >= r) t -= w;
    while (t < l) t += w;
    return t;
  }
  const angDiff = (a, b) => a - wrap(b, a - 180, a + 180);   // MsAngleDiff
  const rotFromZY = (x, z) => (z === 0 ? (x >= 0 ? 90 : -90) : Math.atan2(x, z) / RD);   // MsGetRotFromZaxisY
  function rotFromZ(x, y, z) {   // MsGetRotFromZaxis: (pitch, yaw, 0) of a direction
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const rx = y === 1 ? 90 : y === -1 ? -90 : -Math.asin(Math.max(-1, Math.min(1, y))) / RD;
    return [rx, rotFromZY(x, z), 0];
  }

  // ---------------------------------------------------------------- 3x4 matrices (row-major)
  const m34 = () => new Float64Array(12);
  function mIdent(o) { o.fill(0); o[0] = o[5] = o[10] = 1; return o; }
  const _mt = new Float64Array(12);
  function mMul(a, b, o) {
    for (let r = 0; r < 3; r++) {
      const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
      _mt[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
      _mt[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
      _mt[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
      _mt[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
    }
    o.set(_mt);
    return o;
  }
  // MsMtxSetTRS / MsMtxSetXYZRPH (R = Rz(h) Ry(p) Rx(r), degrees), scaled columns.
  function mTRS(o, x, y, z, r, p, h, sx, sy, sz) {
    const sr = sinD(r), sp = sinD(p), sh = sinD(h), cr = cosD(r), cp = cosD(p), ch = cosD(h);
    o[0] = ch * cp * sx; o[4] = sh * cp * sx; o[8] = -sp * sx;
    o[1] = (sr * ch * sp - sh * cr) * sy; o[5] = (sr * sh * sp + ch * cr) * sy; o[9] = cp * sr * sy;
    o[2] = (cr * ch * sp + sh * sr) * sz; o[6] = (cr * sh * sp - ch * sr) * sz; o[10] = cp * cr * sz;
    o[3] = x; o[7] = y; o[11] = z;
    return o;
  }
  function mRotZ(o, d) { const s = sinD(d), c = cosD(d); mIdent(o); o[0] = c; o[1] = -s; o[4] = s; o[5] = c; return o; }
  function mRotX(o, d) { const s = sinD(d), c = cosD(d); mIdent(o); o[5] = c; o[6] = -s; o[9] = s; o[10] = c; return o; }

  // ---------------------------------------------------------------- animations
  // A BCK track at frame f: a constant, or keys [time, value, in tangent, out tangent] x n (Hermite).
  function trackAt(tr, f) {
    if (typeof tr === 'number') return tr;
    const n = tr.length >> 2;
    if (f < tr[0]) return tr[1];
    for (let i = 1; i < n; i++) {
      const t1 = tr[i * 4];
      if (f < t1) {
        const b = (i - 1) * 4, t0 = tr[b], len = t1 - t0, u = (f - t0) / len, u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * tr[b + 1] + (u3 - 2 * u2 + u) * tr[b + 3] * len + (-2 * u3 + 3 * u2) * tr[i * 4 + 1] + (u3 - u2) * tr[i * 4 + 2] * len;
      }
    }
    return tr[(n - 1) * 4 + 1];
  }
  // J3DFrameCtrl: attribute 0 once, 1 once and back to the start, 2 loop, 3 there and back once,
  // 4 there and back looping.
  class Frame {
    constructor() { this.frame = 0; this.rate = 1; this.end = 0; this.attr = 2; this.start = 0; this.loop = 0; this.state = 0; }
    init(end, attr, rate) { this.attr = attr; this.state = 0; this.start = 0; this.end = end; this.loop = 0; this.rate = rate; this.frame = 0; return this; }
    endsNext() { return this.frame + this.rate + 0.1 >= this.end; }   // MActorAnmBase::endsNext
    update() {
      this.state = 0;
      this.frame += this.rate;
      switch (this.attr) {
        case 0:
          if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
          if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = 0; this.state |= 1; }
          break;
        case 1:
          if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
          if (this.frame >= this.end) { this.frame = this.start; this.rate = 0; this.state |= 1; }
          break;
        case 2:
          while (this.frame < this.start) { this.state |= 2; if (this.loop - this.start <= 0) break; this.frame += this.loop - this.start; }
          while (this.frame >= this.end) { this.state |= 2; if (this.end - this.loop <= 0) break; this.frame -= this.end - this.loop; }
          break;
        case 3:
          if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = -this.rate; }
          if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
          break;
        case 4:
          if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = -this.rate; }
          if (this.frame < this.start) { this.frame = this.start; this.rate = -this.rate; this.state |= 2; }
          break;
      }
    }
    checkPass(p) {   // J3DFrameCtrl::checkPass (once and loop forms)
      const cur = this.frame;
      let nx = cur + this.rate;
      if (this.attr === 2) {
        if (this.end <= nx) {
          while (nx >= this.end) { if (this.end - this.loop <= 0) break; nx -= this.end - this.loop; }
          return (cur <= p && p < this.end) || (this.loop <= p && p < nx);
        }
        return cur <= nx ? cur <= p && p < nx : nx <= p && p < cur;
      }
      if (nx < this.start) nx = this.start;
      if (nx >= this.end) nx = this.end - 0.001;
      return cur <= nx ? cur <= p && p < nx : nx <= p && p < cur;
    }
  }

  // Joint locals of a BCK at frame f into out (scale xyz, ZYX rotation radians, translation).
  function bckLocal(a, j, f, out) {
    const t = a.j[j];
    for (let i = 0; i < 9; i++) out[i] = trackAt(t[i], f);
    return out;
  }
  function bindLocal(trs, j, out) {
    const [s, r, t] = trs[j];
    out[0] = s[0]; out[1] = s[1]; out[2] = s[2]; out[3] = r[0]; out[4] = r[1]; out[5] = r[2]; out[6] = t[0]; out[7] = t[1]; out[8] = t[2];
    return out;
  }
  function quatZYX(rx, ry, rz, q) {   // the rotation Rz Ry Rx as a quaternion (x, y, z, w)
    const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2), cy = Math.cos(ry / 2), sy = Math.sin(ry / 2), cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
    q[0] = sx * cy * cz - cx * sy * sz;
    q[1] = cx * sy * cz + sx * cy * sz;
    q[2] = cx * cy * sz - sx * sy * cz;
    q[3] = cx * cy * cz + sx * sy * sz;
    return q;
  }
  // A joint's local matrix: T R S (J3DMtxCalcBasic) from locals; with an old pose blended in by
  // ratio (1 = all old: M3UMtxCalcBlendAux, the quaternions interpolated, the rest linearly).
  const _qa = [0, 0, 0, 0], _qb = [0, 0, 0, 0];
  function localMatrix(L, O, ratio, o) {
    let sx = L[0], sy = L[1], sz = L[2], tx = L[6], ty = L[7], tz = L[8], x, y, z, w;
    if (O && ratio > 0) {
      const u = 1 - ratio;
      sx = L[0] * u + O[0] * ratio; sy = L[1] * u + O[1] * ratio; sz = L[2] * u + O[2] * ratio;
      tx = L[6] * u + O[6] * ratio; ty = L[7] * u + O[7] * ratio; tz = L[8] * u + O[8] * ratio;
      quatZYX(L[3], L[4], L[5], _qa); quatZYX(O[3], O[4], O[5], _qb);
      const dot = _qa[0] * _qb[0] + _qa[1] * _qb[1] + _qa[2] * _qb[2] + _qa[3] * _qb[3], sg = dot < 0 ? -1 : 1;
      x = _qa[0] * u + _qb[0] * ratio * sg; y = _qa[1] * u + _qb[1] * ratio * sg; z = _qa[2] * u + _qb[2] * ratio * sg; w = _qa[3] * u + _qb[3] * ratio * sg;
      const l = Math.hypot(x, y, z, w) || 1;
      x /= l; y /= l; z /= l; w /= l;
    } else {
      quatZYX(L[3], L[4], L[5], _qa);
      [x, y, z, w] = _qa;
    }
    o[0] = (1 - 2 * (y * y + z * z)) * sx; o[1] = 2 * (x * y - z * w) * sy; o[2] = 2 * (x * z + y * w) * sz; o[3] = tx;
    o[4] = 2 * (x * y + z * w) * sx; o[5] = (1 - 2 * (x * x + z * z)) * sy; o[6] = 2 * (y * z - x * w) * sz; o[7] = ty;
    o[8] = 2 * (x * z - y * w) * sx; o[9] = 2 * (y * z + x * w) * sy; o[10] = (1 - 2 * (x * x + y * y)) * sz; o[11] = tz;
    return o;
  }

  // ---------------------------------------------------------------- TSplinePath (spline.cpp)
  // A natural cubic through the points, parametrised by chord length over 0..1.
  class Spline {
    constructor(n) {
      this.n = n;
      this.c = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      this.k = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      this.p = new Float64Array(n); this.d = new Float64Array(n); this.tmp = new Float64Array(n);
      this.ok = false;
    }
    set(i, x, y, z) { this.c[0][i] = x; this.c[1][i] = y; this.c[2][i] = z; this.ok = false; }
    table(co, out) {   // makeTable
      const n = this.n, P = this.p, D = this.d, T = this.tmp;
      out[0] = 0; out[n - 1] = 0;
      for (let i = 0; i < n - 1; i++) {
        D[i] = P[i + 1] - P[i];
        T[i + 1] = Math.abs(D[i]) < 0.0001 ? 0 : (co[i + 1] - co[i]) / D[i];
      }
      out[1] = -(D[0] * out[0] - (T[2] - T[1]));
      T[1] = (P[2] - P[0]) * 2;
      for (let i = 1; i < n - 2; i++) {
        if (Math.abs(T[i]) < 0.0001) T[i] = 0.0001;
        const f = D[i] / T[i];
        out[i + 1] = -(f * out[i] - (T[i + 2] - T[i + 1]));
        T[i + 1] = (P[i + 2] - P[i]) * 2 - f * D[i];
      }
      out[n - 2] -= D[n - 2] * out[n - 1];
      for (let i = n - 2; i > 0; i--) out[i] = (out[i] - D[i] * out[i + 1]) / T[i];
    }
    calc() {   // calcTable
      const n = this.n, P = this.p, [X, Y, Z] = this.c;
      if (n > 2) {
        P[0] = 0;
        for (let i = 1; i < n; i++) P[i] = Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1], Z[i] - Z[i - 1]) + P[i - 1];
        for (let i = 1; i < n; i++) P[i] /= P[n - 1];
        for (let a = 0; a < 3; a++) this.table(this.c[a], this.k[a]);
      }
      this.ok = true;
    }
    at(t, out) {   // getPoint
      if (!this.ok) this.calc();
      t = Math.max(0, Math.min(1, t));
      const n = this.n, P = this.p;
      let l = 0, r = n - 1;
      while (l < r) { const mid = (l + r) >> 1; if (P[mid] < t) l = mid + 1; else r = mid; }
      if (l > 0) l--;
      const dt = t - P[l], dp = P[l + 1] - P[l];
      for (let a = 0; a < 3; a++) {
        const co = this.c[a], k = this.k[a];
        if (n === 2) { out[a] = co[0] * (1 - t) + co[1] * t; continue; }
        const A = k[l] * 3 + (dt * (k[l + 1] - k[l])) / dp;
        const Dd = (co[l + 1] - co[l]) / dp - dp * (k[l] * 2 + k[l + 1]);
        out[a] = dt * (dt * A + Dd) + co[l];
      }
      return out;
    }
  }

  // ---------------------------------------------------------------- constants
  // Body animations by MActor index (bgeso.json names): changeBck(n).
  const BCK = { cannon: 1, crush: 2, damage: 3, eyedamage: 5, fly: 6, hit: 7, kolkBreak: 8, limit: 9, osen: 10,
    ballFly: 11, ballOsen: 12, ballWhiteOsen: 13, roll: 14, rollAll: 15, rollAllEnd: 16, rollAllStart: 17, rollEnd: 18, rollStart: 19,
    shAttack: 20, shFly: 21, shGuard: 22, shIssei: 23, shJump: 24, wait: 25, wait2: 26, wait3: 27 };
  const BTP = { tdamage: 0, teyedamage: 1, twait: 2, twait3: 3 };
  const ROOT_JOINTS = [2, 3, 5, 6];        // where each tentacle's first node sits (TBossGesso::perform)
  const SEMI_JOINTS = [8, 14, 28, 34];     // its node targets while waiting (moveConstraint)
  const NERVE = { wait: 'wait', eye: 'eyeDamage', beak: 'beakDamage', tent: 'tentacleDamage', tug: 'tug', die: 'die', pollute: 'pollute', polDrop: 'polDrop', roll: 'roll' };
  const T_WAIT = 0, T_ATTACK = 1, T_REST = 2, T_HELD = 3, T_AMPUTEE = 4, T_STUN = 5, T_HIDE = 6, T_FOLLOW = 7, T_SYNC = 8, T_GUARD = 9, T_UNKA = 10;
  const A_SINGLE = 0, A_DOUBLE = 1, A_UNISON = 2, A_GUARD = 3, A_SKIP = 4, A_SHOOT = 5, A_CONTAINER = 6, A_ROLL = 7;
  const GRAVITY = 0.15, VEL_MIN_Y = -40;
  // The per-frame record (Float32Array of REC floats): see record().
  const REC_T = 26, REC_TN = 22, REC_FX = REC_T + 4 * REC_TN + 10, REC_BLUR = REC_FX + 1, REC = REC_BLUR + 48;
  // Effects on while their bit is (REC_FX): his tears (ms_boge_namida on both eyes: eye damage and
  // tug), sweat (ms_boge_ase on his head: tug), the face wash (ms_boge_wash: washing goop off), the
  // goop ball's trail (ms_boge_kiseki). The one-shots are events (S.ev).
  const FX = { namida: 1, ase: 2, wash: 4, kiseki: 8 };

  // ---------------------------------------------------------------- the simulation
  // def: { anims (objects/bgeso.json), prm, tprm, pos, ry, map, stage, frames, container,
  //        mario(k) -> null | { x, y, z, yaw (degrees), ground, held: 0 | 'tentacle' | 'beak' | other },
  //        ground(x, y, z) -> floor height at or below y, wall(x, y, z, r) -> [x, z] | null,
  //        spray(k) -> true when the run's water hits his face or beak at frame k (null: work it out) }
  function create(def) {
    const A = def.anims, P = def.prm, TP = def.tprm;
    const bodyJ = A.body.parent.length;
    const S = {
      def, k: 0, frames: [], base0: 0, ev: [],
      pos: [def.pos[0], def.pos[1], def.pos[2]], rot: [0, def.ry, 0], vel: [0, 0, 0], air: false,
      hp: P.mSLHitPointMax || 2, mode: A_SINGLE, modeT: 0, dead: false, dieFly: false,
      spine: { cur: NERVE.wait, prev: null, stack: [], t: 0 },
      bck: { idx: -1, f: new Frame(), oldIdx: -1, oldF: 0, ratio: 0, rate: 0 },
      btp: { idx: -1, f: new Frame() }, btk: { on: false, f: new Frame() },
      alpha: 230, unk194: 0, unk195: 0, unk196: 0, unk1A1: 0, unk1A8: 0, unk1AC: 0, unk1AE: 0,
      cork: { crushed: false, f: new Frame() },
      beak: { holder: false, p: [0, 0, 0], a4: [0, 0, 0] },
      pol: { st: 0, p: [0, 0, 0], v: [0, 0, 0], idx: -1, f: new Frame() },
      W: Array.from({ length: bodyJ }, () => m34()),   // body joint world matrices (CUE_CALC_ANIM)
      ticks: 0, moveTicks: def.moveTicks0 || 0, mario: null, marioK: -1,
      holding: null,   // what the run's Mario holds in the sim: a tentacle, 'beak' or null
    };
    S.T = [0, 1, 2, 3].map((i) => tentacle(S, i));
    reset(S);
    calcBody(S);
    S.T.forEach((t) => { if (t.state !== T_AMPUTEE) t.p[0].set(jointPos(S, ROOT_JOINTS[t.i])); });
    return S;
  }

  function tentacle(S, i) {
    const n = 6, T = {
      i, n, state: T_WAIT, t: 0, dmg: 0, unk48: 0, unk4C: 0,
      p: Array.from({ length: n }, () => new Float64Array(3)), v: Array.from({ length: n }, () => new Float64Array(3)),
      u: Array.from({ length: n }, () => new Float64Array(3)), fix: new Uint8Array(n),
      // unk40 / unk44: the vibration's phases, MsRandF() * 360 in the constructor (the game's RNG
      // state isn't known; fixed per tentacle here).
      ph40: [41, 167, 293, 59][i], ph44: [113, 239, 7, 331][i],
      target: new Float64Array(3), guide: { idx: BCK.shAttack, f: new Frame(), M: m34(), W: Array.from({ length: 11 }, () => m34()) },
      noAttack: true, noCollision: false, holder: false, a74: new Float64Array(3),
      spline: new Spline(n),
    };
    const g = S.def.anims.bck[BCK.shAttack];
    T.guide.f.init(g ? g.d : 1, g ? g.l : 0, 2);
    return T;
  }

  // TBossGesso::reset: every tentacle stacked straight up from him, its first node fixed; the
  // container phase (Ricco 1 before the breakout, map 3 scenario 0) has the first tentacle guarding.
  function reset(S) {
    const TP = S.def.tprm;
    S.T.forEach((T) => {
      for (let i = 0; i < T.n; i++) {
        T.p[i].set([S.pos[0], S.pos[1] + TP.mNodeLength * i, S.pos[2]]);
        T.u[i].set(T.p[i]); T.v[i].fill(0); T.fix[i] = 0;
      }
      T.fix[0] = 1;
      guideSet(S, T, BCK.shAttack);
    });
    changeAttackMode(S, S.def.container ? A_CONTAINER : A_SINGLE);
  }

  // ---------------------------------------------------------------- the boss's animations
  function changeBck(S, idx) {   // TBossGesso::changeBck: joinAnm (blend from the last), frame 0
    const a = S.def.anims.bck[idx], B = S.bck;
    if (B.idx !== idx) { B.oldIdx = B.idx; B.oldF = B.f.frame; B.ratio = 1; }
    B.idx = idx;
    B.f.init(a ? a.d : 1, a ? a.l : 2, 2);
    B.rate = a ? 10 / a.d : 0;   // unk188 = 10 / end
  }
  function setBtp(S, idx, frame, rate) {
    const a = S.def.anims.btp[idx];
    S.btp.idx = idx;
    S.btp.f.init(a ? a.d : 1, a ? a.l : 2, 2);
    if (frame !== undefined) S.btp.f.frame = frame;
    if (rate !== undefined) S.btp.f.rate = rate;
  }
  function jointPos(S, j) { const m = S.W[j]; return [m[3], m[7], m[11]]; }
  // The body's joints for the current animation state (CUE_CALC_ANIM: calcRootMatrix, then
  // TBossGessoMtxCalc; the beak's joint follows it while Mario has it).
  const _L = new Float64Array(9), _O = new Float64Array(9), _lm = m34(), _base = m34(), _rx = m34();
  function calcBody(S) {
    bodyMatrices(S.def.anims, {
      pos: S.pos, rot: S.rot, fly: S.dieFly ? S.vel : null,
      idx: S.bck.idx, f: S.bck.f.frame, oldIdx: S.bck.oldIdx, oldF: S.bck.oldF, ratio: S.bck.ratio,
      beak: S.beak.holder ? S.beak.p : null,
    }, S.W);
  }
  // Exported for the viewer (the same joints it draws). st: pos, rot (degrees), fly (velocity
  // while flying off: TBossGesso::calcRootMatrix faces him along it), idx/f, oldIdx/oldF/ratio,
  // beak (where Mario holds it, or null). Fills W[j] (world 3x4) and returns W; Wu (optional) gets
  // joint 26 before its scaling (what its children hang from).
  const _w26 = m34();
  function bodyMatrices(A, st, W, Wu) {
    const par = A.body.parent, trs = A.body.trs, a = st.idx >= 0 ? A.bck[st.idx] : null, o = st.oldIdx >= 0 ? A.bck[st.oldIdx] : null;
    if (st.fly) {
      const r = rotFromZ(st.fly[0], st.fly[1], st.fly[2]);
      mTRS(_base, st.pos[0], st.pos[1], st.pos[2], r[0], r[1], r[2], 1, 1, 1);
      mMul(_base, mRotX(_rx, 90), _base);
    } else mTRS(_base, st.pos[0], st.pos[1], st.pos[2], st.rot[0], st.rot[1], st.rot[2], 1, 1, 1);
    // M3UMtxCalcSIAnmBlendQuat::calc: no old animation and fully blended: the bind pose.
    const bind = !a || (!o && st.ratio >= 1);
    for (let j = 0; j < par.length; j++) {
      if (bind) bindLocal(trs, j, _L);
      else bckLocal(a, j, st.f, _L);
      const old = !bind && o && st.ratio > 0 ? bckLocal(o, j, st.oldF, _O) : null;
      localMatrix(_L, old, st.ratio, _lm);
      // (joint 26's children hang from it as it was before the beak's scaling)
      mMul(par[j] < 0 ? _base : par[j] === 26 ? _w26 : W[par[j]], _lm, W[j]);
      if (j === 26) {
        const m = W[26];
        if (st.beak) {   // TBossGessoMtxCalc::calc: the beak stretched to where Mario holds it
          m[3] = st.beak[0]; m[7] = st.beak[1] + 50; m[11] = st.beak[2];
          _w26.set(m);
          const d = Math.hypot(st.beak[0] - st.pos[0], st.beak[1] - st.pos[1], st.beak[2] - st.pos[2]);
          const s = Math.min(1, d > 0 ? 300 / d : 1);
          m[0] *= s; m[4] *= s; m[8] *= s; m[2] *= s; m[6] *= s; m[10] *= s;
        } else _w26.set(m);
        if (Wu) Wu.set(_w26);
      }
    }
    return W;
  }

  // ---------------------------------------------------------------- spine (TSpineBase)
  const latest = (S) => S.spine.cur || S.spine.prev;
  function setNext(S, n) { const sp = S.spine; if (sp.cur) sp.prev = sp.cur; sp.t = 0; sp.cur = n; }
  function pushAfter(S, n) { S.spine.stack.push(n); }
  function pushNerve(S, n) { const sp = S.spine; if (sp.cur) { sp.prev = sp.cur; sp.stack.push(sp.cur); } sp.t = 0; sp.cur = n; }
  function spineUpdate(S) {
    const sp = S.spine;
    if (!sp.cur && sp.stack.length) { const n = sp.stack.pop(); if (sp.cur) sp.prev = sp.cur; sp.cur = n; sp.t = 0; }
    if (!sp.cur) return;
    const done = NERVES[sp.cur](S, sp.t);
    sp.t++;
    if (done) { sp.prev = sp.cur; sp.cur = null; }
  }

  // ---------------------------------------------------------------- Mario, from the ghost
  function sqDistMario(S, p) { const m = S.mario; return m ? (m.x - p[0]) ** 2 + (m.y - p[1]) ** 2 + (m.z - p[2]) ** 2 : Infinity; }
  function inSightAngle(S, ang) {
    const m = S.mario;
    if (!m) return false;
    return Math.abs(angDiff(rotFromZY(m.x - S.pos[0], m.z - S.pos[2]), S.rot[1])) < 0.5 * ang;
  }
  const inSight = (S) => inSightAngle(S, S.def.prm.mSLSightAngle);
  // TSpineEnemy::walkToCurPathNode with no pace: turn toward Mario by at most `turn` a tick.
  function turnToMario(S, turn) {
    const m = S.mario;
    if (!m) return;
    const a = wrap(rotFromZY(m.x - S.pos[0], m.z - S.pos[2]), 0, 360), d = angDiff(a, S.rot[1]);
    S.rot[1] = wrap(S.rot[1] + (d > 0 ? Math.min(d, turn) : Math.max(d, -turn)), 0, 360);
  }

  // ---------------------------------------------------------------- nerves
  const NERVES = {
    wait(S, t) {   // TNerveBGWait
      if (t === 0) {
        changeBck(S, S.hp === 1 ? BCK.wait3 : S.hp === 2 ? BCK.wait2 : BCK.wait);
        setBtp(S, BTP.twait, 0);
      }
      const m = S.mario;
      if (m) {
        const len = Math.hypot(m.x - S.pos[0], m.y - S.pos[1], m.z - S.pos[2]);
        turnToMario(S, (len > 800 ? 1 : 3000 / len) * 0.2);
      }
      return false;
    },
    eyeDamage(S, t) {   // TNerveBGEyeDamage: the face washes off a little each tick
      if (t === 0) {
        changeBck(S, BCK.eyedamage);
        if (!S.beak.holder && S.mode !== A_UNISON) { changeAttackMode(S, A_UNISON); changeAllTentacleState(S, T_ATTACK); }
        setBtp(S, BTP.teyedamage, 1.5, 0);
      }
      if (S.bck.f.endsNext()) { setBtp(S, BTP.twait, 0); return true; }
      if (S.unk1AE === 0) S.unk1AE = 0x78;
      if (S.alpha !== 0) { S.alpha--; S.unk194 = 5; }
      return false;
    },
    beakDamage(S, t) {   // TNerveBGBeakDamage
      if (t === 0) {
        changeBck(S, BCK.hit);
        const btk = S.def.anims.btk[0];   // bgeso_hit.btk at 1 frame a frame
        S.btk.on = true; S.btk.f.init(btk ? btk.duration : 278, btk ? btk.loop : 0, 1);
        changeAllTentacleState(S, T_SYNC);
        setBtp(S, BTP.teyedamage, 1.5, 0);
        S.ev.push({ k: S.k, e: 'beakDamage' });
      }
      if (t === 1) crushCork(S);
      if (t === 12) S.ev.push({ k: S.k, e: 'hit' });          // ms_boge_hit_a/c/b on eff_mouth
      if (t === 40) S.ev.push({ k: S.k, e: 'kizetsu' });      // seeing stars, on both eyes
      if (t === 236 || t === 510) hitDown(S);
      if (S.bck.f.endsNext()) {
        forceAllTentacleState(S, T_WAIT);
        S.btk.f.rate = 0; S.btk.f.frame = 0;
        pushAfter(S, NERVE.pollute);
        return true;
      }
      return false;
    },
    tentacleDamage(S, t) {   // TNerveBGTentacleDamage
      if (t === 0) changeBck(S, BCK.damage);
      if (t === 30 || t === 304) hitDown(S);
      if (S.bck.f.endsNext()) {
        if (!tentacleHeld(S)) return true;
        pushAfter(S, NERVE.tent);
        return true;
      }
      return false;
    },
    tug(S, t) {   // TNerveBGTug: Mario pulling something of his
      if (t === 0) changeBck(S, BCK.eyedamage);
      if (S.beak.holder && Math.sqrt(sqDistMario(S, S.pos)) >= S.def.prm.mSLBeakLengthDamage) {
        setBtp(S, BTP.teyedamage, 1.5, 0);
        if (S.bck.idx !== BCK.limit) changeBck(S, BCK.limit);
      }
      if (S.bck.f.endsNext()) {
        if (tentacleHeld(S)) changeBck(S, BCK.eyedamage);
        else return true;
      }
      turnToMario(S, 0.2 * 10);
      return false;
    },
    die(S, t) {   // TNerveBGDie
      if (t === 0) {
        changeBck(S, BCK.crush);
        setBtp(S, BTP.teyedamage, 1.5, 0);
        S.ev.push({ k: S.k, e: 'die', p: S.pos.slice() });   // (makeShineAppearWithDemo at his position + 6000 up)
      }
      if (S.bck.idx === BCK.crush && S.bck.f.endsNext()) {
        changeBck(S, BCK.fly);
        changeAllTentacleState(S, T_SYNC);
        S.goal = [S.pos[0], -5000, S.pos[2] + 7000];
        // calcVelocityToJumpToY (SMSCalcJumpVelocityY: up at 50, gravity, falling at most 40)
        let y = S.pos[1], vy = 50, ticks = 1;
        for (;;) { y += vy; if (vy < 0 && y <= S.goal[1]) break; vy -= GRAVITY; if (vy < VEL_MIN_Y) vy = VEL_MIN_Y; ticks++; if (ticks > 20000) break; }
        S.vel = [(S.goal[0] - S.pos[0]) / ticks, 50, (S.goal[2] - S.pos[2]) / ticks];
        S.air = true; S.dieFly = true;
        return false;
      }
      const reached = S.goal && Math.hypot(S.goal[0] - S.pos[0], S.goal[1] - S.pos[1], S.goal[2] - S.pos[2]) < 100;
      if (reached) {
        S.vel = [0, 0, 0];
        changeAllTentacleState(S, T_WAIT);
        S.dead = true;
        S.ev.push({ k: S.k, e: 'gone' });
        return true;
      }
      return false;
    },
    pollute(S, t) {   // TNerveBGPollute: goops himself up again
      if (t === 0) {
        changeBck(S, BCK.osen);
        S.dirty = true;
        changeAllTentacleState(S, T_WAIT);
        setBtp(S, BTP.twait, 0);
      }
      if (t === 90) S.ev.push({ k: S.k, e: 'osen' });          // ms_boge_osen on eff_mouth
      if (t === 226) { S.alpha = 230; S.ev.push({ k: S.k, e: 'jump', p: jointPos(S, 1) }); }
      if (S.bck.f.endsNext()) { S.dirty = false; return true; }
      return false;
    },
    polDrop(S, t) {   // TNerveBGPolDrop: spits a goop ball at Mario
      if (t === 0) { changeBck(S, BCK.cannon); changeAllTentacleState(S, T_WAIT); setBtp(S, BTP.twait, 0); }
      const f = S.bck.f.frame;
      if (f > 83 && f < 87) launchPolDrop(S);
      if (S.bck.f.endsNext()) {
        const P = S.def.prm, d2 = sqDistMario(S, S.pos);
        if (S.unk195 < 3 && P.mSLSingleAttackLen ** 2 <= d2 && d2 < P.mSLShootRadius ** 2) pushAfter(S, NERVE.polDrop);
        return true;
      }
      turnToMario(S, 0.2);
      return false;
    },
    roll(S, t) {   // TNerveBGRoll
      const B = S.bck;
      if (!S.unk1A1) {
        if (t === 0) changeBck(S, BCK.rollStart);
        if (B.f.endsNext()) {
          if (B.idx === BCK.roll) {
            if (S.unk196 < 3) { changeBck(S, BCK.roll); S.unk196++; } else { changeBck(S, BCK.rollEnd); S.unk196 = 0; }
          } else if (B.idx === BCK.rollStart) changeBck(S, BCK.roll);
          else return true;
          return false;
        }
      } else {
        if (t === 0) changeBck(S, BCK.rollAllStart);
        if (B.f.endsNext()) {
          if (B.idx === BCK.rollAll) {
            if (S.unk196 < 3) { changeBck(S, BCK.rollAll); S.unk196++; } else { changeBck(S, BCK.rollAllEnd); S.unk196 = 0; }
          } else if (B.idx === BCK.rollAllStart) changeBck(S, BCK.rollAll);
          else return true;
        }
      }
      return false;
    },
  };

  function hitDown(S) {   // ms_boge_hitdown: on the floor under his head
    const p = jointPos(S, 47);
    p[1] = S.def.ground(p[0], p[1] + 500, p[2]);
    if (p[1] > -Infinity) S.ev.push({ k: S.k, e: 'hitdown', p });
  }
  function crushCork(S) {   // TBGCork::crush (kolk_break from then on)
    if (S.cork.crushed) return;
    const a = S.def.anims.bck[BCK.kolkBreak];
    S.cork.f.init(a ? a.d : 1, a ? a.l : 0, 2);
    S.cork.crushed = true;
    S.ev.push({ k: S.k, e: 'cork' });
  }
  function launchPolDrop(S) {   // TBossGesso::launchPolDrop
    const pd = S.pol;
    if (pd.st) return;
    const m = S.mario, from = jointPos(S, 26);
    if (!m) return;
    // SMSCalcJumpVelocityXZ(Mario, mouth, 32, 0.2)
    const hx = m.x - from[0], hz = m.z - from[2], hm = Math.hypot(hx, hz) || 1, n = Math.floor(hm / 32), tri = (n + 1) * n / 2, f = 32 / hm;
    pd.v = [hx * f, f * (m.y - from[1]) + tri * 0.2 * f, hz * f];
    pd.p = from.slice(); pd.st = 1;
    S.unk195++;
    S.ev.push({ k: S.k, e: 'shoot' });
  }

  // ---------------------------------------------------------------- attack modes
  function changeAttackMode(S, m) {   // TBossGesso::changeAttackMode
    S.mode = m; S.modeT = 0;
    switch (m) {
      case A_GUARD: changeAllTentacleState(S, T_UNKA); break;
      case A_UNISON: changeAllTentacleState(S, T_WAIT); break;
      case A_ROLL:
        S.unk1A1 = S.rollAll !== undefined ? S.rollAll : 0;   // (MsRandF() * 100 < 40: unknown, the plain roll)
        changeAllTentacleState(S, T_SYNC);
        S.spine.stack = []; setNext(S, NERVE.roll); pushAfter(S, NERVE.wait);
        break;
      case A_SHOOT: {
        const l = latest(S);
        if (l !== NERVE.polDrop && l !== NERVE.pollute && l !== NERVE.tent && l !== NERVE.eye && l !== NERVE.beak) {
          S.spine.stack = []; setNext(S, NERVE.polDrop); pushAfter(S, NERVE.wait); changeAllTentacleState(S, T_SYNC);
        }
        break;
      }
      case A_CONTAINER: changeState(S, S.T[0], T_GUARD); break;
    }
  }
  const isThing = (T) => T.state === T_AMPUTEE || T.state === T_HIDE || T.state === T_HELD;
  const isThing2 = (T) => T.state === T_AMPUTEE || T.state === T_HIDE;
  function changeAllTentacleState(S, st) { S.T.forEach((T) => { if (T.state !== T_STUN && !isThing(T)) changeState(S, T, st); }); }
  function forceAllTentacleState(S, st) { S.T.forEach((T) => changeState(S, T, st)); }
  const tentacleHeld = (S) => S.T.some((T) => T.state === T_HELD);
  const tentacleAttack = (S) => S.T.some((T) => T.state === T_ATTACK);
  const beakHeld = (S) => S.beak.holder;
  const onGround = (S) => !!(S.mario && S.mario.ground);

  function gotTentacleDamage(S) {
    if (latest(S) === NERVE.beak) return;
    S.spine.stack = []; setNext(S, NERVE.tent); pushAfter(S, NERVE.wait);
  }
  function gotEyeDamage(S) {
    const l = latest(S);
    if (l === NERVE.eye || l === NERVE.beak || l === NERVE.pollute) return false;
    S.spine.stack = []; setNext(S, NERVE.eye); pushAfter(S, NERVE.wait);
    return true;
  }
  function gotBeakDamage(S) {
    if (latest(S) === NERVE.tent) return;
    if (S.hp > 0) S.hp--;
    if (S.hp === 0) setNext(S, NERVE.die);
    else { setNext(S, NERVE.beak); pushAfter(S, NERVE.wait); }
  }

  function doAttackSingle(S) {
    const P = S.def.prm;
    if (S.moveTicks < 0x1e0 || S.demo) return;
    if (S.unk1A8 > 0) { S.unk1A8--; return; }
    if (S.def.stage === 4) {   // the second fight: only once Mario is up on the deck and near
      const m = S.mario;
      if (!m || m.y + 20 < S.pos[1]) return;
      if ((m.x - S.pos[0]) ** 2 + (m.y - S.pos[1]) ** 2 + (m.z - S.pos[2]) ** 2 > 3610000) return;
    }
    for (const i of [1, 3]) {
      const T = S.T[i];
      if (inSight(S) && T.state === T_WAIT && sqDistMario(S, T.p[0]) < P.mSLSingleAttackLen ** 2) { changeState(S, T, T_ATTACK); break; }
    }
    if (isThing2(S.T[3]) && isThing2(S.T[1]) && (!isThing2(S.T[2]) || !isThing2(S.T[0]))) {
      if (S.modeT > P.mSLUnisonInter && S.def.stage === 4) changeAttackMode(S, A_ROLL);
      return;
    }
    if (tentacleHeld(S)) return;
    if (S.beak.holder && (!isThing2(S.T[3]) || !isThing2(S.T[1]))) {
      for (const i of [1, 3]) {
        const T = S.T[i], s = T.state;
        if (s !== T_ATTACK && s !== T_AMPUTEE && s !== T_STUN && s !== T_HELD && s !== T_HIDE) changeState(S, T, T_ATTACK);
      }
      return;
    }
    const d2 = sqDistMario(S, S.pos);
    if (d2 < P.mSLForceUnisonLen ** 2 && onGround(S)) { changeAttackMode(S, A_UNISON); return; }
    if (d2 < P.mSLUnisonAttackLen ** 2 && onGround(S)) {
      if (S.modeT <= P.mSLUnisonInter) return;
      changeAttackMode(S, S.def.stage === 4 ? A_ROLL : A_UNISON);
      return;
    }
    if (tentacleAttack(S)) return;
    if (S.cork.crushed && S.unk195 < 3) {
      if (S.modeT > P.mSLUnisonInter && d2 < P.mSLShootRadius ** 2 && inSightAngle(S, 60)) changeAttackMode(S, A_SHOOT);
    } else if (S.def.stage === 4 && inSight(S) && S.modeT > P.mSLUnisonInter) { changeAttackMode(S, A_ROLL); S.unk195 = 0; }
  }
  function doAttackDouble(S) {
    const P = S.def.prm;
    if (S.beak.holder || tentacleHeld(S)) { changeAttackMode(S, A_SKIP); return; }
    if (inSight(S) && sqDistMario(S, S.pos) < P.mSLDoubleAttackLen ** 2) for (const i of [0, 2]) if (S.T[i].state === T_WAIT) changeState(S, S.T[i], T_ATTACK);
    if (S.beak.holder) return;
    if (!isThing2(S.T[3]) || !isThing2(S.T[1])) changeAttackMode(S, A_SINGLE);
  }
  function doAttackSkipRope(S) {
    if (S.beak.holder) { changeAttackMode(S, A_SKIP); return; }
    if (!S.beak.holder && !tentacleHeld(S)) { changeAttackMode(S, A_SINGLE); return; }
    if (inSight(S)) for (const i of [0, 2]) {
      const s = S.T[i].state;
      if (s !== T_REST && s !== T_ATTACK && s !== T_AMPUTEE && s !== T_STUN && s !== T_HELD && s !== T_HIDE) changeState(S, S.T[i], T_ATTACK);
    }
  }
  function doAttackUnison(S) {
    const P = S.def.prm;
    if (S.beak.holder) { changeAttackMode(S, A_SKIP); return; }
    if (inSight(S) && onGround(S) && sqDistMario(S, S.pos) < P.mSLUnisonAttackLen ** 2) {
      let none = true;
      for (let i = 0; i < 4; i++) if (i === Math.floor(S.modeT / 8) && S.T[i].state === T_WAIT) { changeState(S, S.T[i], T_ATTACK); none = false; }
      if (none && S.modeT > 300) changeAttackMode(S, A_SINGLE);
    } else {
      for (const T of S.T) {
        if (T.state === T_ATTACK) return;
        if (!isThing2(T) && T.state !== T_WAIT && T.state !== T_REST && T.state !== T_STUN) changeState(S, T, T_REST);
      }
      changeAttackMode(S, A_SINGLE);
    }
  }
  function doAttackShoot(S) {
    if (S.beak.holder) { changeAttackMode(S, A_SINGLE); return; }
    if (S.modeT > 120 && latest(S) !== NERVE.polDrop) { changeAttackMode(S, A_SINGLE); return; }
    if (!inSight(S)) return;
    if (sqDistMario(S, S.pos) < S.def.prm.mSLSingleAttackLen ** 2) changeAttackMode(S, A_SINGLE);
  }
  function doAttackGuard(S) {
    if (S.beak.holder) { changeAttackMode(S, A_SKIP); return; }
    if (inSight(S)) {
      if (!(S.def.prm.mSLGuardLen ** 2 < sqDistMario(S, S.pos))) { if (!isThing2(S.T[3]) || !isThing2(S.T[1])) return; }
      changeAllTentacleState(S, T_WAIT);
      changeAttackMode(S, A_SINGLE);
    }
  }
  function doAttackRoll(S) {
    if (latest(S) === NERVE.roll) return;
    changeAllTentacleState(S, T_WAIT);
    changeAttackMode(S, A_SINGLE);
  }

  // TBossGesso::moveObject (TLiveActor::moveObject: the nerve, then the binder)
  function moveObject(S) {
    spineUpdate(S);
    bind(S);
    const l = latest(S);
    if (l === NERVE.die || l === NERVE.polDrop || l === NERVE.pollute || l === NERVE.beak) return;
    switch (S.mode) {
      case A_SINGLE: doAttackSingle(S); break;
      case A_DOUBLE: doAttackDouble(S); break;
      case A_SKIP: doAttackSkipRope(S); break;
      case A_UNISON: doAttackUnison(S); break;
      case A_SHOOT: doAttackShoot(S); break;
      case A_GUARD: doAttackGuard(S); break;
      case A_ROLL: doAttackRoll(S); break;
    }
    const l2 = latest(S);
    if (l2 !== NERVE.tent && l2 !== NERVE.beak && l2 !== NERVE.tug && (tentacleHeld(S) || S.beak.holder)) pushNerve(S, NERVE.tug);
    S.modeT++;
  }
  // TBGBinder::bind: standing, he stays where he is; flying off when beaten, he arcs away freely.
  function bind(S) {
    if (S.air) {
      const n = [S.pos[0] + S.vel[0], S.pos[1] + S.vel[1], S.pos[2] + S.vel[2]];
      S.vel[1] = Math.max(VEL_MIN_Y, S.vel[1] - GRAVITY);
      if (S.dieFly && S.def.map !== 9 && S.pos[1] - n[1] > 0 && !S.splashed) {   // (once: the column of water)
        const g1 = S.def.ground(n[0], n[1] + (S.def.prm.mSLHeadHeight || 120), n[2]), g0 = S.def.ground(n[0], S.pos[1] + (S.def.prm.mSLHeadHeight || 120), n[2]);
        if (g0 > g1) { S.splashed = true; S.ev.push({ k: S.k, e: 'splash', p: S.pos.slice() }); }   // (TEffectColumWater: through the water)
      }
      S.pos = n;
    }
  }

  // ---------------------------------------------------------------- tentacles (bgtentacle.cpp)
  function nodeLen(S, T) { return T.state === T_AMPUTEE ? S.def.tprm.mDamageNodeLength : S.def.tprm.mNodeLength; }
  function changeState(S, T, st) {   // changeStateAndFixNodes
    if (T.state === st) return;
    T.state = st; T.t = 0;
    T.fix.fill(0);
    switch (st) {
      case T_ATTACK: T.fix[0] = 1; setAttackTarget(S, T); break;
      case T_AMPUTEE:
        T.fix[T.n - 1] = 1;
        if (T.unk48) break;
        gotTentacleDamage(S);
        T.unk48 = 1; T.dmg = 0;
        S.ev.push({ k: S.k, e: 'amputee', i: T.i });
        break;
      case T_STUN:
        T.fix[0] = 1;
        if (S.mode === A_CONTAINER) T.fix[1] = 1;
        T.v.forEach((v) => v.fill(0));
        break;
      case T_HELD: T.fix[0] = 1; T.fix[T.n - 1] = 1; break;
      case T_UNKA: T.fix[0] = 1; guideSet(S, T, BCK.shGuard); break;
      case T_WAIT: case T_REST: case T_FOLLOW: case T_SYNC: T.fix[0] = 1; break;
      case T_GUARD: T.fix[0] = 1; T.fix[1] = 1; break;
      case T_HIDE: T.fix[0] = 1; T.dmg = 0; T.unk48 = 0; break;
    }
    T.noCollision = st === T_HIDE;
    if (st === T_GUARD) T.noAttack = true;
  }
  function returnToDefault(S, T) { changeState(S, T, S.mode === A_CONTAINER ? T_GUARD : T_WAIT); }
  function guideSet(S, T, idx) { const a = S.def.anims.bck[idx]; T.guide.idx = idx; T.guide.f.init(a ? a.d : 1, a ? a.l : 0, 2); }
  function attackSpeed(S) { const P = S.def.prm; return S.mode === A_UNISON ? P.mSLUnisonAttackSpeed : S.mode === A_DOUBLE ? P.mSLDoubleAttackSpeed : S.mode === A_SKIP ? P.mSLSkipRopeAttackSpeed : 1; }
  function setAttackTarget(S, T) {
    const m = S.mario || { x: S.pos[0], y: S.pos[1], z: S.pos[2] + 1000, ground: true };
    T.target.set([m.x, m.y, m.z]);
    if (S.mode === A_UNISON) {   // side by side across the way to Mario: -2, -1, 2, 1 times 80
      const off = [-2, -1, 2, 1][T.i];
      let cx = m.z - S.pos[2], cz = -(m.x - S.pos[0]);   // up x (to Mario)
      const l = Math.hypot(cx, cz) || 1;
      cx /= l; cz /= l;
      T.target[0] += cx * off * 80; T.target[2] += cz * off * 80;
    }
    if (S.def.stage === 4 && T.target[1] < S.pos[1] + 20) T.target[1] = S.pos[1] + 20;
    const grounded = !!(m.ground || m.roof);
    guideSet(S, T, S.mode === A_UNISON ? (grounded ? BCK.shIssei : BCK.shFly) : S.mode === A_DOUBLE ? BCK.shIssei : S.mode === A_SKIP ? BCK.shJump : grounded ? BCK.shAttack : BCK.shFly);
    T.guide.f.rate = attackSpeed(S) * 2;
    T.unk4C = 0;
  }
  // calcVelocity: a node's velocity toward its neighbour's next position at the node length.
  function calcVelocity(S, T, i, j, prop) {
    const TP = S.def.tprm, a = T.p[i], nb = T.p[j], nv = T.v[j];
    const ax = nb[0] + nv[0], ay = nb[1] + nv[1], az = nb[2] + nv[2];
    let dx = a[0] - ax, dy = a[1] - ay, dz = a[2] - az;
    const len = nodeLen(S, T), lim = TP.mNodeLenLimit;
    let d = Math.hypot(dx, dy, dz);
    if (d === 0) { dx = dy = dz = 0; } else { dx /= d; dy /= d; dz /= d; }
    if (d > lim) {
      if (T.fix[i]) { if (!T.fix[j]) { nb[0] += dx * lim; nb[1] += dy * lim; nb[2] += dz * lim; } }
      else { a[0] = ax + dx * lim; a[1] = ay + dy * lim; a[2] = az + dz * lim; }
      return;
    }
    if (d < len) d += Math.min(len - d, TP.mSpeedMax);
    else d -= Math.min(d - len, TP.mSpeedMax);
    const v = T.v[i], ip = TP.mInertiaProp;
    v[0] = v[0] * ip + (ax + dx * d - a[0]) * prop;
    v[1] = v[1] * ip + (ay + dy * d - a[1]) * prop;
    v[2] = v[2] * ip + (az + dz * d - a[2]) * prop;
  }
  function calcPosition(S, T, i) {
    if (T.fix[i]) return;
    const p = T.p[i], v = T.v[i], st = T.state;
    if (st === T_STUN || st === T_AMPUTEE || st === T_FOLLOW || st === T_HELD) { p[0] += v[0]; p[1] += v[1]; p[2] += v[2]; return; }
    const u = T.u[i];
    let dx = u[0] - p[0], dy = u[1] - p[1], dz = u[2] - p[2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 > 0.01) {
      let f;
      if (l2 > 1e8) f = 1;
      else if (st === T_SYNC) f = T.t < 60 ? T.t * 0.5 / 60 : 0.5;
      else if (st === T_ATTACK || st === T_UNKA) f = T.t < 180 ? T.t * 0.4 / 180 : 0.4;
      else if (st === T_REST) f = T.t < 120 ? T.t * 0.05 / 120 : 0.05;
      else { f = Math.sqrt(l2) * 0.00025; f *= f; }
      if (f > 1) f = 1;
      v[0] += dx * f; v[1] += dy * f; v[2] += dz * f;
    }
    p[0] += v[0]; p[1] += v[1]; p[2] += v[2];
  }
  function beatNode(S, T, idx, vx, vy, vz) {
    T.v[idx][0] = vx; T.v[idx][1] = vy; T.v[idx][2] = vz;
    const prop = T.state === T_AMPUTEE ? S.def.tprm.mDamageReflectProp : S.def.tprm.mReflectProp;
    for (let i = idx + 1; i < T.n; i++) {
      calcVelocity(S, T, i, i - 1, prop);
      if (T.fix[i]) { for (let j = i - 1; j >= 0; j--) calcVelocity(S, T, j, j + 1, prop); break; }
    }
    for (let i = idx - 1; i >= 0; i--) {
      calcVelocity(S, T, i, i + 1, prop);
      if (T.fix[i]) { for (let j = i + 1; j < T.n; j++) calcVelocity(S, T, j, j - 1, prop); break; }
    }
  }
  function moveNode(S, T) {
    const TP = S.def.tprm;
    let force = TP.mVibrationForce, speed = TP.mVibrationSpeed;
    if (T.state === T_AMPUTEE) { force *= TP.mDamagePropF; speed *= TP.mDamagePropS; }
    T.ph40 = wrap(T.ph40 + speed, 0, 360);
    T.ph44 = wrap(T.ph44 + speed * 1.3, 0, 360);
    let bx, by, bz;
    switch (T.i) {
      case 0: bx = sinD(T.ph40) * -1.9 * force; by = sinD(T.ph40) * force; bz = cosD(T.ph44) * 1.8 * force; break;
      case 1: bx = sinD(T.ph40) * -1 * force; by = sinD(T.ph44) * 0.8 * force; bz = cosD(T.ph44) * 1.1 * force; break;
      case 3: bx = sinD(T.ph40) * force; by = sinD(T.ph44) * 0.8 * force; bz = cosD(T.ph44) * 1.1 * force; break;
      default: bx = sinD(T.ph40) * 1.9 * force; by = sinD(T.ph40) * force; bz = cosD(T.ph44) * 1.8 * force; break;
    }
    if (T.state === T_STUN) T.v.forEach((v) => { v[0] = 0; v[2] = 0; v[1] -= GRAVITY; });
    else if (T.state === T_HELD) beatNode(S, T, T.n - 1, bx, by, bz);
    else { beatNode(S, T, T.n - 1, bx, by, bz); beatNode(S, T, T.n - 3, -bx, -by, -bz); }
    const map = S.def.map, cont = S.mode === A_CONTAINER;
    for (let i = 0; i < T.n; i++) {
      calcPosition(S, T, i);
      if ((i === 0 || i === 1) && cont) continue;
      const p = T.p[i];
      const w = S.def.wall(p[0], p[1], p[2], 150);
      if (w) { p[0] = w[0]; p[2] = w[1]; }
      let g;
      if ((map === 3 && S.def.stage === 0) || map === 59) g = S.def.ground(p[0], p[1] + 200, p[2]);
      else if (S.def.stage === 4) g = S.pos[1];
      else if (map === 9 && S.def.stage === 1) g = Math.max(S.def.ground(p[0], S.pos[1] + 500, p[2]), S.pos[1]);
      else g = S.def.ground(p[0], S.pos[1] + 500, p[2]);
      g += 20;
      if (p[1] < g) { T.v[i].fill(0); p[1] = g; }
      if (T.state === T_STUN && p[1] < S.pos[1]) p[1] = S.pos[1] + 10;
      if (S.pos[1] < p[1]) {   // kept out of his body
        let dx = S.pos[0] - p[0], dy = S.pos[1] - p[1], dz = S.pos[2] - p[2];
        const r = (S.def.prm.mSLBodyRadius || 30), l = Math.hypot(dx, dy, dz);
        if (l < r && l > 0) { dx = dx / l * r; dy = dy / l * r; dz = dz / l * r; p[0] += dx; p[1] += dy; p[2] += dz; }
      }
    }
    for (let i = 0; i < T.n; i++) T.spline.set(i, T.p[i][0], T.p[i][1], T.p[i][2]);
  }
  function moveConstraint(S, T) {
    const P = S.def.prm;
    switch (T.state) {
      case T_ATTACK: {
        for (let i = 0; i < T.n; i++) { const m = T.guide.W[i]; T.u[i][0] = m[3]; T.u[i][1] = m[7]; T.u[i][2] = m[11]; }
        const homing = S.beak.holder ? P.mSLBeakHoming : S.mode === A_UNISON ? P.mSLUnisonHoming : P.mSLSingleHoming;
        if (T.t < homing && S.mode !== A_UNISON && S.mario) { T.target[0] = S.mario.x; T.target[2] = S.mario.z; }
        break;
      }
      case T_UNKA:
        for (let i = 0; i < T.n; i++) { const m = T.guide.W[i]; T.u[i][0] = m[3]; T.u[i][1] = m[7]; T.u[i][2] = m[11]; }
        break;
      case T_STUN:
        if (S.mode === A_CONTAINER) return;
      // fallthrough
      case T_WAIT: case T_REST: case T_SYNC: {
        const j0 = SEMI_JOINTS[T.i];
        for (let i = 0; i < T.n; i++) { const m = S.W[i + j0]; T.u[i][0] = m[3]; T.u[i][1] = m[7]; T.u[i][2] = m[11]; }
        break;
      }
      case T_GUARD: {
        const p = T.p[0], len = nodeLen(S, T);
        T.u[0].set(p);
        let x = p[0], y = p[1];
        for (let i = 1; i < T.n; i++) { x -= len * 1.3; y -= len * 1.5; T.u[i][0] = x; T.u[i][1] = y; T.u[i][2] = p[2]; }
        break;
      }
      case T_HIDE: {
        let y = S.pos[1];
        const len = nodeLen(S, T);
        for (let i = 0; i < T.n; i++) { T.u[i][0] = S.pos[0]; T.u[i][1] = y; T.u[i][2] = S.pos[2]; y += 0.5 * len; }
        break;
      }
    }
  }
  function decideOwnState(S, T) {
    const P = S.def.prm;
    switch (T.state) {
      case T_ATTACK: if (T.guide.f.endsNext()) changeState(S, T, T_REST); break;
      case T_STUN: {
        const l = T.p[T.n - 1];
        if (Math.abs(angDiff(S.rot[1], rotFromZY(l[0] - S.pos[0], l[2] - S.pos[2]))) > 45) changeState(S, T, T_REST);
        if (T.state === T_STUN && T.t >= P.mSLStunTime) returnToDefault(S, T);
      }
      // fallthrough
      case T_WAIT: case T_REST:
        if (T.state === T_REST && T.t >= P.mSLRestTime) returnToDefault(S, T);
        break;
      case T_AMPUTEE:
        if (T.t >= P.mSLAmputeeTime) { changeState(S, T, T_HIDE); break; }
        if (T.t >= P.mSLAmputeeTime - 240 && T.holder) { T.holder = false; marioLetGo(S, T); }
        break;
    }
  }
  function checkDamage(S, T) {
    if (T.dmg >= S.def.tprm.mDamageCountMax) {
      if (S.mode === A_CONTAINER) S.ev.push({ k: S.k, e: 'movie' });   // fireStreamingMovie(10): the breakout
      S.unk1A8 = S.def.prm.mSLAmputeeWait;
      changeState(S, T, T_AMPUTEE);
    }
  }
  // decideAtkColExists: when the tentacle can hurt (its guide animation's striking frames).
  function decideAtkCol(S, T) {
    const f = T.guide.f.frame, g = T.guide.idx;
    let on = false;
    if (T.state === T_UNKA || S.mode === A_ROLL) on = true;
    else if (g === BCK.shFly || g === BCK.shAttack) on = f >= 75 && f <= 130;
    else if (g === BCK.shIssei) on = f >= 75 && f <= 110;
    else if (g === BCK.shJump) on = f >= 80 && f <= 220;
    T.noAttack = !on;
  }
  // calcAttackGuideAnm: bgeso_shand from the first node toward the target, stretched along it.
  const _gm = m34(), _gz = m34();
  function calcGuide(S, T) {
    if (T.state !== T_ATTACK && T.state !== T_SYNC && T.state !== T_UNKA) return;
    const p0 = T.p[0], dx = T.target[0] - p0[0], dy = T.target[1] - p0[1], dz = T.target[2] - p0[2];
    const r = rotFromZ(dx, dy, dz), len = Math.hypot(dx, dy, dz);
    let zs = T.state === T_UNKA ? 1 : T.guide.idx === BCK.shAttack ? len / 1500 : len / 1200;
    if (zs > 2) zs = 2;
    mTRS(_gm, p0[0], p0[1], p0[2], r[0], r[1], r[2], 1, 1, zs);
    const za = T.state === T_UNKA ? [80, 60, -80, -60] : S.mode === A_UNISON || S.mode === A_DOUBLE ? [65, 40, -65, -40] : S.mode === A_SKIP ? [80, 70, -80, -70] : [20, 7.5, -20, -7.5];
    mMul(_gm, mRotZ(_gz, za[T.i]), T.guide.M);
    T.guide.f.update();   // (MActor::calcAnm: the frame steps, then the joints)
    guidePose(S, T);
    atkEffects(S, T);
  }
  function guidePose(S, T) {
    const A = S.def.anims, a = A.bck[T.guide.idx], par = A.shand.parent;
    for (let j = 0; j < par.length; j++) {
      if (a) bckLocal(a, j, T.guide.f.frame, _L); else bindLocal(A.shand.trs, j, _L);
      localMatrix(_L, null, 0, _lm);
      mMul(par[j] >= 0 ? T.guide.W[par[j]] : T.guide.M, _lm, T.guide.W[j]);
    }
  }
  const _hand = Array.from({ length: 17 }, () => m34()), _hn = new Float64Array(18);
  function atkEffects(S, T) {   // calcAtkParticleAndSE: the dust where a strike hits the floor, the blur along it
    const g = T.guide.idx, f = T.guide.f.frame;
    // unk50: bgeso_shand's joint 3 (times mSLBlurScale) at the tentacle's joint mSLBlurJoint (7 for
    // the unison strike) - what the blur effects ride on.
    const P = S.def.prm, bs = P.mSLBlurScale || 1, src = T.guide.W[3], B = T.blur || (T.blur = m34());
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) B[r * 4 + c] = src[r * 4 + c] * bs;
    for (let i = 0; i < 6; i++) { _hn[i * 3] = T.p[i][0]; _hn[i * 3 + 1] = T.p[i][1]; _hn[i * 3 + 2] = T.p[i][2]; }
    handMatrices(_hn, nodeLen(S, T), T.state, 17, _hand, T.hspline || (T.hspline = new Spline(6)));
    const hj = _hand[g === BCK.shIssei ? 7 : Math.min(16, P.mSLBlurJoint === undefined ? 10 : P.mSLBlurJoint)];
    B[3] = hj[3]; B[7] = hj[7]; B[11] = hj[11];
    if (T.state !== T_UNKA && T.state !== T_SYNC) {
      const fc = T.guide.f;
      const kind = g === BCK.shJump ? (fc.checkPass(115) ? 'blur_j' : null) : g === BCK.shAttack ? (fc.checkPass(115) ? 'blur' : null)
        : g === BCK.shIssei ? (fc.checkPass(86) ? 'blur' : null) : (fc.checkPass(81) ? 'blur_f' : null);
      if (kind) S.ev.push({ k: S.k, e: 'blur', i: T.i, kind });
    }
    if ((g === BCK.shAttack || g === BCK.shIssei) && T.unk4C === 0 && ((g === BCK.shAttack && f >= 118 && f <= 160) || (g === BCK.shIssei && f >= 75 && f <= 110))) {
      const l = T.p[T.n - 1], gy = S.def.ground(l[0], l[1] + 500, l[2]);
      if (l[1] < gy + 100) { T.unk4C = 1; S.ev.push({ k: S.k, e: 'slam', i: T.i, p: [l[0], gy + 5, l[2]] }); }
    }
  }
  function tentacleMove(S, T) {   // TBGTentacle::perform, CUE_MOVE part
    decideAtkCol(S, T);
    moveConstraint(S, T);
    moveNode(S, T);
    decideOwnState(S, T);
    checkDamage(S, T);
    T.t++;
  }
  // TBGTakeHit::perform: Mario holding the tip: its pull goes to the last node; the tentacle no
  // longer held or torn off (the boss changing all of them at once) lets him go for a moment, and
  // with B still down he takes it again at the next hit check (TMario::considerTake / hitNoKeepPull).
  function takeHitMove(S, T) {
    if (T.holder) {
      const l = T.v[T.n - 1];
      if (T.a74[0] || T.a74[1] || T.a74[2]) { l[0] += T.a74[0]; l[1] += T.a74[1]; l[2] += T.a74[2]; }
      T.a74.fill(0);
      if (T.state !== T_HELD && T.state !== T_AMPUTEE) { T.holder = false; marioLetGo(S, T); S.regrab = T; }
    }
  }
  function marioLetGo(S, T) { if (S.holding === T) S.holding = null; }
  // TBGTakeHit::moveRequest: Mario's pull (TMario::pulling) puts the tip where he moves to; past
  // the length limit from the boss with the stick away from him, it tears a little more.
  function tentaclePull(S, T, x, y, z, sx, sz, mag) {
    const TP = S.def.tprm, w = S.def.wall(x, y, z, 150);
    if (w) { x = w[0]; z = w[1]; }
    const dx = x - S.pos[0], dy = y - S.pos[1], dz = z - S.pos[2];
    const l = T.p[T.n - 1];
    if (Math.hypot(dx, dy, dz) > TP.mTotalLenLimit) {
      const st = mag * (S.def.prm.mSLTentacleStretch || 0.1);
      T.a74[0] = sx * st; T.a74[1] = 0; T.a74[2] = sz * st;
      if (-dx * T.a74[0] - dz * T.a74[2] < 0) {
        if (T.state !== T_AMPUTEE) changeState(S, T, T_HELD);
        if (T.dmg < TP.mDamageCountMax) T.dmg++;
      }
    }
    l[0] = x; l[1] = y; l[2] = z;
  }
  function canTake(T) { return T.state !== T_UNKA && T.state !== T_AMPUTEE && T.state !== T_HIDE; }

  // ---------------------------------------------------------------- the beak (TBGBeakHit)
  function beakTakeOk(S) {
    if (S.mode === A_GUARD) return false;
    const l = latest(S);
    return l !== NERVE.pollute && l !== NERVE.polDrop && l !== NERVE.beak;
  }
  function beakMove(S) {   // perform, CUE_MOVE: the pull's limits
    const b = S.beak;
    if (!b.holder) return;
    const P = S.def.prm, d = Math.hypot(b.p[0] - S.pos[0], b.p[1] - 25 - S.pos[1], b.p[2] - S.pos[2]);
    if (S.alpha !== 0 && d >= P.mSLBeakLengthPollute) { beakRelease(S, false); S.regrab = 'beak'; return; }   // a dirty face: he can't hold on
    if (d >= P.mSLBeakLengthLimit) { beakRelease(S, false); gotBeakDamage(S); }
  }
  // Let go of (THROWN / DETACH from Mario): far enough out, the beak snaps back on him.
  function beakRelease(S, byMario) {
    const b = S.beak;
    if (!b.holder) return;
    // (receiveMessage refuses it in guard mode or in those nerves; it lets go all the same, by
    // TTakeActor::ensureTakeSituation, as Mario no longer has it)
    if (byMario && S.mode !== A_GUARD && beakTakeOk(S)) {
      const d = Math.hypot(b.p[0] - S.pos[0], b.p[1] - 25 - S.pos[1], b.p[2] - S.pos[2]);
      if (d >= S.def.prm.mSLBeakLengthDamage) gotBeakDamage(S);
    }
    b.holder = false;
    if (S.holding === 'beak') S.holding = null;
  }

  // ---------------------------------------------------------------- the goop ball (TBGPolDrop)
  function polMove(S) {
    const pd = S.pol;
    if (!pd.st) return;
    const n = [pd.p[0] + pd.v[0], pd.p[1] + pd.v[1], pd.p[2] + pd.v[2]];
    if (pd.st === 1) {
      pd.v[1] -= 0.2;
      let g = S.def.ground(n[0], pd.p[1], n[2]);
      if (g === -Infinity) { pd.st = 0; return; }
      g += 1;
      if (n[1] < g) {
        pd.st = 2; n[1] = g; pd.v = [0, 0, 0];
        if (pd.idx !== BCK.ballOsen) { polBck(S, BCK.ballOsen); polBck(S, BCK.ballWhiteOsen); }
        S.ev.push({ k: S.k, e: 'splat', p: n.slice() });
      } else if (pd.idx !== BCK.ballFly || pd.f.endsNext()) polBck(S, BCK.ballFly);
      const w = S.def.wall(n[0], n[1], n[2], 80);
      if (w) pd.st = 0;
    } else if (pd.st === 2 && pd.f.endsNext()) pd.st = 0;
    pd.p = n;
  }
  function polBck(S, idx) { const a = S.def.anims.bck[idx]; S.pol.idx = idx; S.pol.f.init(a ? a.d : 1, a ? a.l : 0, 2); }

  // ---------------------------------------------------------------- a frame
  // Mario this tick: the ghost's frame k - 1 to frame k (its samples are at the ends of frames).
  function marioTick(S, k, i) {
    const a = S.def.mario(k), b = S.def.mario(k - 1) || a;
    if (!a) return null;
    const u = (i + 1) / 4;
    return { x: b.x + (a.x - b.x) * u, y: b.y + (a.y - b.y) * u, z: b.z + (a.z - b.z) * u, yaw: a.yaw, ground: a.ground, roof: a.roof, held: a.held,
      mx: a.x - b.x, mz: a.z - b.z };
  }
  function nearestTip(S, m) {
    let best = null, bd = Infinity;
    S.T.forEach((T) => {
      if (!canTake(T) || T.noCollision || (S.mode === A_CONTAINER && T.i !== 0)) return;
      const tip = T.spline.at(1, [0, 0, 0]);
      const d = Math.hypot(tip[0] - m.x, tip[2] - m.z) + Math.abs(tip[1] - 100 - m.y) * 0.5;
      if (d < bd) { bd = d; best = T; }
    });
    return best;
  }
  // The hit check (first tick of the frame): what Mario takes or lets go of, and water on the face.
  function hitCheck(S, k) {
    const m = S.mario;
    const want = m ? m.held : 0;
    // let go
    if (S.holding && ((S.holding === 'beak' && want !== 'beak') || (S.holding !== 'beak' && want !== 'tentacle'))) {
      if (S.holding === 'beak') beakRelease(S, true);
      else { const T = S.holding; T.holder = false; if (T.state !== T_AMPUTEE) returnToDefault(S, T); S.holding = null; }
    }
    // take (and take again after a moment's let-go: B is still down)
    if (m && want === 'tentacle' && !S.holding) {
      const T = S.regrab && S.regrab !== 'beak' && canTake(S.regrab) ? S.regrab : nearestTip(S, m);
      if (T) { T.holder = true; changeState(S, T, T_HELD); S.holding = T; }
    }
    if (m && want === 'beak' && !S.holding && beakTakeOk(S) && S.mode !== A_GUARD) {
      S.beak.holder = true; S.holding = 'beak';
      S.beak.p = [m.x, m.y, m.z];
    }
    S.regrab = null;
    if (S.mode !== A_GUARD && S.mode !== A_CONTAINER && sprayHit(S, k)) gotEyeDamage(S);
  }
  // Water on his eyes or beak this frame (TBGEyeHit / TBGBeakHit::receiveMessage): the viewer's
  // (def.spray) when the ghost records FLUDD. Before that (Moonshine V4: no FLUDD, no inputs), the
  // runs' own way of doing it (the wiki's Ricco 1 and 5 pages): they spray his face clean before
  // each nose pull that goes past mSLBeakLengthPollute (a dirty face makes Mario let go there),
  // from as soon as they can (holding R coming out of the cutscene; spam sprays from the valve
  // bounce) until it is clean: here, every frame Mario faces him from within SPRAY.reach holding
  // nothing, the water landing SPRAY.speed units a frame later.
  const SPRAY = { reach: 4000, cone: 30, speed: 180, lag: 2 };
  function sprayHit(S, k) {
    if (S.def.spray) return S.def.spray(k, S);
    return S.alpha !== 0 && !!S.sprayAt && S.sprayAt.has(k);
  }
  // The nose pulls (from the ghost): when each starts, whether it has to have a clean face, and
  // when water from the frames before it reaches his face.
  function planHolds(S, from, to) {
    const out = [];
    let a = -1, far = 0;
    for (let k = from; k <= to + 1; k++) {
      const m = k <= to ? S.def.mario(k) : null;
      const on = !!(m && m.held === 'beak');
      if (on) {
        if (a < 0) { a = k; far = 0; }
        far = Math.max(far, Math.hypot(m.x - S.pos[0], m.z - S.pos[2]));
      } else if (a >= 0) { out.push({ a, b: k - 1, far }); a = -1; }
    }
    S.holds = out;
    S.sprayAt = new Set();
    if (S.def.spray) return;
    let prev = from;
    out.forEach((h) => {
      if (h.far > S.def.prm.mSLBeakLengthPollute + 20) {
        const fx = S.pos[0], fz = S.pos[2];
        for (let j = prev; j < h.a; j++) {
          const m = S.def.mario(j);
          if (!m || m.held) continue;
          const d = Math.hypot(fx - m.x, fz - m.z);
          if (d < 150 || d > SPRAY.reach || Math.abs(angDiff(rotFromZY(fx - m.x, fz - m.z), m.yaw)) > SPRAY.cone) continue;
          S.sprayAt.add(j + SPRAY.lag + Math.round(d / SPRAY.speed));
        }
      }
      prev = h.b + 1;
    });
  }

  function stepFrame(S) {
    const k = S.k;
    for (let i = 0; i < 4; i++) {
      S.mario = marioTick(S, k, i);
      const calc = i === 3;
      if (i === 0) hitCheck(S, k);
      // Mario pulling (TMario::pulling -> moveRequest of what he holds), before the boss moves.
      if (S.mario && S.holding) {
        const m = S.mario, mv = Math.hypot(m.mx, m.mz), mag = mv > 4 ? 32 : 0;
        if (S.holding === 'beak') S.beak.p = [m.x, m.y, m.z];
        else tentaclePull(S, S.holding, m.x, m.y, m.z, mv ? m.mx / mv : 0, mv ? m.mz / mv : 0, mag);
      }
      perform(S, calc);
      S.moveTicks++;
    }
    record(S);
    S.k++;
  }
  function perform(S, calc) {
    if (S.unk1AC > 0) S.unk1AC--;
    if (S.unk1AE > 0) S.unk1AE--;
    if (S.mode === A_CONTAINER) {   // in the container: only the tentacle sticking out
      const T = S.T[0];
      if (calc && T.state !== T_AMPUTEE) { T.p[0].set([11603, 2114.3, 2411.4]); T.p[1].set([11510, 2114.3, 2411.4]); }
      tentaclePerform(S, T, calc);
      return;
    }
    if (!S.dead) {
      moveObject(S);
      if (calc) {
        S.bck.f.update(); S.btp.f.update();
        if (S.btk.on) S.btk.f.update();
        if (S.cork.crushed) S.cork.f.update();
        calcBody(S);
      }
    }
    polMove(S);
    if (calc && S.pol.st) S.pol.f.update();
    if (S.dead) return;
    if (calc && S.unk194 > 0) { S.fxWash = true; S.unk194--; }   // ms_boge_wash on his body joint
    beakMove(S);
    S.bck.ratio = Math.max(0, S.bck.ratio - S.bck.rate);   // advanceMotionBlend(-unk188)
    if (calc) S.T.forEach((T) => { if (T.state !== T_AMPUTEE) T.p[0].set(jointPos(S, ROOT_JOINTS[T.i])); });
    S.T.forEach((T) => tentaclePerform(S, T, calc));
  }
  function tentaclePerform(S, T, calc) {   // TBGTentacle::perform: the take hit, the guide, then the rest
    takeHitMove(S, T);
    if (calc) calcGuide(S, T);
    tentacleMove(S, T);
  }

  // The frame for the viewer: see REC.
  function record(S) {
    const r = new Float32Array(REC);
    r[0] = S.pos[0]; r[1] = S.pos[1]; r[2] = S.pos[2]; r[3] = S.rot[0]; r[4] = S.rot[1]; r[5] = S.rot[2];
    r[6] = S.bck.idx; r[7] = S.bck.f.frame; r[8] = S.bck.oldIdx; r[9] = S.bck.oldF; r[10] = S.bck.ratio;
    r[11] = S.btp.idx; r[12] = S.btp.f.frame; r[13] = S.btk.on ? 1 : 0; r[14] = S.btk.f.frame; r[15] = S.alpha;
    r[16] = S.beak.holder ? 1 : 0; r[17] = S.beak.p[0]; r[18] = S.beak.p[1]; r[19] = S.beak.p[2];
    r[20] = (S.dead ? 1 : 0) | (S.mode === A_CONTAINER ? 2 : 0) | (S.dieFly ? 4 : 0) | (S.cork.crushed ? 8 : 0);
    r[21] = S.cork.f.frame; r[22] = S.vel[0]; r[23] = S.vel[1]; r[24] = S.vel[2]; r[25] = S.mode;
    S.T.forEach((T, i) => {
      const o = REC_T + i * REC_TN;
      // drawn unless hidden, or blinking in the last 240 ticks torn off (CUE_ENTRY skipped)
      const blink = T.state === T_AMPUTEE && T.t >= S.def.prm.mSLAmputeeTime - 240 && (T.t % 6) >= 3;
      r[o] = T.state; r[o + 1] = T.state === T_HIDE || blink || (S.mode === A_CONTAINER && i !== 0) ? 0 : 1;
      r[o + 2] = nodeLen(S, T); r[o + 3] = T.dmg;
      for (let n = 0; n < 6; n++) { r[o + 4 + n * 3] = T.p[n][0]; r[o + 5 + n * 3] = T.p[n][1]; r[o + 6 + n * 3] = T.p[n][2]; }
    });
    const o = REC_T + 4 * REC_TN, pd = S.pol;
    r[o] = pd.st; r[o + 1] = pd.p[0]; r[o + 2] = pd.p[1]; r[o + 3] = pd.p[2]; r[o + 4] = pd.v[0]; r[o + 5] = pd.v[1]; r[o + 6] = pd.v[2];
    r[o + 7] = pd.idx; r[o + 8] = pd.f.frame; r[o + 9] = latestCode(S);
    const l = latest(S);
    r[REC_FX] = (l === NERVE.eye || l === NERVE.tug ? FX.namida : 0) | (l === NERVE.tug ? FX.ase : 0) | (S.fxWash ? FX.wash : 0) | (pd.st === 1 ? FX.kiseki : 0);
    S.fxWash = false;
    S.T.forEach((T, i) => { if (T.blur) r.set(T.blur, REC_BLUR + i * 12); });
    S.frames.push(r);
    if (S.def.keep && S.frames.length > 2 * S.def.keep) { S.frames = S.frames.slice(S.def.keep); S.base0 += S.def.keep; }   // (idle: only the latest)
  }
  const NERVE_CODES = Object.keys(NERVES);
  function latestCode(S) { return NERVE_CODES.indexOf(latest(S)); }

  // Run to frame k (kept: frames already worked out are only read back).
  function runTo(S, k) {
    if (!S.planned) { planHolds(S, 0, S.def.frames || 0); S.planned = true; }
    const lim = S.def.frames || Infinity;
    while (S.k <= k && S.k < lim) stepFrame(S);
    return S.frames[Math.max(0, Math.min(k - S.base0, S.frames.length - 1))];
  }

  // ---------------------------------------------------------------- the tentacle's joints
  // TBGTentacleMtxCalc::calc: bgeso_hand's joint i sits on the spline at i / (joints - 1), its x
  // axis toward the next joint, y from the cross with the last one's z (kept from flipping), all
  // three scaled by sqrt(node length / (3 x spacing)) within 0.7 - 1.2 (thinner where stretched).
  // The game takes the next joint's position from the last frame (not worked out yet); this uses
  // this frame's. nodes: 18 floats; out: 17 matrices (world 3x4).
  function handMatrices(nodes, nodeLength, state, joints, out, sp) {
    sp = sp || new Spline(6);
    for (let i = 0; i < 6; i++) sp.set(i, nodes[i * 3], nodes[i * 3 + 1], nodes[i * 3 + 2]);
    const last = joints - 1, P = [];
    for (let i = 0; i < joints; i++) P.push(sp.at(i / last, [0, 0, 0]));
    for (let i = 0; i < joints; i++) {
      const m = out[i], p = P[i];
      let x;
      if (i === last) x = [P[i - 1][0] - P[i - 2][0], P[i - 1][1] - P[i - 2][1], P[i - 1][2] - P[i - 2][2]];
      else x = [P[i + 1][0] - p[0], P[i + 1][1] - p[1], P[i + 1][2] - p[2]];
      let l = Math.hypot(x[0], x[1], x[2]);
      x = l ? [x[0] / l, x[1] / l, x[2] / l] : [1, 0, 0];
      let y, s = 1;
      if (i === 0) y = [0, 1, 0];
      else {
        const q = out[i - 1], pz = [q[2], q[6], q[10]];
        y = [x[1] * pz[2] - x[2] * pz[1], x[2] * pz[0] - x[0] * pz[2], x[0] * pz[1] - x[1] * pz[0]];
        if (y[0] * y[0] + y[1] * y[1] + y[2] * y[2] < 0.01) y = [q[1], q[5], q[9]];
        l = Math.hypot(y[0], y[1], y[2]) || 1; y = [y[0] / l, y[1] / l, y[2] / l];
        const gap = Math.hypot(q[3] - p[0], q[7] - p[1], q[11] - p[2]);
        s = gap === 0 ? 1 : nodeLength / (gap * 3);
        const px = [q[0], q[4], q[8]], py = [q[1], q[5], q[9]];
        if (i < last && px[0] * x[0] + px[1] * x[1] + px[2] * x[2] > 0 && py[0] * y[0] + py[1] * y[1] + py[2] * y[2] < 0) y = [-y[0], -y[1], -y[2]];
      }
      let z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
      l = Math.hypot(z[0], z[1], z[2]);
      z = l ? [z[0] / l, z[1] / l, z[2] / l] : [0, 0, 1];
      if ((i === last || i === joints - 2) && s < 1) s = 1;
      if (Math.abs(s) > 0.01) s = Math.sqrt(s);
      s = Math.max(0.7, Math.min(1.2, s));
      x = [x[0] * s, x[1] * s, x[2] * s]; y = [y[0] * s, y[1] * s, y[2] * s]; z = [z[0] * s, z[1] * s, z[2] * s];
      if (state === T_STUN && (i === last || i === joints - 2)) {   // the tip flattened on the floor
        y = [0, 0.3, 0];
        x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
        l = Math.hypot(x[0], x[1], x[2]) || 1; x = [x[0] / l, x[1] / l, x[2] / l];
        z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
        l = Math.hypot(z[0], z[1], z[2]) || 1; z = [z[0] / l * 2, z[1] / l * 2, z[2] / l * 2];
      }
      m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
      m[3] = p[0]; m[7] = p[1]; m[11] = p[2];
    }
    return out;
  }

  const api = { create, runTo, bodyMatrices, handMatrices, trackAt, Frame, Spline, m34, REC, REC_T, REC_TN, REC_FX, REC_BLUR, FX, BCK, BTP, NERVE_CODES,
    T_STATE: { WAIT: T_WAIT, ATTACK: T_ATTACK, REST: T_REST, HELD: T_HELD, AMPUTEE: T_AMPUTEE, STUN: T_STUN, HIDE: T_HIDE, SYNC: T_SYNC, GUARD: T_GUARD } };
  root.GessoSim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
