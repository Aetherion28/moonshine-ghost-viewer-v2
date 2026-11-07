{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); if (m && st.qf >= 2170 && st.qf <= 6500) console.log('MM', st.qf, m.pos.x.toFixed(4), m.pos.y.toFixed(4), m.pos.z.toFixed(4), (m.mEnemyMario.mStatus>>>0).toString(16)); return r; }; }
