// Parser for Moonshine .smsghost files (canonical SGHF, versions 3 to 8).
// Spec: moonshine/doc/ghost_format.md. All integers are big endian.

const GHOST_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function ghostCrc32(bytes, zeroStart = -1, zeroEnd = -1) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const b = i >= zeroStart && i < zeroEnd ? 0 : bytes[i];
    c = GHOST_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const GHOST_AREA_LABELS = {
  0x00: 'AS', 0x01: 'DP', 0x02: 'BH', 0x03: 'RH', 0x04: 'GB',
  0x05: 'PP', 0x06: 'SB', 0x08: 'PV', 0x09: 'NB', 0x34: 'CM', 0x3c: 'BW',
};

function ghostRouteLabel(route) {
  let area = route.area;
  let episode = route.episode;
  if (route.parentArea !== 0xff && route.variant >= 0) {
    area = route.parentArea;
    episode = route.variant;
  }
  const abbr = GHOST_AREA_LABELS[area];
  if (abbr) return abbr + (episode + 1);
  const hex = (v) => v.toString(16).toUpperCase().padStart(2, '0');
  return `A${hex(area)}E${hex(episode)}`;
}

// QF -> seconds. Moonshine's export uses durationQf * 1001 / 120 milliseconds.
function ghostQfToSeconds(qf) {
  return (qf * 1001) / 120000;
}

