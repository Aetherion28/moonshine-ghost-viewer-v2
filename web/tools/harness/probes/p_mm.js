{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); const W = st.world; const m = W.search('モンテマン'); const M = W.mario;
    if (m && (st.qf % 200 === 0 || (st.qf >= 25970 && st.qf <= 25982))) console.log('MM', st.qf, m.pos.x.toFixed(2), m.pos.y.toFixed(2), m.pos.z.toFixed(2), 'goal', m.isGoal && m.isGoal(), 'mario', M.pos.x.toFixed(1), M.pos.z.toFixed(1), 'd', Math.hypot(m.pos.x-M.pos.x, m.pos.y-M.pos.y, m.pos.z-M.pos.z).toFixed(1));
    return r; }; }
