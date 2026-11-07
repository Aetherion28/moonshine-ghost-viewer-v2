{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = 0;
  P.testPerform = (c) => { if (!hooked) { const m = st.world.search('モンテマン'); const g = st.world.eventGroup; if (m && g) { hooked = 1;
      const mp = m.perform.bind(m); m.perform = (cue) => { if (st.qf === 2174 || st.qf === 2175) console.log('ORD', st.qf, 'monteman', cue); return mp(cue); };
      for (const w of g.watchers) { const wp = w.perform.bind(w); w.perform = (cue) => { if ((st.qf === 2174 || st.qf === 2175) && /montemanrace/.test(w.file)) console.log('ORD', st.qf, 'script', cue); return wp(cue); }; } } }
    return o(c); }; }
