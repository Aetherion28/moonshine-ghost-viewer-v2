// NX NZ: the live actor nearest (x, z) at LA, then per tick place and speed
{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const A = +process.env.LA, B = +process.env.LB; let b = null;
  const F = new Float32Array(1), U = new Uint32Array(F.buffer); const h = (v) => { F[0] = v; return U[0].toString(16).padStart(8, '0'); };
  P.testPerform = (c) => { const r = o(c); if (st.qf >= A && st.qf <= B) { if (!b) { let bd = 1e9; const x = +process.env.NX, z = +process.env.NZ; for (const m of st.world.conductor.liveManagers) for (const a of (m.objs || [])) if (a && a.pos && (!process.env.NAME || a.name === process.env.NAME)) { const d = (a.pos.x - x) ** 2 + (a.pos.z - z) ** 2; if (d < bd) { bd = d; b = a; } } }
    if (b) console.log(st.qf, h(b.pos.x), h(b.pos.y), h(b.pos.z), 'v', h(b.vel.x), h(b.vel.y), h(b.vel.z)); } return r; }; }
