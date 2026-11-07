{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); if (st.qf >= 1428 && st.qf <= 1436) { const W = st.world;
    const all = [...W.conductor.liveManagers.flatMap((m) => m.objs || [])]; const cs = all.filter((x) => x.name === '砲台').sort((a,b)=>Math.hypot(a.pos.x-12392,a.pos.z-3590)-Math.hypot(b.pos.x-12392,b.pos.z-3590));
    const k = cs[0]; if (!k) return r;
    const g = W.col.checkGround(12045.69, 800, 3709.79, 1); const t = g[1];
    let which = '?'; const cols = [...k.unk1C0.map((c,i)=>['dom'+i,c]), ['futa', k.unk2B0]];
    for (const [n, c] of cols) { const keys = Object.keys(c); for (const kk of keys) { const v = c[kk]; if (Array.isArray(v) && v.includes(t)) which = n + '.' + kk; } }
    if (st.qf === 1428) console.log('MCKEYS', Object.keys(k.unk2B0).join(','));
    console.log('CAN', st.qf, 'pos', k.pos.x.toFixed(2), k.pos.y.toFixed(2), k.pos.z.toFixed(2), 'rot', k.rot.x.toFixed(3), k.rot.y.toFixed(3), 'nerve', k.spine.current && k.spine.current.name, 'doms', k.unk1AC.map(d=>[d.unk24,d.unk28.toFixed(3),d.unk2C.toFixed(3),d.unk30.toFixed(1)].join('/')).join(' '), 'u214', k.unk214, 'dm2', Math.sqrt(k.distToMarioSq).toFixed(1), 'bomb', k.unk28C.mSLBombDist, '| gnd', g[0].toFixed(3), which, t && t.n ? t.n.map(v=>v.toFixed(3)).join(',') : '');
  } return r; }; }
