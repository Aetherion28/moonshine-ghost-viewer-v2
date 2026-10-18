// Poses Mario from Moonshine ghost animation data using the game's own animations.
// Needs three.js, mario_anims.js (decomp tables) and mario_bck.json (decoded BCK keyframes).
//
// Ghost animation ID -> gMarioAnimeData[id] = [BCK file index, hand id]. While riding Yoshi,
// Moonshine stores the rider BCK index directly. Phase (0..4095) is frame / length * 4096.

const MarioRig = (() => {
  let bck = null;

  function hermite(p0, p1, s0, s1, t) {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * s0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * s1;
  }

  // Track: a constant number, or flat [time, value, tangentIn, tangentOut, ...].
  function sample(tr, f) {
    if (typeof tr === 'number') return tr;
    const n = tr.length >> 2;
    if (f < tr[0]) return tr[1];
    for (let i = 1; i < n; i++) {
      const t1 = tr[i * 4];
      if (f < t1) {
        const b = (i - 1) * 4, t0 = tr[b], len = t1 - t0;
        return hermite(tr[b + 1], tr[i * 4 + 1], tr[b + 3] * len, tr[i * 4 + 2] * len, (f - t0) / len);
      }
    }
    return tr[(n - 1) * 4 + 1];
  }

  const euler = new THREE.Euler(0, 0, 0, 'ZYX');

  function setData(json) { bck = json; }
  function ready() { return !!bck; }

  // Prepare a cloned Mario scene: map joint names to bones, find parts.
  function attach(root) {
    const rig = { root, bones: [], parts: {}, bodyShapes: {}, anim: null };
    const byName = {};
    root.traverse((o) => { if (o.name) byName[o.name] = byName[o.name] || o; });
    rig.bones = (bck ? bck.joints : []).map((n) => byName[n] || null);
    root.traverse((o) => {
      const m = /^(hand_\d_[lr]|cap|fludd_body|nozzle_\w+)$/.exec(o.name || '');
      if (m) rig.parts[m[1]] = o;
      const s = /^body_s(\d+)/.exec(o.name || '');
      if (s && o.isMesh) rig.bodyShapes[s[1]] = o;
    });
    rig.chest = byName.jnt_chest || null;
    rig.handR = byName.jnt_hand_R || null;
    // Shape 10 is the Hawaiian shirt the game only shows once Mario buys it (TMario::thinkAloha).
    if (rig.bodyShapes['10']) rig.bodyShapes['10'].visible = false;
    return rig;
  }

  function bckFor(animId, yoshi) {
    if (!bck) return null;
    const idx = yoshi ? animId : (MARIO_ANIM_TABLE[animId] || [200])[0];
    const file = MARIO_BCK_FILES[idx];
    return file ? { name: file, data: bck.anims[file] } : null;
  }

  // Hands per TMario::changeHand. J3DShpFlag_Visible set means the shape is skipped (J3DJoint
  // draw), so: 0 (default) -> the body's own hand shapes 5/6, no hand models; 1 -> ma_hnd2;
  // 2 -> ma_hnd3. ma_hnd4r is always hidden. Riding Yoshi always uses 0.
  function setHands(rig, handId) {
    const show = (k, v) => { if (rig.parts[k]) rig.parts[k].visible = v; };
    const h = handId === 1 || handId === 2 ? handId : 0;
    show('hand_2_r', h === 1); show('hand_2_l', h === 1);
    show('hand_3_r', h === 2); show('hand_3_l', h === 2);
    show('hand_4_r', false);
    ['5', '6'].forEach((s) => { if (rig.bodyShapes[s]) rig.bodyShapes[s].visible = h === 0; });
  }

  function pose(rig, animId, yoshi, phase) {
    const a = bckFor(animId, yoshi);
    if (!a || !a.data) return null;
    const frame = (phase / 4096) * a.data.d;
    const joints = a.data.j;
    for (let i = 0; i < rig.bones.length && i < joints.length; i++) {
      const b = rig.bones[i];
      if (!b) continue;
      const j = joints[i];
      b.scale.set(sample(j[0], frame), sample(j[1], frame), sample(j[2], frame));
      euler.set(sample(j[3], frame), sample(j[4], frame), sample(j[5], frame), 'ZYX');
      b.quaternion.setFromEuler(euler);
      b.position.set(sample(j[6], frame), sample(j[7], frame), sample(j[8], frame));
    }
    setHands(rig, yoshi ? 0 : (MARIO_ANIM_TABLE[animId] || [0, 0])[1]);
    rig.anim = a.name;
    return a.name;
  }

  return { setData, ready, attach, pose, setHands, bckFor };
})();
