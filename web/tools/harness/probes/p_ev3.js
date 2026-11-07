{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = 0, last = '';
  P.testPerform = (c) => { if (!hooked && st.world.eventGroup) { hooked = 1; const w = st.world.eventGroup.watchers.find(w => /montemanrace/.test(w.file||'')); const it = w.interp; const d = Object.getPrototypeOf(it).dispatchBuiltin;
      it.dispatchBuiltin = function (s, n) { const sym = this.bin.getSymbol(s); let info = '';
        if (sym && sym.name === 'isNearActors' && st.qf > 6470) { const Pp = this.proc; const args = []; for (let i = 0; i < n; i++) { const sl = Pp.at(Pp.size - n + i); args.push(JSON.stringify(sl)); } info = args.join(' '); }
        d.call(this, s, n); if (info) { const top = this.proc.at(this.proc.size - 1); console.log('NA', st.qf, info, '->', top.getDataInt()); } }; }
    const r = o(c); return r; }; }
