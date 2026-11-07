{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); let hooked = 0; const seen = new Map();
  P.testPerform = (c) => { if (!hooked && st.world.eventGroup) { hooked = 1; const w = st.world.eventGroup.watchers.find(w => /montemanrace/.test(w.file||'')); const it = w.interp; const proto = Object.getPrototypeOf(it); const d = proto.dispatchBuiltin;
      it.dispatchBuiltin = function (s, n) { d.call(this, s, n); const nm = this.builtinName; const top = this.ctx && this.ctx.top ? '' : ''; const k = nm; if (st.qf > 6380 || !seen.has(k)) { seen.set(k, 1); console.log('BI', st.qf, nm); } }; }
    return o(c); }; }
