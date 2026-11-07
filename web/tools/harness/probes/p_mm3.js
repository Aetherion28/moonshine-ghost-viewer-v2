{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const q0 = globalThis.__q0; let lx = null;
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); const t = st.qf - q0;
    if (m && lx !== null && m.pos.x !== lx && t < 2400) { console.log('MOVE', t, m.pos.x.toFixed(2)); lx = 1e9; } if (m && lx === null) lx = m.pos.x;
    return r; }; }
