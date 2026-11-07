{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const q0 = globalThis.__q0;
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); const t = st.qf - q0;
    if (m && t >= 2280 && t <= 2700 && t % 20 === 0) console.log('MM', t, m.pos.x.toFixed(2), m.pos.y.toFixed(2), m.pos.z.toFixed(2), 'st', (m.mStatus>>>0).toString(16), 'em', m.mEMDoing, 'ri', m.mReplayIndex);
    return r; }; }
