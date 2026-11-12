{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const h = (v) => { const f = new Float32Array([v]); return new Uint32Array(f.buffer)[0].toString(16).padStart(8, '0'); };
  const T = new Set((process.env.LT || '').split(',').map(Number)); let b = null; const v3 = (v) => [v.x, v.y, v.z].map(h).join(' ');
  P.testPerform = (c) => { const r = o(c); if (T.has(st.qf)) { b = b || st.world.search('mirrorL'); console.log('SIM', st.qf, 'unk140', v3(b.unk140), 'unk14C', v3(b.unk14C), +b.unk140.x.toPrecision(6), +b.unk140.z.toPrecision(6)); } return r; }; }
