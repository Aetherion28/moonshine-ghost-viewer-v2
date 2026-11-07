{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); if (st.qf >= 1570 && st.qf <= 1573) { const M = st.world.mario;
    const cols = (M.collisions || M.mCollisions || []).slice(0, M.colCount ?? M.mColCount ?? 99);
    console.log('COL', st.qf, 'n', M.colCount ?? M.mColCount, cols.map(a => a && (a.name + '@' + a.pos.x.toFixed(1) + ',' + a.pos.y.toFixed(1) + ',' + a.pos.z.toFixed(1) + ' r' + (a.damageRadius ?? '') + '/' + (a.attackRadius ?? ''))).join(' | '));
  } return r; }; }
