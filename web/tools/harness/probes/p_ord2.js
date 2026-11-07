{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = 0, seq = [];
  P.testPerform = (c) => { if (!hooked) { const m = st.world.search('モンテマン'); const M = st.world.mario; if (m && M) { hooked = 1;
      const mp = m.perform.bind(m); m.perform = (cue) => { if (st.qf === 2100) seq.push('monteman'); return mp(cue); };
      const Mp = M.perform.bind(M); M.perform = (cue) => { if (st.qf === 2100) seq.push('mario'); return Mp(cue); }; } }
    const r = o(c); if (st.qf === 2100) console.log('ORDER', seq.join(' > ')); return r; }; }
