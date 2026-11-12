import sys, struct, capstone
dol = open(sys.argv[1], 'rb').read(); addr = int(sys.argv[2], 16); n = int(sys.argv[3], 16)
offs = struct.unpack('>18I', dol[0:72]); addrs = struct.unpack('>18I', dol[72:144]); sizes = struct.unpack('>18I', dol[144:216])
for o, a, s in zip(offs, addrs, sizes):
    if a <= addr < a + s:
        code = dol[o + addr - a: o + addr - a + n]; break
md = capstone.Cs(capstone.CS_ARCH_PPC, capstone.CS_MODE_32 | capstone.CS_MODE_BIG_ENDIAN)
# the Gekko's paired singles (capstone doesn't know them)
A5 = {18: 'ps_div', 20: 'ps_sub', 21: 'ps_add', 23: 'ps_sel', 24: 'ps_res', 25: 'ps_mul', 26: 'ps_rsqrte', 28: 'ps_msub', 29: 'ps_madd', 30: 'ps_nmsub', 31: 'ps_nmadd', 10: 'ps_sum0', 11: 'ps_sum1', 12: 'ps_muls0', 13: 'ps_muls1', 14: 'ps_madds0', 15: 'ps_madds1'}
X10 = {40: 'ps_neg', 72: 'ps_mr', 136: 'ps_nabs', 264: 'ps_abs', 528: 'ps_merge00', 560: 'ps_merge01', 592: 'ps_merge10', 624: 'ps_merge11', 0: 'ps_cmpu0', 32: 'ps_cmpo0', 64: 'ps_cmpu1', 96: 'ps_cmpo1'}
def ps(w):
    op = w >> 26; d = (w >> 21) & 31; a = (w >> 16) & 31; b = (w >> 11) & 31; c = (w >> 6) & 31
    if op in (56, 57, 60, 61):
        dd = w & 0xFFF; dd -= 0x1000 if dd & 0x800 else 0
        return '%s f%d, %s(r%d), %d, qr%d' % ({56: 'psq_l', 57: 'psq_lu', 60: 'psq_st', 61: 'psq_stu'}[op], d, hex(dd), a, (w >> 15) & 1, (w >> 12) & 7)
    if op != 4: return None
    x5 = (w >> 1) & 31; x10 = (w >> 1) & 0x3FF
    if x10 in X10:
        m = X10[x10]
        if m in ('ps_neg', 'ps_mr', 'ps_nabs', 'ps_abs'): return '%s f%d, f%d' % (m, d, b)
        return '%s f%d, f%d, f%d' % (m, d, a, b)
    if (x10 & 0x3F) in (6, 7, 38, 39): return '%s f%d, r%d, r%d' % ({6: 'psq_lx', 7: 'psq_stx', 38: 'psq_lux', 39: 'psq_stux'}[x10 & 0x3F], d, a, b)
    if x5 in A5:
        m = A5[x5]
        if m in ('ps_div', 'ps_sub', 'ps_add'): return '%s f%d, f%d, f%d' % (m, d, a, b)
        if m in ('ps_res', 'ps_rsqrte'): return '%s f%d, f%d' % (m, d, b)
        if m in ('ps_mul', 'ps_muls0', 'ps_muls1'): return '%s f%d, f%d, f%d' % (m, d, a, c)
        return '%s f%d, f%d, f%d, f%d' % (m, d, a, c, b)
    return None
for k in range(0, len(code) - 3, 4):
    w = struct.unpack('>I', code[k:k + 4])[0]; t = ps(w)
    if t is None:
        i = list(md.disasm(code[k:k + 4], addr + k))
        t = '%s %s' % (i[0].mnemonic, i[0].op_str) if i else '.word 0x%08x' % w
    print('0x%x %s' % (addr + k, t))
