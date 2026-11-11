# unpacks Moonshine's V4 mod binary (mod_<region>.bin) into its segments: modunpack.py <mod.bin> <out prefix>
import sys, struct, zlib
b = open(sys.argv[1], 'rb').read()
magic, ver, game, base, codeSize, writes, arena, memSize = struct.unpack_from('>8I', b, 0)
print('magic %08x ver %d game %08x base %08x codeSize %x writes %d arena %x mem %x' % (magic, ver, game, base, codeSize, writes, arena, memSize))
print('header words 8..15:', ['%08x' % x for x in struct.unpack_from('>8I', b, 32)])
count = struct.unpack_from('>I', b, 32)[0]
body = b[64:]
def decode_quick(packed, expected):
    hdr = struct.unpack_from('>2I', packed, 0)
    BLOCK = hdr[1]
    cursor, result = 8, bytearray()
    while len(result) < expected:
        raw, size = struct.unpack_from('>2I', packed, cursor); cursor += 8
        plain, size = bool(size & 0x80000000), size & 0x7FFFFFFF
        payload = packed[cursor:cursor + size]; cursor += size
        if plain: result.extend(payload); continue
        block, at = bytearray(), 0
        def length(initial):
            nonlocal at
            c = initial
            if initial == 15:
                while True:
                    e = payload[at]; at += 1; c += e
                    if e != 255: break
            return c
        while at < size:
            token = payload[at]; at += 1
            lit = length(token >> 4)
            block.extend(payload[at:at + lit]); at += lit
            if at == size: break
            dist = int.from_bytes(payload[at:at + 2], 'little'); at += 2
            m = length(token & 15) + 4
            for _ in range(m): block.append(block[-dist])
        result.extend(block)
    return bytes(result)
for i in range(count):
    d = struct.unpack_from('>8I', body, i * 32)
    target, raw, mem, off, plen, kind, crc, z = d
    print('segment %d: target %08x raw %x mem %x offset %x payload %x kind %d crc %08x %x' % (i, target, raw, mem, off, plen, kind, crc, z))
    p = body[off:off + plen]
    print('   crc ok' if zlib.crc32(p) == crc else '   crc differs', p[:8].hex())
    try:
        data = p if kind in (0, 2) else decode_quick(p, raw)
        open('%s.seg%d.bin' % (sys.argv[2], i), 'wb').write(data)
        print('   wrote', len(data))
    except Exception as e:
        print('   failed', e)