function ghostFormatTime(qf) {
  const ms = Math.floor((qf * 1001) / 120);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = String(ms % 1000).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${frac}` : `${s}.${frac}`;
}

function parseSmsGhost(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const fail = (msg) => { throw new Error(msg); };
  if (bytes.length < 0x100) fail('File is too small to be a Moonshine ghost.');
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'SGHF') fail('Not a Moonshine ghost (missing SGHF header).');
  const version = dv.getUint16(4);
  if (version < 3 || version > 8) fail(`Ghost version ${version} is newer than this viewer supports (3–8). The viewer needs an update for it.`);
  const fileSize = dv.getUint32(8);
  if (fileSize !== bytes.length) fail('Ghost file is truncated or has extra bytes.');

  const warnings = [];
  if (ghostCrc32(bytes, 0x0c, 0x10) !== dv.getUint32(0x0c)) warnings.push('File checksum does not match; the file may be damaged.');

  const text = (off, len) => String.fromCharCode(...bytes.subarray(off, off + len));
  const region = ['JP', 'US', 'PAL'][bytes[0x25]] || '?';
  const route = {
    area: bytes[0x2c], episode: bytes[0x2d], parentArea: bytes[0x2e],
    flags: bytes[0x2f], variant: dv.getInt32(0x30),
  };
  const header = {
    version, region, route,
    routeLabel: ghostRouteLabel(route),
    runFlags: dv.getUint32(0x1c),
    resultQf: dv.getUint32(0x34),
    startQf: dv.getUint32(0x38),
    endQf: dv.getUint32(0x3c),
    durationQf: dv.getUint32(0x40),
    sampleCount: dv.getUint32(0x44),
    created: dv.getUint32(0x4c) * 2 ** 32 + dv.getUint32(0x50),
    author: text(0x60, bytes[0x5c]),
    name: text(0x78, bytes[0x5d]),
    profileName: text(0xa8, bytes[0x5e]),
  };

  const segCount = dv.getUint16(0xb8);
  const segTable = dv.getUint32(0xbc);
  const sampleOff = dv.getUint32(0xc4);
  const sampleSize = dv.getUint32(0xc8);
  if (segCount < 1 || segCount > 64) fail('Ghost has an invalid segment count.');
  if (sampleOff + sampleSize > bytes.length || sampleSize !== header.sampleCount * 16) fail('Ghost sample data is out of bounds.');

  const be24s = (o) => { const v = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]; return v & 0x800000 ? v - 0x1000000 : v; };
  const be24u = (o) => (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];

  // Flatten every sample onto the ghost's absolute QF timeline.
  const n = header.sampleCount;
  const qf = new Float64Array(n);
  const pos = new Float32Array(n * 3);
  const yaw = new Int16Array(n);
  const anim = new Uint16Array(n);
  const phase = new Uint16Array(n);   // 0..4095: animation frame / length * 4096
  const yoshi = new Uint8Array(n);
  const held = new Uint8Array(n);     // V4+: 1..7 = attachment descriptor, 15 = unknown held actor
  const segIndex = new Uint8Array(n);
  const segments = [];
  for (let s = 0; s < segCount; s++) {
    const o = segTable + s * 0x20;
    const seg = {
      firstSample: dv.getUint32(o), sampleCount: dv.getUint32(o + 4),
      startQf: dv.getUint32(o + 8), endQf: dv.getUint32(o + 12),
      route: { area: bytes[o + 0x14], episode: bytes[o + 0x15], parentArea: bytes[o + 0x16], flags: bytes[o + 0x17], variant: dv.getInt32(o + 0x10) },
    };
    seg.routeLabel = ghostRouteLabel(seg.route);
    if (seg.firstSample + seg.sampleCount > n) fail('Ghost segment table is out of bounds.');
    let t = seg.startQf;
    for (let i = seg.firstSample; i < seg.firstSample + seg.sampleCount; i++) {
      const o2 = sampleOff + i * 16;
      t += i === seg.firstSample ? 0 : dv.getUint16(o2 + 2);
      qf[i] = t - header.startQf;
      yaw[i] = dv.getInt16(o2);
      pos[i * 3] = be24s(o2 + 4) / 8;
      pos[i * 3 + 1] = be24s(o2 + 7) / 8;
      pos[i * 3 + 2] = be24s(o2 + 10) / 8;
      const a = be24u(o2 + 13);
      anim[i] = a >>> 15;
      phase[i] = version >= 4 ? Math.round(((a >>> 7) & 0xff) * 4095 / 255) : (a >>> 3) & 0xfff;
      yoshi[i] = version >= 4 ? (a >>> 4) & 7 : 0;
      held[i] = version >= 4 ? a & 15 : 0;
      segIndex[i] = s;
    }
    segments.push(seg);
  }

  // V5+ append an SGTI section: controller inputs (V5: 16-byte records) and, from V6
  // (section version 2), an 8-byte FLUDD observation after each input (24-byte records).
  // Held-actor identities (V4+): retail actor type and the actor's name hash, which scene.bin
  // also stores, so a held spring or fruit maps to the exact placed object.
  const attachments = [];
  if (version >= 4) {
    for (let k = 0; k < Math.min(bytes[0xd0], 7); k++) {
      const o = 0xd6 + k * 6;
      attachments.push({ objectId: dv.getUint32(o), nameKey: dv.getUint16(o + 4) });
    }
  }

  let inputs = null;
  if (version >= 5) {
    const off = sampleOff + sampleSize;
    if (off + 32 <= bytes.length && text(off, 4) === 'SGTI') {
      const sectionVersion = dv.getUint16(off + 4);
      const headerSize = dv.getUint16(off + 6) || 32;
      // V7 (section version 3): the same 24-byte records (FLUDD mode bit 0x20: an accepted R+A
      // burst), followed by the split endpoint timestamps (header +12: count, 12 bytes each).
      const stride = sectionVersion >= 2 ? 24 : 16;
      let count = dv.getUint32(off + 8);
      const maxCount = Math.floor((bytes.length - off - headerSize) / stride);
      if (count > maxCount) { warnings.push('Input data is shorter than its header says; showing what is there.'); count = maxCount; }
      inputs = {
        count, hasFludd: stride === 24,
        qf: new Float64Array(count), buttons: new Uint16Array(count), stick: new Int8Array(count * 2),
        cstick: new Int8Array(count * 2), trig: new Uint8Array(count * 2),
        fluddMode: new Uint8Array(count), fluddOffset: new Float32Array(count * 3),
        fluddYaw: new Float32Array(count), fluddPitch: new Float32Array(count), fluddPower: new Uint8Array(count),
      };
      if (version >= 7) {
        Object.assign(inputs, { yoshiAnim: new Uint8Array(count), yoshiFrame: new Float32Array(count), yoshiBlend: new Uint8Array(count),
          yoshiPrev: new Int16Array(count).fill(-1), yoshiPrevFrame: new Float32Array(count) });
      }
      for (let i = 0; i < count; i++) {
        const r = off + headerSize + i * stride;
        inputs.qf[i] = dv.getUint32(r) - header.startQf;
        inputs.buttons[i] = dv.getUint16(r + 4);
        inputs.stick[i * 2] = dv.getInt8(r + 6);
        inputs.stick[i * 2 + 1] = dv.getInt8(r + 7);
        // Record layout (Moonshine scripts/test_ghost_teaching.py): >I qf, H buttons, b stick x/y,
        // b C-stick x/y, B trigger L/R, B analog A/B, b error, B flags.
        inputs.cstick[i * 2] = dv.getInt8(r + 8);
        inputs.cstick[i * 2 + 1] = dv.getInt8(r + 9);
        inputs.trig[i * 2] = bytes[r + 10];
        inputs.trig[i * 2 + 1] = bytes[r + 11];
        if (stride === 24 && version >= 7 && (bytes[r + 16] & 0x80)) {   // riding Yoshi: his pose
          const f = r + 16;
          inputs.fluddMode[i] = bytes[f];
          inputs.yoshiAnim[i] = bytes[f + 1];
          inputs.yoshiFrame[i] = dv.getUint16(f + 2) / 16;
          inputs.yoshiBlend[i] = bytes[f + 4];
          // The animation it blends from: the last different one before this record.
          if (i && (inputs.fluddMode[i - 1] & 0x80)) {
            const same = inputs.yoshiAnim[i - 1] === bytes[f + 1];
            inputs.yoshiPrev[i] = same ? inputs.yoshiPrev[i - 1] : inputs.yoshiAnim[i - 1];
            inputs.yoshiPrevFrame[i] = same ? inputs.yoshiPrevFrame[i - 1] : inputs.yoshiFrame[i - 1];
          }
        } else if (stride === 24) {
          const f = r + 16;
          inputs.fluddMode[i] = bytes[f];
          inputs.fluddOffset[i * 3] = dv.getInt8(f + 1) * 2;
          inputs.fluddOffset[i * 3 + 1] = dv.getInt8(f + 2) * 2;
          inputs.fluddOffset[i * 3 + 2] = dv.getInt8(f + 3) * 2;
          // 12-bit unsigned yaw and 12-bit signed pitch, 4096 steps per turn.
          const yaw12 = (bytes[f + 4] << 4) | (bytes[f + 5] >> 4);
          let pitch12 = ((bytes[f + 5] & 15) << 8) | bytes[f + 6];
          if (pitch12 & 2048) pitch12 -= 4096;
          inputs.fluddYaw[i] = (yaw12 / 4096) * Math.PI * 2;
          inputs.fluddPitch[i] = (pitch12 / 4096) * Math.PI * 2;
          inputs.fluddPower[i] = bytes[f + 7];
        }
      }
    }
  }

  // Split endpoints (V5+, after the input records; header +12 is their count): >I qf, I split
  // set key, H route id, B index, B pad. Older ghosts: none recorded.
  const splits = [];
  if (inputs) {
    const off = sampleOff + sampleSize, hs = dv.getUint16(off + 6) || 32, nSplit = dv.getUint32(off + 12);
    let o = off + hs + inputs.count * (inputs.hasFludd ? 24 : 16);
    for (let k = 0; k < nSplit && o + 12 <= bytes.length; k++, o += 12) {
      splits.push({ qf: dv.getUint32(o) - header.startQf, key: dv.getUint32(o + 4), route: dv.getUint16(o + 8), index: bytes[o + 10] });
    }
  }

  // V8: the camera the run was seen through (an SGCA chunk after the inputs and splits; Moonshine
  // doc/timewarp-ghost-camera-v8.md), the game's rendered view: a key at least 15 QF after the
  // last, sooner at a cut. Each 24 bytes: >I absolute QF; three signed 24-bit positions in
  // quarter units; the view matrix's rotation as a quaternion, x y z w as s16 / 32767; >H the
  // vertical FOV in 1/256 degree; the pose segment in bits 0-5 and a cut in bit 6.
  let camera = null;
  if (version >= 8 && inputs) {
    const off = sampleOff + sampleSize, hs = dv.getUint16(off + 6) || 32;
    const co = off + hs + dv.getUint32(off + 8) * 24 + dv.getUint32(off + 12) * 12;
    if (co + 32 <= bytes.length && dv.getUint32(co) === 0x53474341) {
      let n = dv.getUint32(co + 8);
      const max = Math.floor((bytes.length - co - 32) / 24);
      if (n > max) { warnings.push('Camera data is shorter than its header says; showing what is there.'); n = max; }
      camera = { count: n, truncated: !!(dv.getUint32(co + 12) & 1), qf: new Float64Array(n), pos: new Float32Array(n * 3),
        quat: new Float32Array(n * 4), fov: new Float32Array(n), tag: new Uint8Array(n) };
      for (let i = 0; i < n; i++) {
        const r = co + 32 + i * 24;
        camera.qf[i] = dv.getUint32(r) - header.startQf;
        for (let k = 0; k < 3; k++) camera.pos[i * 3 + k] = be24s(r + 4 + k * 3) / 4;
        let l = 0;
        for (let k = 0; k < 4; k++) { const v = dv.getInt16(r + 13 + k * 2) / 32767; camera.quat[i * 4 + k] = v; l += v * v; }
        l = Math.sqrt(l) || 1;
        for (let k = 0; k < 4; k++) camera.quat[i * 4 + k] /= l;
        camera.fov[i] = dv.getUint16(r + 21) / 256;
        camera.tag[i] = bytes[r + 23];
      }
    } else warnings.push('The camera data this ghost should have is missing; it plays with the viewer\'s own follow camera.');
  }

  // RNG tape (SGRN, Moonshine branch moonshine-rng, doc/ghost-rng-tape.md): every rand() call the
  // game made while the run recorded. It follows SGTI (and SGCA when present).
  let rng = null;
  if (inputs) {
    const off = sampleOff + sampleSize, hs = dv.getUint16(off + 6) || 32;
    let ro = off + hs + dv.getUint32(off + 8) * (inputs.hasFludd ? 24 : 16) + dv.getUint32(off + 12) * 12;
    if (ro + 32 <= bytes.length && dv.getUint32(ro) === 0x53474341) ro += 32 + dv.getUint32(ro + 8) * 24;
    if (ro + 32 <= bytes.length && dv.getUint32(ro) === 0x5347524e) {
      try { rng = parseRngTape(bytes, dv, ro, header.startQf); }
      catch (e) { warnings.push(`RNG tape unreadable (${e.message}); playing without it.`); }
    } else if (dv.getUint32(0x18) & 0x00010000) {
      warnings.push('This ghost should carry an RNG tape but it is missing.');
    }
  }

  return { header, segments, qf, pos, yaw, anim, phase, yoshi, held, attachments, segIndex, inputs, splits, camera, rng, warnings };
}

// SGRN: header (32 bytes), callers (4 each: return address in the source region's main.dol),
// actors (8 each: vtable, scene-name hash, reserved), then a byte stream. Values are not stored:
// MSL rand() is next = next * 1103515245 + 12345, value = (next >> 16) & 0x7fff, so each call's
// roll is regenerated from the stream's SEEDs. Times are QF from the ghost's start (NaN where the
// tape never learned the QF); frame 0 is the frame recording began in.
function parseRngTape(bytes, dv, at, startQf) {
  const nCallers = dv.getUint16(at + 8), nActors = dv.getUint16(at + 10);
  const streamSize = dv.getUint32(at + 12), flags = dv.getUint32(at + 16), callCount = dv.getUint32(at + 24);
  const size = 32 + nCallers * 4 + nActors * 8 + streamSize;
  if (dv.getUint16(at + 4) !== 1 || dv.getUint16(at + 6) !== 32) throw new Error('unknown tape version');
  if (at + size > bytes.length) throw new Error('tape runs past the end of the file');
  const body = bytes.subarray(at + 32, at + size);
  if (ghostCrc32(body) !== dv.getUint32(at + 20)) throw new Error('checksum mismatch');
  const callers = [], actors = [], seen = new Map();
  for (let i = 0; i < nCallers; i++) callers.push(dv.getUint32(at + 32 + i * 4));
  for (let i = 0; i < nActors; i++) {
    const o = at + 32 + nCallers * 4 + i * 8, vtable = dv.getUint32(o), keyCode = dv.getUint16(o + 4);
    const k = vtable + ':' + keyCode, ordinal = seen.get(k) || 0;
    seen.set(k, ordinal + 1);
    actors.push({ vtable, keyCode, ordinal });
  }
  const tape = {
    flags, truncated: !!(flags & 1), lost: !!(flags & 2), foreignThread: !!(flags & 4), controls: !!(flags & 8),
    noActors: !!(flags & 16), callers, actors, count: callCount, frames: 0, nodeOverrides: [],
    frame: new Uint32Array(callCount), qf: new Float64Array(callCount), segment: new Uint8Array(callCount),
    caller: new Uint8Array(callCount), actor: new Int16Array(callCount),
    value: new Uint16Array(callCount), used: new Uint16Array(callCount),
  };
  let o = at + size - streamSize, n = 0, frame = 0, segment = 0, state = 0, step = 0;
  let cur = null, prev = null;
  const rel = (q) => (q === null ? NaN : q - startQf);
  while (o < at + size) {
    const op = bytes[o++];
    if (op <= 0x7f) {
      const c = bytes[o], a = bytes[o + 1];
      o += 2;
      if (c >= nCallers || a > nActors || n + op + 1 > callCount) throw new Error('bad call run');
      for (let k = 0; k <= op; k++, n++) {
        state = (Math.imul(state, 0x41c64e6d) + 0x3039) >>> 0;
        tape.frame[n] = frame; tape.qf[n] = rel(cur); tape.segment[n] = segment;
        tape.caller[n] = c; tape.actor[n] = a - 1;
        tape.value[n] = tape.used[n] = (state >>> 16) & 0x7fff;
      }
    } else if (op <= 0xbf) {
      for (let k = 0; k < op - 0x7f; k++) { frame++; prev = cur; if (cur !== null) cur = (cur + step) >>> 0; }
    } else if (op === 0xc1) { state = dv.getUint32(o); o += 4; }
    else if (op === 0xc2) { const q = dv.getUint32(o); o += 4; if (prev !== null) step = (q - prev) >>> 0; cur = q; }
    else if (op === 0xc3) { segment = bytes[o++]; }
    else if (op === 0xc4) { if (n) tape.used[n - 1] = dv.getUint16(o); o += 2; }
    else if (op === 0xc5) {
      tape.nodeOverrides.push({ frame, qf: rel(cur), actor: bytes[o] - 1, node: dv.getInt16(o + 1) });
      o += 3;
    } else throw new Error(`unknown op 0x${op.toString(16)}`);
  }
  if (n !== callCount) throw new Error('call count mismatch');
  tape.frames = frame + 1;
  return tape;
}

// The rolls one object (actor table index), one call site (caller address) or both received, in
// order: [{ i, frame, qf, value, used }]. `used` differs from `value` where a Moonshine RNG control
// handed the game another number.
function ghostRngRolls(g, { actor = null, caller = null } = {}) {
  const t = g.rng, out = [];
  if (!t) return out;
  const ci = caller === null ? -1 : t.callers.indexOf(caller);
  if (caller !== null && ci < 0) return out;
  for (let i = 0; i < t.count; i++) {
    if (actor !== null && t.actor[i] !== actor) continue;
    if (ci >= 0 && t.caller[i] !== ci) continue;
    out.push({ i, frame: t.frame[i], qf: t.qf[i], value: t.value[i], used: t.used[i] });
  }
  return out;
}

// Interpolated pose at time t (QF from ghost start). Matches Moonshine's playback:
// linear position, shortest-path yaw, no interpolation across segment gaps.
function ghostSampleAt(g, t) {
  const { qf, pos, yaw } = g;
  const n = qf.length;
  if (t <= qf[0]) return { x: pos[0], y: pos[1], z: pos[2], yaw: yaw[0], i: 0, gap: false };
  if (t >= qf[n - 1]) { const k = n - 1; return { x: pos[k * 3], y: pos[k * 3 + 1], z: pos[k * 3 + 2], yaw: yaw[k], i: k, gap: false }; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (qf[mid] <= t) lo = mid; else hi = mid; }
  if (g.segIndex[lo] !== g.segIndex[hi]) {
    return { x: pos[lo * 3], y: pos[lo * 3 + 1], z: pos[lo * 3 + 2], yaw: yaw[lo], i: lo, gap: true };
  }
  const f = (t - qf[lo]) / (qf[hi] - qf[lo] || 1);
  const dy = (((yaw[hi] - yaw[lo]) + 32768) & 0xffff) - 32768;
  return {
    x: pos[lo * 3] + (pos[hi * 3] - pos[lo * 3]) * f,
    y: pos[lo * 3 + 1] + (pos[hi * 3 + 1] - pos[lo * 3 + 1]) * f,
    z: pos[lo * 3 + 2] + (pos[hi * 3 + 2] - pos[lo * 3 + 2]) * f,
    yaw: yaw[lo] + dy * f, i: lo, gap: false,
  };
}

// Animation at time t, following Moonshine's playback: equal IDs interpolate phase along the
// shortest path around the loop; an ID change steps at the sample boundary.
function ghostAnimAt(g, t) {
  const { qf, anim, phase, yoshi } = g;
  const n = qf.length;
  let lo = 0;
  if (t >= qf[n - 1]) lo = n - 1;
  else if (t > qf[0]) {
    let hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (qf[mid] <= t) lo = mid; else hi = mid; }
  }
  const out = { id: anim[lo], yoshi: yoshi[lo], phase: phase[lo] };
  const hi = lo + 1;
  if (hi < n && anim[hi] === anim[lo] && yoshi[hi] === yoshi[lo] && g.segIndex[hi] === g.segIndex[lo]) {
    const f = (t - qf[lo]) / (qf[hi] - qf[lo] || 1);
    const d = ((((phase[hi] - phase[lo]) + 2048) % 4096) + 4096) % 4096 - 2048;
    out.phase = (((phase[lo] + d * f) % 4096) + 4096) % 4096;
  }
  return out;
}

const FLUDD_NOZZLES = ['Spray', 'Rocket', 'Underwater', 'Yoshi', 'Hover', 'Turbo'];

// FLUDD state at time t: the most recent recorded input at or before t (Moonshine holds the
// last sample rather than interpolating). Returns null for ghosts without FLUDD data.
function ghostFluddAt(g, t) {
  const inp = g.inputs;
  if (!inp || !inp.hasFludd || !inp.count || t < inp.qf[0]) return null;
  let lo = 0, hi = inp.count - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (inp.qf[mid] <= t) lo = mid; else hi = mid - 1; }
  const mode = inp.fluddMode[lo];
  if (mode & 0x80) return { present: false, yoshi: true };   // V7: that record holds Yoshi instead
  if (!(mode & 0x08)) return { present: false };
  return {
    present: true, nozzle: mode & 7, nozzleName: FLUDD_NOZZLES[mode & 7] || '?',
    spraying: !!(mode & 0x10), burst: !!(mode & 0x20), power: inp.fluddPower[lo],
    offset: [inp.fluddOffset[lo * 3], inp.fluddOffset[lo * 3 + 1], inp.fluddOffset[lo * 3 + 2]],
    yaw: inp.fluddYaw[lo], pitch: inp.fluddPitch[lo],
  };
}

// V7, riding Yoshi: the FLUDD observation slot holds Yoshi's own pose (mode bit 0x80; 0x10 while
// he spits juice): byte 1 his BCK index (yoshi.szs, alphabetical), bytes 2-3 the frame x 16,
// byte 4 the walk blend weight (0-255), bytes 5-6 his upper body (not used yet).
function ghostYoshiAt(g, t) {
  const inp = g.inputs;
  if (!inp || !inp.yoshiAnim || !inp.count || t < inp.qf[0]) return null;
  let lo = 0, hi = inp.count - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (inp.qf[mid] <= t) lo = mid; else hi = mid - 1; }
  if (!(inp.fluddMode[lo] & 0x80)) return null;
  return { anim: inp.yoshiAnim[lo], frame: inp.yoshiFrame[lo], blend: inp.yoshiBlend[lo] / 255, juice: !!(inp.fluddMode[lo] & 0x10),
    prevAnim: inp.yoshiPrev[lo], prevFrame: inp.yoshiPrevFrame[lo] };
}

// V8: the recorded camera at time t (QF from the ghost's start) in pose segment seg, the way
// Moonshine's Watch plays it (GhostCamera::evaluate): the last key at or before t (the segment's
// first, before that), its position and FOV carried linearly to the next key's and its rotation
// the shortest way round (normalized), unless the next key is a cut or in another segment; past the
// last key of a track that ran out of room, nothing. { pos, quat (the view matrix's rotation,
// x y z w), fov } or null.
function ghostCameraAt(g, t, seg) {
  const c = g.camera;
  if (!c || !c.count) return null;
  let lo = 0, hi = c.count;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (c.qf[mid] <= t) lo = mid + 1; else hi = mid; }
  let i = lo ? lo - 1 : 0;
  if ((c.tag[i] & 63) !== seg) {
    if (i + 1 >= c.count || (c.tag[i + 1] & 63) !== seg) return null;
    i++;
  }
  if (c.truncated && i + 1 === c.count && t > c.qf[i]) return null;
  const out = { pos: [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]], quat: [c.quat[i * 4], c.quat[i * 4 + 1], c.quat[i * 4 + 2], c.quat[i * 4 + 3]], fov: c.fov[i] };
  if (i + 1 === c.count || t <= c.qf[i] || c.tag[i + 1] !== seg) return out;
  const j = i + 1, f = (t - c.qf[i]) / (c.qf[j] - c.qf[i]);
  for (let k = 0; k < 3; k++) out.pos[k] += (c.pos[j * 3 + k] - out.pos[k]) * f;
  out.fov += (c.fov[j] - out.fov) * f;
  let dot = 0, l = 0;
  for (let k = 0; k < 4; k++) dot += out.quat[k] * c.quat[j * 4 + k];
  for (let k = 0; k < 4; k++) { out.quat[k] += ((dot < 0 ? -c.quat[j * 4 + k] : c.quat[j * 4 + k]) - out.quat[k]) * f; l += out.quat[k] * out.quat[k]; }
  l = Math.sqrt(l) || 1;
  for (let k = 0; k < 4; k++) out.quat[k] /= l;
  return out;
}

if (typeof module !== 'undefined') module.exports = { parseSmsGhost, ghostSampleAt, ghostFluddAt, ghostYoshiAt, ghostCameraAt, ghostAnimAt, ghostFormatTime, ghostRouteLabel, ghostQfToSeconds };
