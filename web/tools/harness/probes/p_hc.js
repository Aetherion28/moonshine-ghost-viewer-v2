{ const st = globalThis.__st, P = globalThis.__P; const W = st.world; const hc = W.hitCheck; const o = hc.checkActorsHit.bind(hc); const h = [0,0,0,0]; let n = 0;
  hc.checkActorsHit = () => { if (n++ < 2000) h[((st.qf % 4) + 4) % 4]++; return o(); }; process.on('exit', () => console.log('HC sim qf mod 4 at checks', h.join(' '), 'moveTick at qf', W.moveTickCount, st.qf)); }
