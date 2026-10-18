"""RNG tape (SGRN) tests: reference codec, shared C validator, whole-file
validation, and the production ARM kernel validator compiled for the host.

The C parts compile with the bundled Windows compiler on Windows and with the
host clang elsewhere, so they also run in Linux CI.
"""

from pathlib import Path
import ctypes
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

import ghost_rng as rng
import validate_ghost as ghost
from test_ghost_storage import rechecksum_ghost
from test_ghost_teaching import teaching_file

ROOT = Path(__file__).resolve().parents[1]


def host_compiler():
    if sys.platform == "win32":
        bundled = ROOT / "toolchain/clang.exe"
        return [str(bundled), "--target=x86_64-pc-windows-msvc", "-fuse-ld=lld",
                "-Wl,/noentry"] if bundled.exists() else None
    clang = shutil.which("clang")
    return [clang, "-fPIC"] if clang else None


def build_library(source: str, folder: Path, name: str):
    command = host_compiler()
    if command is None:
        raise unittest.SkipTest("no C compiler for the host")
    path = folder / (name + (".dll" if sys.platform == "win32" else ".so"))
    (folder / (name + ".c")).write_text(source)
    result = subprocess.run(command + ["-shared", "-nostdlib", "-O1",
                                       "-I", str(ROOT / "include"),
                                       str(folder / (name + ".c")), "-o", str(path)],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return ctypes.CDLL(str(path))


EXPORT = "__declspec(dllexport)" if sys.platform == "win32" else \
    '__attribute__((visibility("default")))'

V6_FLUDD = bytes([0x18, 0, 25, 0, 0, 0, 0, 65])


def sample_tape(seed=0x1234ABCD, calls=40) -> bytes:
    """A small but complete tape: QF changes, runs, two callers and actors,
    a SEED break, an override, a node override and a segment change."""
    enc = rng.Encoder(seed)
    state = seed
    chomp, pianta = (0x803C1000, 0x1234), (0x803C2000, 0x0042)
    for frame in range(calls):
        enc.frame(qf=100 + frame * 4 + (1 if frame > 20 else 0),
                  segment=1 if frame >= 30 else 0)
        for _ in range(frame % 3):
            enc.call(0x80123454, chomp, state)
            state = rng.lcg_next(state)
        if frame % 5 == 0:
            enc.call(0x80200008, pianta, state)
            state = rng.lcg_next(state)
        if frame == 10:
            enc.override(0x6000)
        if frame == 12:
            state = 0xDEADBEEF  # a state load that did not rewind the seed
            enc.call(0x80123454, None, state)
            state = rng.lcg_next(state)
        if frame == 15:
            enc.override_node(pianta, 7)
    return enc.finish()


def tape_file(tape: bytes) -> bytes:
    base = teaching_file(fludd=[V6_FLUDD] * 3)
    out = bytearray(base + tape)
    struct.pack_into(">I", out, 8, len(out))
    struct.pack_into(">I", out, 24, 7 | rng.REQUIRED_RNG_TAPE)
    struct.pack_into(">I", out, 72, len(out) - 256)
    return rechecksum_ghost(bytes(out))


def reseal(chunk: bytearray) -> bytes:
    struct.pack_into(">I", chunk, 20, zlib.crc32(bytes(chunk[32:])))
    return bytes(chunk)


class CodecTests(unittest.TestCase):
    def test_values_follow_msl_rand(self):
        # MSL: next = next * 1103515245 + 12345; return (next >> 16) & 0x7fff
        state, expected = 1, []
        for _ in range(5):
            state = (state * 1103515245 + 12345) & 0xFFFFFFFF
            expected.append((state >> 16) & 0x7FFF)
        enc = rng.Encoder(1)
        state = 1
        for _ in range(5):
            enc.frame()
            enc.call(0x80001000, None, state)
            state = rng.lcg_next(state)
        tape = rng.decode(enc.finish())
        self.assertEqual([c.value for c in tape.calls], expected)
        self.assertEqual(expected[:2], [16838, 5758])  # the classic first rolls

    def test_round_trip_keeps_order_attribution_and_time(self):
        enc = rng.Encoder(7)
        state, made = 7, []
        actors = [None, (0x803C1000, 1), (0x803C1000, 1), (0x803C1000, 2)]
        for frame in range(300):
            enc.frame(qf=frame * 4, segment=frame // 100)
            for k in range(frame % 4):
                caller = 0x80100000 + 4 * (k % 2)
                actor = actors[(frame + k) % 4]
                value = enc.call(caller, actor, state)
                state = rng.lcg_next(state)
                made.append((frame + 1, frame * 4, frame // 100, caller, value))
        tape = rng.decode(enc.finish())
        self.assertEqual([(c.frame, c.qf, c.segment, c.caller, c.value) for c in tape.calls],
                         made)
        self.assertEqual(tape.frames, 301)  # frame 0 is the one recording began in

    def test_runs_merge_and_split(self):
        enc = rng.Encoder(0)
        enc.frame(qf=0)
        state = 0
        for _ in range(300):  # one site, one frame: runs of 128
            enc.call(0x80001000, None, state)
            state = rng.lcg_next(state)
        data = enc.finish()
        stream = data[-(len(data) - 32 - 4):]
        self.assertEqual([b for b in stream if b <= 0x7F and b in (127, 43)].count(127), 2)
        self.assertEqual(len(rng.decode(data).calls), 300)

    def test_qf_model_handles_pal_cadence_and_lag(self):
        # PAL frames are 4.8 QF; a lag frame doubles a step.
        qfs, q = [], 1000
        for i in range(100):
            q += 5 if i % 5 else 4
            if i == 50:
                q += 4
            qfs.append(q)
        enc = rng.Encoder(3)
        state = 3
        for q in qfs:
            enc.frame(qf=q)
            enc.call(0x80001000, None, state)
            state = rng.lcg_next(state)
        tape = rng.decode(enc.finish())
        self.assertEqual([c.qf for c in tape.calls], qfs)

    def test_long_gaps_use_repeated_frame_ops(self):
        enc = rng.Encoder(9)
        enc.frame(qf=0)
        for _ in range(1000):
            enc.frame()
        enc.call(0x80001000, None, 9)
        tape = rng.decode(enc.finish())
        self.assertEqual(tape.calls[0].frame, 1001)
        # One reading gives no step, so frames without a reading extrapolate
        # with step 0 (doc/ghost-rng-tape.md, "Time").
        self.assertEqual(tape.calls[0].qf, 0)

    def test_overrides(self):
        tape = rng.decode(sample_tape())
        used = [c for c in tape.calls if c.used != c.value]
        self.assertEqual([c.used for c in used], [0x6000])
        self.assertEqual(tape.node_overrides[0].node, 7)
        self.assertEqual(tape.actors[tape.node_overrides[0].actor].key_code, 0x42)

    def test_seed_breaks_resume_from_new_state(self):
        tape = rng.decode(sample_tape())
        broken = [c for c in tape.calls if c.frame == 13 and c.actor == -1]
        self.assertEqual(broken[0].state, rng.lcg_next(0xDEADBEEF))

    def test_actor_ordinals_are_derived(self):
        enc = rng.Encoder(0)
        enc.frame()
        a, b = (0x803C1000, 5), (0x803C1000, 5)
        enc.call(0x80001000, a, 0)
        enc.actors.append(b)  # same class and name, second object
        enc.call(0x80001000, None, rng.lcg_next(0))
        tape = rng.decode(enc.finish())
        self.assertEqual([x.ordinal for x in tape.actors], [0, 1])

    def test_validator_rejections(self):
        good = bytearray(sample_tape())
        rng.validate(bytes(good))
        cases = {
            "magic": (0, b"XXXX"),
            "version": (4, b"\x00\x02"),
            "reserved": (28, b"\x00\x00\x00\x01"),
            "flags": (16, b"\x00\x00\x01\x00"),
            "calls": (24, struct.pack(">I", 1)),
        }
        for name, (offset, value) in cases.items():
            with self.subTest(name):
                bad = bytearray(good)
                bad[offset:offset + len(value)] = value
                with self.assertRaises(ValueError):
                    rng.validate(reseal(bad))
        with self.assertRaises(ValueError):  # checksum
            bad = bytearray(good)
            bad[-1] ^= 1
            rng.validate(bytes(bad))
        with self.assertRaises(ValueError):  # unknown opcode
            bad = bytearray(good)
            bad.append(0xC0)
            struct.pack_into(">I", bad, 12, struct.unpack_from(">I", bad, 12)[0] + 1)
            rng.validate(reseal(bad))
        with self.assertRaises(ValueError):  # RUN before any SEED
            body = struct.pack(">I", 0x80001000) + bytes([0, 0, 0])
            head = struct.pack(">IHHHHIIIII", rng.MAGIC, 1, 32, 1, 0, 3, 0,
                               zlib.crc32(body), 1, 0)
            rng.validate(head + body)


class SharedCValidatorTests(unittest.TestCase):
    """SusamuneGhostRngChunkValid (PPC/ARM shared header) vs the reference."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="moonshine-sgrn-")
        cls.addClassCleanup(cls.temp.cleanup)
        source = '#include "susamune/ghost_rng.h"\n' + EXPORT + (
            " int valid(const unsigned char *p, unsigned int n) "
            "{ return SusamuneGhostRngChunkValid(p, n); }\n")
        cls.lib = build_library(source, Path(cls.temp.name), "sgrn")
        cls.lib.valid.argtypes = [ctypes.c_char_p, ctypes.c_uint]

    def c_valid(self, data: bytes) -> bool:
        return self.lib.valid(data, len(data)) == 1

    def py_valid(self, data: bytes) -> bool:
        # The C function leaves the CRC to its caller.
        raw = bytearray(data)
        if len(raw) >= 32:
            struct.pack_into(">I", raw, 20, zlib.crc32(bytes(raw[32:])))
        try:
            rng.validate(bytes(raw))
            return True
        except ValueError:
            return False

    def test_agree_on_valid_and_mutated_tapes(self):
        generator = random.Random(1234)
        corpus = [sample_tape(seed) for seed in (0, 1, 0xFFFFFFFF)]
        corpus.append(rng.Encoder(5).finish())
        mutated = []
        for data in corpus:
            for _ in range(400):
                raw = bytearray(data)
                for _ in range(generator.randint(1, 3)):
                    raw[generator.randrange(len(raw))] = generator.randrange(256)
                if generator.random() < 0.2:
                    raw = raw[:generator.randrange(len(raw) + 1)]
                mutated.append(bytes(raw))
        for data in corpus:
            self.assertTrue(self.c_valid(data))
        disagreements = [d for d in mutated if self.c_valid(d) != self.py_valid(d)]
        self.assertEqual(disagreements, [])
        self.assertGreater(sum(not self.c_valid(d) for d in mutated), 1000)

    def test_rejects_oversize(self):
        self.assertFalse(self.c_valid(bytes(rng.MAX_SIZE + 1)))


class FileTests(unittest.TestCase):
    def test_validate_ghost_reads_tape(self):
        result = ghost.validate_ghost(tape_file(sample_tape()))
        self.assertEqual(result["version"], 6)
        self.assertEqual(result["required_features"], 7 | rng.REQUIRED_RNG_TAPE)
        self.assertEqual(result["teaching"]["input_count"], 3)
        self.assertEqual(result["rng_tape"]["calls"], len(rng.decode(sample_tape()).calls))

    def test_plain_v6_has_no_tape(self):
        self.assertIsNone(ghost.validate_ghost(teaching_file(fludd=[V6_FLUDD] * 3))["rng_tape"])

    def test_bit_without_tape_and_tape_without_bit_fail(self):
        plain = bytearray(teaching_file(fludd=[V6_FLUDD] * 3))
        struct.pack_into(">I", plain, 24, 7 | rng.REQUIRED_RNG_TAPE)
        with self.assertRaises(ghost.FormatError):
            ghost.validate_ghost(rechecksum_ghost(bytes(plain)))
        raw = bytearray(tape_file(sample_tape()))
        struct.pack_into(">I", raw, 24, 7)
        with self.assertRaises(ghost.FormatError):
            ghost.validate_ghost(rechecksum_ghost(bytes(raw)))

    def test_bit_only_on_v6(self):
        raw = bytearray(tape_file(sample_tape()))
        struct.pack_into(">H", raw, 4, 5)
        with self.assertRaises(ghost.FormatError):
            ghost.validate_ghost(rechecksum_ghost(bytes(raw)))

    def test_corrupt_tape_fails_file(self):
        raw = bytearray(tape_file(sample_tape()))
        raw[-1] ^= 0x40
        with self.assertRaises(ghost.FormatError):
            ghost.validate_ghost(rechecksum_ghost(bytes(raw)))

    def test_largest_file_fits_v5_limit(self):
        # Maximum V6 poses and inputs plus the largest tape the recorder can
        # export is still within the shared V5 file limit.
        from test_ghost_format import build_ghost
        samples = [(0, 0, 0, 0, 0, 0, 0)] + [(0, 0, 0, 0, 4, 0, 0)] * 17982
        inputs = [(i * 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) for i in range(35964)]
        base = teaching_file(inputs, [], build_ghost(version=4, samples=samples, start_qf=0),
                             fludd=[bytes(8)] * 35964)
        enc = rng.Encoder(0)
        enc.callers = [0x80000000 + 4 * i for i in range(255)]
        enc.actors = [(0x80300000 + 4 * i, i) for i in range(255)]
        # src/ghost_rng.cpp: the live tape holds a 32-byte header and three
        # 255-entry tables (callers, actors, pointers) before the stream.
        stream_capacity = 0x231F0 - (32 + 255 * 4 + 255 * 8 + 255 * 4)
        enc.stream += bytes([0xBF]) * (stream_capacity - len(enc.stream))
        tape = enc.finish()
        data = tape_file_on(base, tape)
        self.assertLessEqual(len(data), 0x13CE60)
        ghost.validate_ghost(data)
        # The bound itself, at the absolute maxima.
        v6_max = 0x900 + 17983 * 16 + 32 + 36000 * 24 + 8 * 12
        self.assertLessEqual(v6_max + len(tape), 0x13CE60)
        self.assertEqual(v6_max + rng.MAX_SIZE, 0x13CE60)


def tape_file_on(base: bytes, tape: bytes) -> bytes:
    out = bytearray(base + tape)
    struct.pack_into(">I", out, 8, len(out))
    struct.pack_into(">I", out, 24, 7 | rng.REQUIRED_RNG_TAPE)
    struct.pack_into(">I", out, 72, len(out) - 256)
    return rechecksum_ghost(bytes(out))


class KernelValidatorTests(unittest.TestCase):
    """The production ARM canonical validator, extracted as test_ghost_teaching
    does, built for the host."""

    @classmethod
    def setUpClass(cls):
        kernel = (ROOT / "launcher/kernel/SusamuneGhost.c").read_text()
        globals_ = kernel[kernel.index("static const u8 *ValidationBytes;"):
                          kernel.index("static volatile struct SusamuneGhostStorageMailbox *GhostBlock")]
        functions = kernel[kernel.index("static u16 ReadBe16("):
                           kernel.index("static bool GenerationIsNewer(")]
        functions = functions[:functions.index("static void WriteBe16(")] + functions[
            functions.index("static bool BytesAreZero("):]
        shim = '''#include "susamune/ghost_storage.h"
#include "susamune/ghost_rng.h"
typedef unsigned char u8; typedef unsigned short u16;
typedef unsigned int u32; typedef int s32; typedef _Bool bool;
#define true 1
#define false 0
#define GAME_ID 0x474D534Au
enum ValidateResult { VALIDATE_INVALID, VALIDATE_OK, VALIDATE_FORWARD };
static int memcmp(const void *aa,const void *bb,unsigned long long n) {
 const u8 *a=aa,*b=bb; while(n--) { if(*a!=*b)return *a-*b; ++a;++b; } return 0; }
'''
        wrapper = EXPORT + ''' int validate(const u8 *p,u32 n) {
 int r=BeginCanonicalValidation(p,n,0,false); unsigned int passes=0;
 if(r!=VALIDATE_OK)return r;
 do { u32 before=ValidationOffset; r=ContinueCanonicalValidation();
  if(ValidationOffset-before>0x4000 || ++passes>400 || (r<0 && ValidationOffset<=before))return -2;
 } while(r<0);
 return r;
}
'''
        cls.temp = tempfile.TemporaryDirectory(prefix="moonshine-arm-sgrn-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.lib = build_library(shim + globals_ + functions + wrapper,
                                Path(cls.temp.name), "arm")
        cls.lib.validate.argtypes = [ctypes.c_char_p, ctypes.c_uint]

    def check(self, data):
        return self.lib.validate(data, len(data))

    def test_accepts_tape_files_and_plain_files(self):
        self.assertEqual(self.check(tape_file(sample_tape())), 1)
        self.assertEqual(self.check(tape_file(rng.Encoder(1).finish())), 1)
        self.assertEqual(self.check(teaching_file(fludd=[V6_FLUDD] * 3)), 1)
        self.assertEqual(self.check(teaching_file()), 1)

    def test_rejects_corrupt_or_mislabelled_tapes(self):
        raw = bytearray(tape_file(sample_tape()))
        raw[-1] ^= 0x40  # tape CRC
        self.assertEqual(self.check(rechecksum_ghost(bytes(raw))), 0)
        tape = bytearray(sample_tape())
        tape.append(0xC0)  # unknown op, resealed
        struct.pack_into(">I", tape, 12, struct.unpack_from(">I", tape, 12)[0] + 1)
        self.assertEqual(self.check(tape_file(reseal(tape))), 0)
        plain = bytearray(teaching_file(fludd=[V6_FLUDD] * 3))
        struct.pack_into(">I", plain, 24, 7 | rng.REQUIRED_RNG_TAPE)
        self.assertEqual(self.check(rechecksum_ghost(bytes(plain))), 0)
        raw = bytearray(tape_file(sample_tape()))
        struct.pack_into(">I", raw, 24, 7)  # tape bytes without the bit
        self.assertEqual(self.check(rechecksum_ghost(bytes(raw))), 0)

    def test_other_unknown_bits_stay_forward(self):
        raw = bytearray(tape_file(sample_tape()))
        struct.pack_into(">I", raw, 24, 7 | rng.REQUIRED_RNG_TAPE | 0x20)
        self.assertEqual(self.check(rechecksum_ghost(bytes(raw))), 2)


class PpcRecorderTests(unittest.TestCase):
    """src/ghost_rng.cpp itself, executed as big-endian PowerPC under qemu-ppc
    (scripts/ghost_rng_ppc/harness.cpp). Needs clang, ld.lld and qemu-ppc."""

    @classmethod
    def setUpClass(cls):
        tools = [shutil.which(t) for t in ("clang++", "ld.lld", "qemu-ppc")]
        if not all(tools):
            raise unittest.SkipTest("clang++, ld.lld and qemu-ppc required")
        clang, lld, qemu = tools
        cls.temp = tempfile.TemporaryDirectory(prefix="moonshine-ppc-rng-")
        cls.addClassCleanup(cls.temp.cleanup)
        out = Path(cls.temp.name)
        flags = ["--target=powerpc-unknown-linux-gnu", "-O1", "-w", "-ffreestanding",
                 "-fno-builtin", "-fno-exceptions", "-fno-rtti", "-fsigned-char",
                 "-nostdinc++", "-nobuiltininc", "-std=c++17", "-fno-pic", "-fno-pie",
                 "-fno-stack-protector", "-I", str(ROOT / "include"),
                 "-I", str(ROOT / "include/JSystem"), "-DSUSAMUNE_VERSION_US=1",
                 "-DIS_EMULATOR=0", "-DENABLE_SAVESTATE_DBG=0",
                 "-DENABLE_MEM_DIAGNOSTICS=0", "-DENABLE_DEBUG_WARPS=0"]
        objects = []
        for source in ("scripts/ghost_rng_ppc/harness.cpp", "src/ghost_rng.cpp",
                       "src/checksum.cpp"):
            obj = out / (Path(source).name + ".o")
            subprocess.run([clang] + flags + ["-c", str(ROOT / source), "-o", str(obj)],
                           check=True, capture_output=True)
            objects.append(str(obj))
        exe = out / "harness"
        subprocess.run([lld, "-m", "elf32ppc", "-static", "-nostdlib", "-T",
                        str(ROOT / "scripts/ghost_rng_ppc/harness.ld")] + objects +
                       ["-o", str(exe)], check=True, capture_output=True)
        run = subprocess.run([qemu, str(exe)], capture_output=True, text=True, timeout=120)
        if run.returncode:
            raise RuntimeError(f"harness exited {run.returncode}: {run.stdout}{run.stderr}")
        lines = run.stdout.split()
        cls.site_a = int(lines[lines.index("site_a") + 1], 16)
        cls.hook = int(lines[lines.index("hook_rand") + 1], 16)
        values = lines[lines.index("values") + 1:lines.index("chunk")]
        cls.values = [int(v, 16) for v in values]
        cls.chunk = bytes.fromhex("".join(lines[lines.index("chunk") + 1:lines.index("end")]))
        cls.tape = rng.decode(cls.chunk)
        cls.relo_flags = int(lines[lines.index("relo_flags") + 1], 16)
        cls.lost_flags = int(lines[lines.index("lost_flags") + 1], 16)
        cls.lost_stream = int(lines[lines.index("lost_stream") + 1], 16)
        cls.cross_flags = int(lines[lines.index("cross_flags") + 1], 16)

    @staticmethod
    def expected():
        """harness.cpp's final timeline, in call order."""
        calls = []
        for f in list(range(0, 20)) + list(range(20, 45)) + list(range(45, 55)):
            qf = 1000 + f * 4 + (1 if f > 30 else 0)
            seg = 1 if f >= 45 else 0
            calls += [(f + 1, qf, seg, "A", 0x1234), (f + 1, qf, seg, "A", 0x1234),
                      (f + 1, qf, seg, "B", 0x0777)]
            if f % 3 == 0:
                calls.append((f + 1, qf, seg, "B", None))
            if f % 7 == 0:
                calls.append((f + 1, qf, seg, "C", None))
            if f == 12:
                calls.append((f + 1, qf, seg, "A", None))
        return calls

    def test_hook_is_a_branch(self):
        self.assertEqual(self.hook >> 26, 18)  # `b` patched over rand()'s entry

    def test_values_match_the_game(self):
        self.assertEqual([c.value for c in self.tape.calls],
                         [v & 0x7FFF for v in self.values])
        overridden = [c.used for c, v in zip(self.tape.calls, self.values) if v >> 31]
        self.assertEqual(overridden, [0x6000] * len(overridden))
        self.assertTrue(overridden)
        # The values are MSL's: replay from the opening seed.
        state, first = 0x0BADF00D, []
        for _ in range(3):
            state = rng.lcg_next(state)
            first.append(rng.lcg_value(state))
        self.assertEqual([v & 0x7FFF for v in self.values[:3]], first)

    def test_time_sites_and_objects(self):
        expected = self.expected()
        self.assertEqual(len(self.tape.calls), len(expected))
        sites = {}
        for call, (frame, qf, seg, site, key) in zip(self.tape.calls, expected):
            self.assertEqual((call.frame, call.qf, call.segment), (frame, qf, seg))
            sites.setdefault(site, set()).add(call.caller)
            actor = None if call.actor < 0 else self.tape.actors[call.actor].key_code
            self.assertEqual(actor, key, (frame, site))
        self.assertEqual(sites["C"], {0x80001234})
        self.assertEqual(len(sites["A"]), 1)
        self.assertEqual(len(sites["B"]), 1)
        self.assertNotEqual(sites["A"], sites["B"])
        (a,) = sites["A"]
        self.assertTrue(self.site_a < a < self.site_a + 0x100)

    def test_flags_and_node_override(self):
        self.assertEqual(self.tape.flags, rng.FOREIGN_THREAD)
        (node,) = self.tape.node_overrides
        self.assertEqual((node.frame, node.node), (10, 5))
        self.assertEqual(self.tape.actors[node.actor].key_code, 0x42)

    def test_rewind_left_no_trace_of_the_abandoned_future(self):
        # The abandoned frames 20-34 rolled the same values (same seed); the
        # tape must hold each frame exactly once.
        frames = [c.frame for c in self.tape.calls]
        self.assertEqual(frames, sorted(frames))
        self.assertEqual(self.tape.frames, 56)

    def test_unsafe_rewind_is_lost(self):
        self.assertEqual(self.relo_flags & rng.LOST, 0)
        self.assertEqual(self.lost_flags, rng.LOST)
        self.assertEqual(self.lost_stream, 0)
        self.assertEqual(self.cross_flags, rng.LOST)  # another tape's state

    def test_seed_breaks_are_recorded(self):
        stage = [c for c in self.tape.calls if c.segment == 1]
        self.assertEqual(stage[0].state, rng.lcg_next(0x12345678))


if __name__ == "__main__":
    unittest.main()
