{ const st = globalThis.__st, P = globalThis.__P; const [a, b] = (process.env.GND || '0,0').split(',').map(Number);
  const o = P.testPerform.bind(P); P.testPerform = (c) => { if (st.qf >= a && st.qf <= b) { const g = P.mGroundPlane; let where = '?'; const W = st.world; const all = W.conductor.liveManagers.flatMap((m) => m.objs || []);
    for (const x of all) { if (x.name !== '砲台') continue; (x.unk1C0 || []).forEach((mc, i) => { if (mc.tris.includes(g)) where = 'barrel' + i; }); if (x.unk2B0 && x.unk2B0.tris.includes(g)) where = 'futa'; if ((x.unk258 || []).includes(g)) where = 'top'; }
    console.log('GND', st.qf, 'y', P.pos.y.toFixed(3), 'gnd', g && g.actor && g.actor.name, where, g && JSON.stringify([g.p1, g.p2, g.p3].map(v => v && v.map(z => +z.toFixed(2))))); } return o(c); }; }
