{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let done = false;
  P.testPerform = (c) => { if (!done) { const g = st.world.groups; for (const L of g) for (const a of (L || [])) if (a && /尻尾/.test(a.name) && !a.__w) { a.__w = 1; const f = a.receiveMessage.bind(a); a.receiveMessage = (s, m) => { const r = f(s, m); if (st.qf >= +process.env.LA && st.qf <= +process.env.LB) console.log('TMSG', st.qf, s && s.name, m, r, a.pos.x.toFixed(1)); return r; }; } done = true; }
    return o(c); }; }
