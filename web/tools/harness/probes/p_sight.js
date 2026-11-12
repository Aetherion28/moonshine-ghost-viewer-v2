{ const st = globalThis.__st, P = globalThis.__P; const o = P.testPerform.bind(P); const A = +process.env.LA, B = +process.env.LB; let b = null;
  P.testPerform = (c) => { if (st.qf >= A && st.qf <= B) { if (!b) for (const m of st.world.conductor.liveManagers) for (const a of (m.objs || [])) if (a && a.name === process.env.NAME) b = a;
    const cam = st.world.clipCamera; if (b && cam) { const M = b.manager; const far = M && M.farClip !== undefined ? M.farClip : 'cond'; const dx = b.pos.x - cam.pos[0], dy = b.pos.y - cam.pos[1], dz = b.pos.z - cam.pos[2]; const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      const fx = cam.at[0] - cam.pos[0], fz = cam.at[2] - cam.pos[2]; const yaw = Math.atan2(fx, fz) * 180 / Math.PI, to = Math.atan2(dx, dz) * 180 / Math.PI; let df = ((to - yaw) % 360 + 540) % 360 - 180;
      console.log('SI', st.qf, 'dist', d.toFixed(1), 'far', far, 'angdiff', df.toFixed(2), 'eye', cam.pos.map((v) => v.toFixed(0)).join(',')); } }
    return o(c); }; }
