import sys, struct, capstone
dol = open(sys.argv[1], 'rb').read(); addr = int(sys.argv[2], 16); n = int(sys.argv[3], 16)
offs = struct.unpack('>18I', dol[0:72]); addrs = struct.unpack('>18I', dol[72:144]); sizes = struct.unpack('>18I', dol[144:216])
for o, a, s in zip(offs, addrs, sizes):
    if a <= addr < a + s:
        code = dol[o + addr - a: o + addr - a + n]; break
md = capstone.Cs(capstone.CS_ARCH_PPC, capstone.CS_MODE_32 | capstone.CS_MODE_BIG_ENDIAN); md.skipdata = True
for i in md.disasm(code, addr): print('0x%x %s %s' % (i.address, i.mnemonic, i.op_str))
