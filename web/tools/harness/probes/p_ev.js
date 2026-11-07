{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let done = 0;
  P.testPerform = (c) => { const r = o(c); if (!done && st.qf >= 100) { done = 1; const g = st.world.eventGroup; console.log('EVG', g ? g.watchers.map(w => (w.file||w.name) + ':' + (w.interp ? 'run' : 'none') + (w.err ? ' ERR ' + w.err : '')).join(', ') : 'none'); }
  if (st.qf >= 6488 && st.qf <= 6494) { const g = st.world.eventGroup; console.log('EVS', st.qf, g && g.watchers.map(w => { const it = w.interp; return it ? (it.pc ?? it.mPC ?? '?') : '-'; }).join(' ')); } return r; }; }
