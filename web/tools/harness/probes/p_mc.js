{ const st = globalThis.__st, P = globalThis.__P; const o = P.perform.bind(P); const h = [0,0,0,0];
  P.perform = (c) => { if (P.collisions && P.collisions.length) h[((st.qf % 4) + 4) % 4]++; return o(c); }; process.on('exit', () => console.log('MC sim Mario collisions>0 by qf mod 4', h.join(' '))); }
