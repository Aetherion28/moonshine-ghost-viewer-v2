"""Reference reader/writer for the SGRN RNG tape (include/susamune/ghost_rng.h).

The tape follows a V6 ghost's SGTI chunk and records every libc rand() call
made while the ghost was recording. Values are not stored: the reader runs the
game's LCG from each SEED, so `decode` yields the exact rolls.

`validate` mirrors SusamuneGhostRngChunkValid and raises ValueError; `encode`
builds chunks for tests. See doc/ghost-rng-tape.md.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field

MAGIC = 0x5347524E  # 'SGRN'
VERSION = 1
HEADER_SIZE = 32
MAX_CALLERS = 255
MAX_ACTORS = 255
MAX_SIZE = 0x231F0
REQUIRED_RNG_TAPE = 0x00010000  # provisional; see ghost_rng.h

LCG_MUL = 0x41C64E6D
LCG_ADD = 0x3039

TRUNCATED = 0x01
LOST = 0x02
FOREIGN_THREAD = 0x04
CONTROLS = 0x08
NO_ACTORS = 0x10
FLAGS = 0x1F

OP_RUN_MAX = 0x7F
OP_FRAME = 0x80
OP_FRAME_MAX = 0xBF
OP_SEED = 0xC1
OP_QF = 0xC2
OP_SEGMENT = 0xC3
OP_OVERRIDE = 0xC4
OP_OVERRIDE_NODE = 0xC5
OP_LOAD = 0xC6
WAIT_UNKNOWN = 0xFFFFFFFF
MAX_RUN = 128
MAX_FRAME_SHORT = 64


def lcg_next(state: int) -> int:
    return (state * LCG_MUL + LCG_ADD) & 0xFFFFFFFF


def lcg_value(state_after: int) -> int:
    return (state_after >> 16) & 0x7FFF


def lcg_skip(state: int, n: int) -> int:
    """`state` advanced by n calls, in O(log n) (affine map composition)."""
    a, c = LCG_MUL, LCG_ADD          # one step
    ra, rc = 1, 0                    # identity
    while n:
        if n & 1:
            ra, rc = (a * ra) & 0xFFFFFFFF, (a * rc + c) & 0xFFFFFFFF
        a, c = (a * a) & 0xFFFFFFFF, (a * c + c) & 0xFFFFFFFF
        n >>= 1
    return (ra * state + rc) & 0xFFFFFFFF


@dataclass
class Actor:
    vtable: int
    key_code: int
    ordinal: int  # derived: earlier entries with the same (vtable, key_code)


@dataclass
class Call:
    frame: int        # tape frame index (0 = the frame recording began in)
    qf: int | None    # ghost QF of that frame, None until the tape knows it
    segment: int
    caller: int       # return address in the source region's main.dol
    actor: int        # actor table index, or -1 for none
    value: int        # what rand() returned
    state: int        # MSL `next` after the call
    used: int         # what the game actually received (differs on OVERRIDE)


@dataclass
class NodeOverride:
    frame: int
    qf: int | None
    actor: int
    node: int


@dataclass
class StageLoad:
    """A stage load the run went through (or began in)."""
    frame: int
    call_index: int    # index of the first call on the tape after this point
    load_seed: int     # generator state when TMarDirector::setup began
    wait_rolls: int | None  # rolls during the disc wait; None if unseen
    setup_seed: int    # state when TMarDirector::setupObjects began
    untaped: int       # rolls after setupObjects began that are not on the tape
    consistent: bool | None = None  # setup seed + untaped rolls == the tape's state


@dataclass
class Tape:
    flags: int
    callers: list[int]
    actors: list[Actor]
    calls: list[Call] = field(default_factory=list)
    node_overrides: list[NodeOverride] = field(default_factory=list)
    loads: list[StageLoad] = field(default_factory=list)
    frames: int = 0


def _header(data: bytes):
    if len(data) < HEADER_SIZE:
        raise ValueError("SGRN shorter than its header")
    return struct.unpack_from(">IHHHHIIIII", data, 0)


def validate(data: bytes) -> None:
    """Raises ValueError unless `data` is exactly one valid SGRN chunk."""
    (magic, version, header_size, callers, actors, stream, flags, checksum,
     calls, reserved) = _header(data)
    size = len(data)
    if size > MAX_SIZE:
        raise ValueError("SGRN exceeds its budget")
    if magic != MAGIC or version != VERSION or header_size != HEADER_SIZE:
        raise ValueError("bad SGRN header")
    if callers > MAX_CALLERS or actors > MAX_ACTORS:
        raise ValueError("SGRN table too large")
    if flags & ~FLAGS or reserved:
        raise ValueError("SGRN reserved bits set")
    if HEADER_SIZE + callers * 4 + actors * 8 + stream != size:
        raise ValueError("SGRN size does not match its header")
    if zlib.crc32(data[HEADER_SIZE:]) != checksum:
        raise ValueError("SGRN checksum mismatch")
    table = [struct.unpack_from(">I", data, HEADER_SIZE + 4 * i)[0]
             for i in range(callers)]
    if any(a == 0 or a & 3 for a in table) or len(set(table)) != len(table):
        raise ValueError("bad SGRN caller table")
    base = HEADER_SIZE + 4 * callers
    for i in range(actors):
        vtable, _key, ordinal = struct.unpack_from(">IHH", data, base + 8 * i)
        if vtable == 0 or ordinal != 0:
            raise ValueError("bad SGRN actor entry")
    at, end = size - stream, size
    counted, seeded, rolled = 0, False, False
    while at < end:
        op = data[at]
        at += 1
        if op <= OP_RUN_MAX:
            if end - at < 2 or not seeded or data[at] >= callers or data[at + 1] > actors:
                raise ValueError(f"bad RUN at {at - 1}")
            counted += op + 1
            rolled = True
            at += 2
        elif op <= OP_FRAME_MAX:
            pass
        elif op in (OP_SEED, OP_QF):
            if end - at < 4:
                raise ValueError("truncated SGRN op")
            seeded |= op == OP_SEED
            at += 4
        elif op == OP_SEGMENT:
            if end - at < 1 or data[at] >= 64:
                raise ValueError("bad SEGMENT")
            at += 1
        elif op == OP_OVERRIDE:
            if end - at < 2 or not rolled or struct.unpack_from(">H", data, at)[0] > 0x7FFF:
                raise ValueError("bad OVERRIDE")
            at += 2
        elif op == OP_OVERRIDE_NODE:
            if end - at < 3 or data[at] > actors:
                raise ValueError("bad OVERRIDE_NODE")
            at += 3
        elif op == OP_LOAD:
            if end - at < 16:
                raise ValueError("truncated LOAD")
            at += 16
        else:
            raise ValueError(f"unknown SGRN op {op:#x} at {at - 1}")
    if counted != calls:
        raise ValueError("SGRN call count mismatch")


def decode(data: bytes) -> Tape:
    """Validates, then replays the tape into individual calls."""
    validate(data)
    (_m, _v, _h, ncallers, nactors, stream, flags, _c, _calls, _r) = _header(data)
    callers = [struct.unpack_from(">I", data, HEADER_SIZE + 4 * i)[0]
               for i in range(ncallers)]
    base = HEADER_SIZE + 4 * ncallers
    actors, seen = [], {}
    for i in range(nactors):
        vtable, key, _ = struct.unpack_from(">IHH", data, base + 8 * i)
        ordinal = seen.get((vtable, key), 0)
        seen[(vtable, key)] = ordinal + 1
        actors.append(Actor(vtable, key, ordinal))
    tape = Tape(flags, callers, actors)

    frame, segment, state, seeded = 0, 0, 0, False
    pending = None  # (load, expected state) awaiting the next known state
    cur = prev = None  # QF of the current / previous frame
    step = 0
    at, end = len(data) - stream, len(data)
    while at < end:
        op = data[at]
        at += 1
        if op <= OP_RUN_MAX:
            caller, actor = data[at], data[at + 1]
            at += 2
            if pending:
                pending[0].consistent = pending[1] == state
                pending = None
            for _ in range(op + 1):
                state = lcg_next(state)
                value = lcg_value(state)
                tape.calls.append(Call(frame, cur, segment, callers[caller],
                                       actor - 1, value, state, value))
        elif op <= OP_FRAME_MAX:
            for _ in range(op - 0x7F):
                frame += 1
                prev = cur
                cur = None if cur is None else (cur + step) & 0xFFFFFFFF
        elif op == OP_SEED:
            state = struct.unpack_from(">I", data, at)[0]
            at += 4
            seeded = True
            if pending:
                pending[0].consistent = pending[1] == state
                pending = None
        elif op == OP_QF:
            qf = struct.unpack_from(">I", data, at)[0]
            at += 4
            if prev is not None:
                step = (qf - prev) & 0xFFFFFFFF
            cur = qf
        elif op == OP_SEGMENT:
            segment = data[at]
            at += 1
        elif op == OP_OVERRIDE:
            tape.calls[-1].used = struct.unpack_from(">H", data, at)[0]
            at += 2
        elif op == OP_OVERRIDE_NODE:
            actor, node = struct.unpack_from(">Bh", data, at)
            at += 3
            tape.node_overrides.append(NodeOverride(frame, cur, actor - 1, node))
        elif op == OP_LOAD:
            load_seed, wait, setup_seed, untaped = struct.unpack_from(">IIII", data, at)
            at += 16
            load = StageLoad(frame, len(tape.calls), load_seed,
                             None if wait == WAIT_UNKNOWN else wait, setup_seed, untaped)
            if load.wait_rolls is not None and lcg_skip(load_seed, load.wait_rolls) != setup_seed:
                load.consistent = False
            tape.loads.append(load)
            if load.consistent is None:
                pending = (load, lcg_skip(setup_seed, untaped))
    if pending and seeded:
        pending[0].consistent = pending[1] == state
    tape.frames = frame + 1
    return tape


class Encoder:
    """Builds a chunk the same way the PPC recorder does (for tests)."""

    def __init__(self, seed: int):
        self.callers: list[int] = []
        self.actors: list[tuple[int, int]] = []
        self.stream = bytearray()
        self.flags = 0
        self.calls = 0
        self.predicted = seed
        self.pending = 0
        self.last_run = None  # (offset, caller, actor)
        self.cur = self.prev = None
        self.step = 0
        self.segment = 0
        self.stream += bytes([OP_SEED]) + struct.pack(">I", seed)

    def _flush(self):
        while self.pending:
            n = min(self.pending, MAX_FRAME_SHORT)
            self.stream.append(0x7F + n)
            self.pending -= n
        self.last_run = None

    def frame(self, qf: int | None = None, segment: int | None = None):
        self.pending += 1
        self.last_run = None
        self.prev = self.cur
        if self.cur is not None:
            self.cur = (self.cur + self.step) & 0xFFFFFFFF
        if qf is not None and self.cur != qf:
            self._flush()
            self.stream += bytes([OP_QF]) + struct.pack(">I", qf)
            if self.prev is not None:
                self.step = (qf - self.prev) & 0xFFFFFFFF
            self.cur = qf
        if segment is not None and segment != self.segment:
            self._flush()
            self.stream += bytes([OP_SEGMENT, segment])
            self.segment = segment

    def call(self, caller: int, actor: tuple[int, int] | None, state: int) -> int:
        """`state` is MSL `next` before the call. Returns the rolled value."""
        if state != self.predicted:
            self._flush()
            self.stream += bytes([OP_SEED]) + struct.pack(">I", state)
        self.predicted = lcg_next(state)
        if caller not in self.callers:
            self.callers.append(caller)
        c = self.callers.index(caller)
        a = 0
        if actor is not None:
            if actor not in self.actors:
                self.actors.append(actor)
            a = self.actors.index(actor) + 1
        run = self.last_run
        if (run and not self.pending and self.stream[run[0]] < OP_RUN_MAX
                and run[1] == c and run[2] == a):
            self.stream[run[0]] += 1
        else:
            self._flush()
            self.last_run = (len(self.stream), c, a)
            self.stream += bytes([0, c, a])
        self.calls += 1
        return lcg_value(self.predicted)

    def override(self, value: int):
        self._flush()
        self.stream += bytes([OP_OVERRIDE]) + struct.pack(">H", value & 0x7FFF)

    def override_node(self, actor: tuple[int, int] | None, node: int):
        a = 0
        if actor is not None:
            if actor not in self.actors:
                self.actors.append(actor)
            a = self.actors.index(actor) + 1
        self._flush()
        self.stream += bytes([OP_OVERRIDE_NODE, a]) + struct.pack(">h", node)

    def load(self, load_seed: int, wait_rolls: int | None, setup_seed: int, untaped: int):
        self._flush()
        self.stream += bytes([OP_LOAD]) + struct.pack(
            ">IIII", load_seed, WAIT_UNKNOWN if wait_rolls is None else wait_rolls,
            setup_seed, untaped)

    def finish(self) -> bytes:
        body = b"".join(struct.pack(">I", c) for c in self.callers)
        body += b"".join(struct.pack(">IHH", v, k, 0) for v, k in self.actors)
        body += bytes(self.stream)
        header = struct.pack(">IHHHHIIIII", MAGIC, VERSION, HEADER_SIZE,
                             len(self.callers), len(self.actors), len(self.stream),
                             self.flags, zlib.crc32(body), self.calls, 0)
        return header + body
