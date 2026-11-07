{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); if (st.qf >= 1610 && st.qf <= 1614) { const M = st.world.mario; const h = M.mHeldObject;
    console.log('PULL', st.qf, 'st', M.mStatus.toString(16), 'held', h && h.name, h && h.constructor.name, 'type', h && (h.actorType>>>0).toString(16), 'tmtx', h && h.getTakingMtx ? JSON.stringify(h.getTakingMtx() && Array.from(h.getTakingMtx()).slice(0,12).map(v=>+v.toFixed(3))) : 'none', 'mr', h && typeof h.moveRequest);
  } return r; }; }
