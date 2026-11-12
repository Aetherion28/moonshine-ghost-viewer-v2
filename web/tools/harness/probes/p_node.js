// a model stamp's draw matrices (rows, hex) at tick 256, to compare with the game's J3DModel node matrices
{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = false;
  const F = new Float32Array(1), U = new Uint32Array(F.buffer), hx = (v) => { F[0] = v; return U[0].toString(16).padStart(8, '0'); };
  P.testPerform = (c) => { const pol = st.world.pollution; if (pol && !hooked) { hooked = true; const d = pol.draw.bind(pol); pol.draw = () => { if (st.qf === 256) pol.layers.forEach((L) => { L.modelTasks.forEach((t, n) => { console.log('TASK', n); for (let j = 0; j < 13; j++) console.log('N', n, j, t.rows[j].map(hx).join(' ')); }); }); return d(); }; } return o(c); }; }
