{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = 0;
  P.testPerform = (c) => { if (!hooked && st.world.eventGroup) { hooked = 1; const w = st.world.eventGroup.watchers.find(w => /montemanrace/.test(w.file||'')); const it = w.interp; const d = Object.getPrototypeOf(it).dispatchBuiltin;
      it.dispatchBuiltin = function (s, n) { d.call(this, s, n); if (st.qf >= 2168 && st.qf <= 2176) { const top = this.proc.at(this.proc.size - 1); const T = st.world.talk; console.log('SC', st.qf, this.builtinName, '->', top && top.getDataInt(), 'talk124', T && T.unk124, 'flagNPC', (st.world.mario.mFlags & 8) ? 1 : 0); } }; }
    return o(c); }; }
