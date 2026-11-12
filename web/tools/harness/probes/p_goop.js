// the sim's goop layers' maps at ticks LA..LB every LE, in the oracle's `goop` format
{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const A = +process.env.LA, B = +(process.env.LB || process.env.LA), E = +(process.env.LE || 1);
  P.testPerform = (c) => { const r = o(c); if (st.qf >= A && st.qf <= B && (st.qf - A) % E === 0) { const pol = st.world.pollution; pol.layers.forEach((L, k) => console.log(`GOOP ${st.qf} ${k} sim ${L.constructor.name}/${L.name} 0 0 ${L.threshold} ${Buffer.from(L.map).toString('base64')}`)); } return r; }; }
