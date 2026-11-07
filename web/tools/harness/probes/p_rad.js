{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); const m = st.world.search('モンテマン'); if (m && (st.qf === 6139 || st.qf === 2000)) { const f = st.world.search('ゴールフラッグ') || [...st.world.byName.values()].find(x => x.constructor && x.constructor.name === 'GoalFlag');
     console.log('RAD', st.qf, 'mm ar', m.attackRadius, 'ah', m.attackHeight, 'dr', m.damageRadius, 'dh', m.damageHeight, 'er', m.entryRadius, 'hf', (m.hitFilter>>>0).toString(16), '| flag', f && f.name, f && [f.pos.x, f.pos.y, f.pos.z].map(v=>v.toFixed(1)).join(','), f && ['ar', f.attackRadius, 'ah', f.attackHeight, 'dr', f.damageRadius, 'dh', f.damageHeight, 'er', f.entryRadius, 'hf', (f.hitFilter>>>0).toString(16)].join(' ')); }
    return r; }; }
