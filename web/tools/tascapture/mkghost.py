#!/usr/bin/env python3
"""Builds Moonshine .smsghost files (V9, SUSAMUNE_GHOST_FILE_VERSION) from convert.ts's JSON and checks each
with Moonshine's own validator (susamune scripts/validate_ghost.py).
    python3 mkghost.py <susamune>/scripts <dir with *.json>
Layout as Moonshine writes it: the 0x100 header with the V4 extension, the segment table (0x800), the pose
samples, the SGTI teaching section (version 3: 24-byte inputs, the PADStatus and the 8-byte visual
observation), the SGCA camera section (ghost_camera_track.cpp encode / capture). V9: segment 0's reserved
words are the rand seed at the first retained pose and its provenance (1)."""
import json, math, struct, sys, hashlib, time
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import validate_ghost as vg

f32 = lambda x: struct.unpack('>f', struct.pack('>f', x))[0]


def quat(m):
    """GhostCamera::readRendered: the view matrix's rotation as a quaternion (x, y, z, w), in f32."""
    tr = f32(f32(m[0][0] + m[1][1]) + m[2][2])
    q = [0.0] * 4
    if tr > 0:
        s = f32(f32(math.sqrt(f32(tr + 1))) * 2)
        q[3] = f32(s * 0.25)
        q[0] = f32(f32(m[2][1] - m[1][2]) / s)
        q[1] = f32(f32(m[0][2] - m[2][0]) / s)
        q[2] = f32(f32(m[1][0] - m[0][1]) / s)
    else:
        i = 1 if m[1][1] > m[0][0] else 0
        if m[2][2] > m[i][i]:
            i = 2
        j = (i + 1) % 3
        k = (j + 1) % 3
        s = f32(f32(math.sqrt(f32(f32(f32(1 + m[i][i]) - m[j][j]) - m[k][k]))) * 2)
        q[i] = f32(s * 0.25)
        q[j] = f32(f32(m[i][j] + m[j][i]) / s)
        q[k] = f32(f32(m[i][k] + m[k][i]) / s)
        q[3] = f32(f32(m[k][j] - m[j][k]) / s)
    return q


def rnd(n):
    return int(n + (-0.5 if n < 0 else 0.5))


def encode(qf, pos, q, fovy, flags):
    """GhostCamera::encode; None where Moonshine would refuse the view."""
    if not (1 <= fovy <= 179) or any(not math.isfinite(v) for v in (*pos, *q)):
        return None
    norm = sum(f32(v * v) for v in q)
    if not (0.9 < norm < 1.1) or any(not (-2097151 <= v <= 2097151) for v in pos):
        return None
    b = bytearray(24)
    struct.pack_into('>I', b, 0, qf)
    for i, v in enumerate(pos):
        b[4 + 3 * i:7 + 3 * i] = (rnd(f32(v * 4)) & 0xFFFFFF).to_bytes(3, 'big')
    scale = f32(32767.0 / f32(math.sqrt(norm)))
    for i, v in enumerate(q):
        struct.pack_into('>h', b, 13 + 2 * i, rnd(f32(v * scale)))
    struct.pack_into('>H', b, 21, int(f32(fovy * 256) + 0.5))
    b[23] = flags
    return bytes(b), (pos, q, fovy)


def decode(b):
    pos = [((int.from_bytes(b[4 + 3 * i:7 + 3 * i], 'big') ^ 0x800000) - 0x800000) * 0.25 for i in range(3)]
    q = [struct.unpack_from('>h', b, 13 + 2 * i)[0] / 32767.0 for i in range(4)]
    n = math.sqrt(sum(v * v for v in q))
    return pos, [v / n for v in q], struct.unpack_from('>H', b, 21)[0] / 256.0


def camera_keys(views, segments):
    """GhostCamera::capture at each input: a key every 15 QF, or a cut (new segment, a jump over 500 units, a turn
    past 90 degrees, the field of view changed more than 15 degrees)."""
    keys = []
    for qf, seg, *v in views:
        pos, m, fovy = v[0:3], [v[3:7], v[7:11], v[11:15]], v[15]
        if seg >= len(segments) or not (segments[seg]['start_qf'] <= qf <= segments[seg]['end_qf']):
            continue
        q = quat(m)
        cut = not keys
        if keys:
            last = keys[-1]
            previous = struct.unpack_from('>I', last)[0]
            if qf <= previous:
                continue
            cut = (last[23] & 63) != seg
            opos, oq, ofov = decode(last)
            distance = sum((pos[i] - opos[i]) ** 2 for i in range(3))
            dot = sum(q[i] * oq[i] for i in range(4))
            cut = cut or distance > 250000 or abs(dot) < 0.7071 or abs(fovy - ofov) > 15
            if not cut and qf - previous < 15:
                continue
        e = encode(qf, pos, q, fovy, seg | (0x40 if cut else 0))
        if e and len(keys) < 5312:
            keys.append(e[0])
    return keys


