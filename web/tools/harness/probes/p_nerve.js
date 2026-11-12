// an actor's nerve, flags and spray state per tick: NAME [NTH] LA LB
{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const A = +process.env.LA, B = +process.env.LB; let b = null;
  const find = () => { const N = process.env.NAME, out = []; for (const m of st.world.conductor.liveManagers) for (const a of (m.objs || [])) if (a && (a.name === N || a.constructor.name === N)) out.push(a); return out[+(process.env.NTH || 0)] || null; };
  P.testPerform = (c) => { const r = o(c); if (st.qf >= A && st.qf <= B) { b = b || find(); if (b) { const s = b.spine; console.log('NRV', st.qf, s && s.current && s.current.name, s && s.time, 'stack', s && s.stack.map((n) => n.name).join(','), 'live', (b.liveFlag >>> 0).toString(16), 'hp', b.hitPoints); } } return r; }; }
