// every sim actor against the trace's actor records, by key code and the nearest record (within 80): the first tick
// each one's position differs from its record in any bit (OFF: the record's label minus the sim's tick, default 1; MIN: from this tick, default 10)
{ const st = globalThis.__st, P = globalThis.__P, T = globalThis.__trace, q0 = globalThis.__q0; const o = P.testPerform.bind(P); const OFF = +(process.env.OFF ?? 1), LB = +(process.env.LB || 1e9);
  const A = T.actors, byQf = new Map(); for (let i = 0; i < A.count; i++) { const q = A.qf[i]; (byQf.get(q) || byQf.set(q, []).get(q)).push(i); }
  const F = new Float32Array(1), U = new Uint32Array(F.buffer), h = (v) => { F[0] = v; return U[0]; };
  const first = new Map(), seen = new Map();
  P.testPerform = (c) => { const r = o(c); const q = st.qf; if (q <= LB && q >= +(process.env.MIN || 10)) { const L = byQf.get(q0 + q + OFF); if (L) for (const m of st.world.conductor.liveManagers) for (const a of (m.objs || [])) { if (!a || !a.pos) continue; const key = (a.keyCode || globalThis.__calcKeyCode(a.name)) & 0xFFFF;
      let best = -1, bd = 80; for (const i of L) { if (A.key[i] !== key) continue; const e = Math.hypot(A.pos[i * 3] - a.pos.x, A.pos[i * 3 + 2] - a.pos.z); if (e < bd) { bd = e; best = i; } }
      if (best < 0) continue; seen.set(a, (seen.get(a) || 0) + 1);
      if (!first.has(a) && (h(A.pos[best * 3]) !== h(a.pos.x) || h(A.pos[best * 3 + 1]) !== h(a.pos.y) || h(A.pos[best * 3 + 2]) !== h(a.pos.z))) first.set(a, { q, id: A.id[best], sim: [a.pos.x, a.pos.y, a.pos.z], rec: [A.pos[best * 3], A.pos[best * 3 + 1], A.pos[best * 3 + 2]], d: bd }); } }
    if (q === LB) { const rows = [...first.entries()].sort((x, y) => x[1].q - y[1].q); console.log('ACTCMP matched', seen.size, 'differ', rows.length); for (const [a, f] of rows.slice(0, 25)) console.log('ACT', f.q, a.name, a.constructor.name, 'rec#' + f.id, 'sim', f.sim.map(v => v.toFixed(4)).join(','), 'rec', f.rec.map(v => v.toFixed(4)).join(','), 'd', f.d.toExponential(2), 'seen', seen.get(a)); }
    return r; }; }