def build(g):
    samples, segments = [], []
    for s in g['segments']:
        first = len(samples)
        samples += [x[:9] for x in s['samples']]
        segments.append({'first_sample': first, 'sample_count': len(s['samples']),
                         'start_qf': s['samples'][0][9], 'end_qf': s['samples'][-1][9],
                         'route': (s['area'], s['episode'], s['parent'], s['flags'], s['variant'])})
    start_qf, end_qf = segments[0]['start_qf'], segments[-1]['end_qf']
    table = bytearray(vg.V4_SEGMENT_TABLE_SIZE)
    for k, s in enumerate(segments):
        a, e, p, fl, var = s['route']
        r0, r1 = (g['seed'], 1) if k == 0 else (0, 0)
        vg._SEGMENT.pack_into(table, k * vg.V4_SEGMENT_SIZE, s['first_sample'], s['sample_count'], s['start_qf'], s['end_qf'],
                              var, a, e, p, fl, r0, r1)
    pose = b''.join(vg.pack_pose_sample_v4(x, y, z, yaw, d, anim, (phase * vg.V4_ANIMATION_PHASE_MAX + vg.ANIMATION_PHASE_MAX // 2) // vg.ANIMATION_PHASE_MAX, yo, held)
                    for x, y, z, yaw, d, anim, phase, yo, held in samples)
    # SGTI v3: qf, the PracticeInput (buttons ... error, flags 0), the visual observation (capture3's VISL; else zero)
    inputs = b''
    previous = None
    for qf, pad, *vis in g['inputs']:
        if not (start_qf <= qf <= end_qf) or (previous is not None and qf <= previous):
            continue
        p = bytearray(bytes.fromhex(pad))
        struct.pack_into('>H', p, 0, struct.unpack_from('>H', p, 0)[0] & 0x1F7F)
        p[11] = 0
        v = bytes.fromhex(vis[0]) if vis and vis[0] else bytes(8)
        inputs += struct.pack('>I', qf) + bytes(p) + v
        previous = qf
    n_inputs = len(inputs) // 24
    teaching = struct.pack('>IHHIIIIII', 0x53475449, 3, 32, n_inputs, 0, 0, vg._crc32(inputs), 0, 0) + inputs
    keys = b''.join(camera_keys(g['camera'], segments))
    camera = struct.pack('>IHHIIIIII', 0x53474341, 1, 32, len(keys) // 24, 0, vg._crc32(keys), 0, 0, 0) + keys
    payload = bytes(table) + pose + teaching + camera

    header = bytearray(vg.GHOST_HEADER_SIZE)
    author, name, profile = b'TASVideos 3731M', g['name'].encode('ascii'), b'TAS'
    header[96:96 + len(author)] = author
    header[120:120 + len(name)] = name
    header[168:168 + len(profile)] = profile
    vg._V4_EXTENSION.pack_into(header, 184, len(segments), vg.V4_SEGMENT_SIZE, vg.V4_SEGMENT_TABLE_OFFSET, vg.V4_SEGMENT_TABLE_SIZE,
                               vg.V4_SAMPLE_DATA_OFFSET, len(pose), vg._crc32(bytes(table)), 0, vg.V4_ATTACHMENT_DESCRIPTOR_SIZE, 0, 0, *([0] * 14))
    a, e, p, fl, var = segments[0]['route']
    gid = int.from_bytes(hashlib.sha256(b'TASVideos 3731M ' + name).digest()[:8], 'big') or 1
    vg._GHOST_PREFIX.pack_into(header, 0, vg.GHOST_MAGIC, vg.GHOST_VERSION_V9, vg.GHOST_HEADER_SIZE, vg.GHOST_HEADER_SIZE + len(payload),
                               0, 0, vg._crc32(payload), 63, 0x21, vg.REGION_GAME_IDS[0], 0, 0, 0, vg.RECORDING_POSE_QF,
                               vg.CODEC_POSE_ATTACHMENTS, vg.SAMPLE_SIZE, vg.SAMPLE_INTERVAL_QF, a, e, p, fl, var,
                               g.get('resultQf', end_qf), start_qf, end_qf, end_qf - start_qf, len(samples), len(payload), 0, int(time.time()),
                               gid >> 32, gid & 0xFFFFFFFF, len(author), len(name), len(profile), vg.CHECKSUM_CRC32)
    struct.pack_into('>I', header, 16, vg._crc32_zeroed(bytes(header), (12, 20)))
    raw = bytearray(header + payload)
    struct.pack_into('>I', raw, 12, vg._crc32_zeroed(bytes(raw), (12, 16)))
    return bytes(raw), n_inputs, len(keys) // 24


for path in sorted(Path(sys.argv[2]).glob('*.json')):
    g = json.loads(path.read_text())
    raw, n_inputs, n_cam = build(g)
    info = vg.validate_ghost(raw)
    out = path.with_suffix('.smsghost')
    out.write_bytes(raw)
    print(f"{out.name}: v{info.get('version', 9)}, {info['sample_count']} samples, {n_inputs} inputs, {n_cam} camera keys, {info['duration_qf'] / 120:.2f} s")
