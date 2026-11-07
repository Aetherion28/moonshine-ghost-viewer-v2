{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); const t = st.qf;
    if (m && ((t >= 2174 && t <= 2200) || t % 160 === 4)) console.log('MM', t, m.pos.x.toFixed(3), m.pos.y.toFixed(3), m.pos.z.toFixed(3), 'st', (m.mEnemyMario?m.mEnemyMario.mStatus:0).toString(16));
    return r; }; }
