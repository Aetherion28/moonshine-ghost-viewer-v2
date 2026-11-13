#!/usr/bin/env python3
"""Builds Moonshine V4 .smsghost files from convert.ts's JSON, with Moonshine's own builder and validator
(susamune scripts/test_ghost_format.py build_ghost, scripts/validate_ghost.py).
    python3 mkghost.py <susamune>/scripts <dir with *.json>"""
import json, sys, zlib, hashlib
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import validate_ghost as vg
import test_ghost_format as tg

for path in sorted(Path(sys.argv[2]).glob('*.json')):
    g = json.loads(path.read_text())
    samples, segments = [], []
    for s in g['segments']:
        first = len(samples)
        for x, y, z, yaw, delta, anim, phase, yoshi, held, qf in s['samples']:
            samples.append((x, y, z, yaw, delta, anim, phase, yoshi, held))
        segments.append({
            'first_sample': first, 'sample_count': len(s['samples']),
            'start_qf': s['samples'][0][9], 'end_qf': s['samples'][-1][9],
            'route': {'area': s['area'], 'episode': s['episode'], 'parent_area': s['parent'], 'flags': s['flags'], 'variant': s['variant']},
        })
    r = segments[0]['route']
    gid = int.from_bytes(hashlib.sha256(('TASVideos 3731M ' + g['name']).encode()).digest()[:8], 'big') or 1
    raw = tg.build_ghost(
        ghost_id=gid, samples=samples, segments=segments,
        start_qf=segments[0]['start_qf'], end_qf=segments[-1]['end_qf'],
        name=g['name'], author='TASVideos 3731M', profile_name='TAS',
        route_area=r['area'], route_episode=r['episode'], route_parent_area=r['parent_area'],
        route_flags=r['flags'], route_variant=r['variant'], region=0, run_flags=0x21,
    )
    info = vg.validate_ghost(raw)
    out = path.with_suffix('.smsghost')
    out.write_bytes(raw)
    print(f"{out.name}: {info['sample_count']} samples, {len(segments)} segments, {info['duration_qf']} QF ({info['duration_qf'] / 120:.2f} s)")
