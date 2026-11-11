# disassembles a segment modunpack.py wrote: moddis.py <segment.bin> <hex base address> <hex address> <hex length>
# (segment 0 of the JP mod is linked at 0x80426020, segment 1 at 0x804A6020: see the "target" modunpack.py prints, added to the base)
import sys
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
b = open(sys.argv[1], 'rb').read()
base, a, n = int(sys.argv[2], 16), int(sys.argv[3], 16), int(sys.argv[4], 16)
md = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN); md.skipdata = True
for i in md.disasm(b[a - base: a - base + n], a):
    print(hex(i.address), i.mnemonic, i.op_str)
