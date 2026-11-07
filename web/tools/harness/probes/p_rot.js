{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); if (m && st.qf >= 2150 && st.qf <= 2181) console.log('ROT', st.qf, m.rot.y.toFixed(4), m.mEnemyMario ? m.mEnemyMario.mFaceAngle.y : ''); return r; }; }
