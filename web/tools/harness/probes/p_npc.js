{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P);
  P.testPerform = (c) => { const r = o(c); if (st.qf >= 1838 && st.qf <= 1843) { const W = st.world, M = W.mario;
    const all = [...W.byName.values()];
    const near = all.filter((x) => x.pos && Math.hypot(x.pos.x - M.pos.x, x.pos.z - M.pos.z) < 700);
    console.log('NPC', st.qf, 'in', (M.mInput>>>0).toString(16), 'btn', M.unk108 && (M.unk108.mFrameInput>>>0).toString(16), near.map(x => x.name + ' d' + Math.hypot(x.pos.x - M.pos.x, x.pos.z - M.pos.z).toFixed(0) + ' lf' + (x.liveFlag>>>0).toString(16) + (x.talkForbid !== undefined ? ' tf' + x.talkForbid : '') + (x.unk138 !== undefined && typeof x.unk138 === 'number' ? ' u138 ' + x.unk138 : '')).join(' | '));
  } return r; }; }
