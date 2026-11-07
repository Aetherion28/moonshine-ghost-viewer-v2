{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); if (st.qf === 1434) { const W = st.world;
    const k = W.conductor.liveManagers.flatMap((m) => m.objs || []).filter((x) => x.name === '砲台').sort((a,b)=>Math.hypot(a.pos.x-12392,a.pos.z-3590)-Math.hypot(b.pos.x-12392,b.pos.z-3590))[0];
    const d = k.unk1AC[2], h0 = W.col.checkGround(12045.69, 800, 3709.79, 1)[0];
    const M = d.getConnectedMtx(); console.log('J', Array.from(M).map(v=>v.toFixed(3)).join(' '));
    for (const a of [0, -1.692, -3, -5]) { const save = d.unk28; d.unk28 = a; const MtxM = k.getAnmMtx(d.joint); }
    console.log('h now', h0.toFixed(3), 'game 746.199');
  } return r; }; }
