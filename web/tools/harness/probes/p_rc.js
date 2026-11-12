// how many random numbers the sim has taken when Mario's perform of each tick begins (where the game's rk.mjs labels
// change): "RC <tick> <total>" (for rc.py)
{ const st = globalThis.__st, P = globalThis.__P, R = globalThis.__rngCtx; let n = 0, last = -1e9, hooked = null;
  const prev = R.roll; R.roll = (who) => { n++; return prev ? prev(who) : null; };
  const hook = () => { const M = st.world && st.world.mario; if (!M || hooked === M) return; hooked = M; const p = M.perform.bind(M); M.perform = (...a) => { const t = st.world.tickCount; if (t !== last) { last = t; console.log('RC', t, n); } return p(...a); }; };
  const o = P.testPerform.bind(P); P.testPerform = (c) => { hook(); return o(c); }; }
