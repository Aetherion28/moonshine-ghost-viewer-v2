# Jobs for wiiprobe from Python (standard library only): build a script, read an answer. The format is ../script.ts's.
#   python3 wiijob.py show <answer>                       an answer's records, a line each
#   python3 wiijob.py code <blob.bin> [argument] <out.job>   a job that loads a piece of code and calls it
#   python3 wiijob.py quit <1|2> <out.job>                a job that makes the program leave (1) or restart the console (2)
import struct, sys
OP = dict(END=0, MEM=1, FIFO=2, BPADDR=3, SYNC=4, DUMP=5, CPADDR=6, READ16=7, NOTE=8, MEMRLE=9, QUIT=10, PEEK=11, READ32=12, CODE=13, CALL=14)
NAMES = {v: k for k, v in OP.items()}; NAMES.update({100: 'CONSOLE', 101: 'END', 102: 'STOPPED', 103: 'PROGRESS', 104: 'FAULT'})

class Script:
    def __init__(self, arena=0): self.ops = []; self.arena = arena
    def op(self, op, a=0, b=0, data=b''): self.ops.append((OP[op] if isinstance(op, str) else op, a & 0xFFFFFFFF, b & 0xFFFFFFFF, bytes(data))); return self
    def mem(self, at, data):
        for o in range(0, len(data), 0x10000): self.op('MEM', at + o, 0, data[o:o + 0x10000])
        self.arena = max(self.arena, at + len(data)); return self
    def code(self, at, data):
        for o in range(0, len(data), 0x10000): self.op('CODE', at + o, 0, data[o:o + 0x10000])
        return self
    def call(self, at=0, arg=0): return self.op('CALL', at, arg)
    def note(self, text): return self.op('NOTE', 0, 0, text.encode())
    def dump(self, at, n): return self.op('DUMP', at, n)
    def peek(self, addr, n): return self.op('PEEK', addr, n)
    def read16(self, addr, n): return self.op('READ16', addr, n)
    def read32(self, addr, n): return self.op('READ32', addr, n)
    def bytes(self):
        out = [b'GXPS', struct.pack('>III', 1, (self.arena + 31) & ~31, 0)]
        for op, a, b, data in self.ops + [(0, 0, 0, b'')]: out.append(struct.pack('>IIII', op, a, b, len(data)) + data + b'\0' * (-len(data) & 3))
        return b''.join(out)

def unrle(s, n):
    d = bytearray(); i = 0
    while i < len(s):
        c = s[i]; i += 1
        if c < 128: d += s[i:i + c + 1]; i += c + 1
        else: d += bytes([s[i]]) * (c - 126); i += 1
    assert len(d) == n; return bytes(d)

def records(answer):
    """[(kind, a, b, data)] (packed blocks unpacked, as DUMP)"""
    assert answer[:4] == b'GXPO', 'not an answer'
    out = []; p = 16
    while p + 16 <= len(answer):
        kind, a, b, n = struct.unpack('>IIII', answer[p:p + 16]); data = answer[p + 16:p + 16 + n]; p += 16 + ((n + 3) & ~3)
        out.append((5, a, b, unrle(data, b)) if kind == 9 else (kind, a, b, data))
    return out

def show(answer):
    version, build = struct.unpack('>II', answer[8:16]); print(f'program version {version}, build {build:08x}')
    for kind, a, b, data in records(answer):
        name = NAMES.get(kind, str(kind))
        if kind == 100: h, cpu, arena, code = struct.unpack('>4I', data); print(f'CONSOLE Hollywood {h:x}, CPU {cpu:x}, arena {arena:08x}, code {code:08x}')
        elif kind in (102, 103): print(name, a, data.decode('latin-1'))
        elif kind == 104:
            f = struct.unpack('>41I', data); print(f'FAULT exception {f[0]} at {f[1]:08x} (msr {f[2]:08x} lr {f[3]:08x} dar {f[7]:08x} dsisr {f[8]:08x})'); print('  r0-r31', ' '.join('%08x' % v for v in f[9:]))
        elif kind == 14: print(f'CALL {a:x}({b:x}) -> {struct.unpack(">I", data)[0]:08x}')
        elif kind == 7: print(f'READ16 {a:08x}:', ' '.join('%04x' % v for v in struct.unpack(f'>{len(data) // 2}H', data)))
        elif kind == 12: print(f'READ32 {a:08x}:', ' '.join('%08x' % v for v in struct.unpack(f'>{len(data) // 4}I', data)))
        elif kind == 101: print(f'END {a} operations, {b} blocks')
        else: print(name, f'{a:x} {b:x}', len(data), 'bytes', data[:32].hex())

if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'show': show(open(sys.argv[2], 'rb').read())
    elif what == 'code':
        arg = int(sys.argv[3], 0) if len(sys.argv) > 4 else 0
        open(sys.argv[-1], 'wb').write(Script().note('code ' + sys.argv[2]).code(0, open(sys.argv[2], 'rb').read()).call(0, arg).bytes())
    elif what == 'quit': open(sys.argv[3], 'wb').write(Script().op('QUIT', int(sys.argv[2])).bytes())
