# Ghost RNG tape (SGRN)

Branch `moonshine-rng`, on Moonshine V2.3.3. Written so it can be ported into
Dogecyanide's development tree; see **Porting to the dev build** at the end.

## What it is

While a ghost records, every call to the game's libc `rand()` is logged:
which code called it, which scene object was being performed, and in which
frame. Values are not stored: the game's generator is MSL's
`next = next * 1103515245 + 12345; return (next >> 16) & 0x7fff`, so a reader
regenerates every roll from the seeds on the tape. The log is appended to the
saved ghost as an SGRN chunk, so an offline viewer can feed each enemy, boss
and NPC exactly the rolls the game gave it.

What it does not do:

- It is not a replay. The game never reads the tape back; Watch and Race are
  unchanged and ghosts still do not drive the world.
- A viewer only reproduces an object if its own port of that object's code
  consumes rolls in the game's order. The tape says which roll each call got;
  it cannot fix a port that calls `rand()` a different number of times.
- Particles (JParticle emitters) use their own per-emitter generators, not
  libc `rand()`, so they are not on the tape.
- Outcome controls that change a result without changing a roll (King Boo
  always-fruit, Petey no-tornado, Ricco crane speed) only set the CONTROLS flag.
  Controls that replace a roll or a graph choice are recorded exactly
  (OVERRIDE / OVERRIDE_NODE).

## File placement

A ghost with a tape is a V6 file whose `requiredFeatures` is
`7 | SUSAMUNE_GHOST_REQUIRED_RNG_TAPE` (exactly). The SGRN chunk follows SGTI
and runs to the end of the file. SGTI's size is computed from its own counts,
so readers that read SGTI by count (the viewer) are unaffected. Builds that do
not know the bit refuse the file as a forward version, as intended.

`SUSAMUNE_GHOST_REQUIRED_RNG_TAPE` is **provisional** (`0x00010000`), chosen
to stay clear of Moonshine's own numbering. Only that macro (and the Python
constant in `scripts/ghost_rng.py`) changes when a real bit or version is
assigned.

The largest V6 file plus the largest tape is exactly the existing V5 file
limit (0x13CE60), so no storage or transfer bound changed.

## Format

All integers big endian.

### Header (32 bytes)

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | magic `SGRN` (0x5347524E) |
| 4 | 2 | version 1 |
| 6 | 2 | header size 32 |
| 8 | 2 | caller count (≤ 255) |
| 10 | 2 | actor count (≤ 255) |
| 12 | 4 | stream size |
| 16 | 4 | flags |
| 20 | 4 | CRC-32 (zlib) of every byte after the header |
| 24 | 4 | number of rand() calls the stream describes |
| 28 | 4 | reserved, 0 |

Then the caller table, the actor table and the stream, back to back. The
chunk size is exactly `32 + 4·callers + 8·actors + stream`, at most
143,856 bytes.

**Callers** (4 bytes each): the return address of the call, i.e. the
instruction after the `bl rand`, in the source region's `main.dol` (region from
the ghost header). Unique and word aligned. When Moonshine's own RNG controls
roll on the game's behalf, they log the game's original call site.

**Actors** (8 bytes each), in the order each object first rolled:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | the object's vtable address (its class, via the region's symbol map) |
| 4 | 2 | `TNameRef::mKeyCode`, the hash of its scene name |
| 6 | 2 | reserved, 0 |

Several objects can share a class and name. Readers number them in table order
(the reference decoder's `ordinal`); matching one to a placed object is then the
viewer's job, e.g. by which of them rolls first. Object pointers are forgotten
at every segment change, so an address reused by the next scene is a new entry.

**Flags**

| Bit | Name | Meaning |
|---|---|---|
| 0x01 | TRUNCATED | the tape or a table filled; later calls are missing |
| 0x02 | LOST | a savestate load could not be reconciled; the stream is empty |
| 0x04 | FOREIGN_THREAD | some calls came from another thread (they carry no object) |
| 0x08 | CONTROLS | an outcome control without OVERRIDE ops was on |
| 0x10 | NO_ACTORS | object tracking was unavailable for some or all calls |

### Stream

| Op | Payload | Meaning |
|---|---|---|
| 0x00–0x7F | u8 caller, u8 actor ref | `op + 1` consecutive calls from one site and object |
| 0x80–0xBF | – | advance `op − 0x7F` frames (longer gaps repeat it) |
| 0xC1 SEED | u32 | generator state before the next call |
| 0xC2 QF | u32 | QF of the current frame |
| 0xC3 SEGMENT | u8 | ghost segment of the current frame (< 64) |
| 0xC4 OVERRIDE | u16 | the game received this value instead of the last roll |
| 0xC5 OVERRIDE_NODE | u8 actor ref, s16 node | the mod chose this object's next graph node |

Actor ref 0 means no object (outside any `testPerform`, or another thread);
`k` means actor-table entry `k − 1`. Every other op byte is invalid. A RUN
must follow a SEED; an OVERRIDE must follow a RUN. The stream always opens
with the SEED of the moment recording began.

Reading: keep `state`. For each call, `state = state * 0x41C64E6D + 0x3039`,
`value = (state >> 16) & 0x7FFF`. A SEED replaces `state`. The recorder writes
one whenever the live seed differs from the tape's prediction: a savestate load
without "Save RNG state", or anything else that touched it.

### Time

Frame 0 is the frame in which recording began. A frame is one call of the
game loop that ran gameplay; frozen frames (menus, frame-advance holds,
pause) are skipped. The reader keeps `cur` (QF of this frame), `prev` and
`step`:

- on each frame advance: `prev = cur`; `cur += step` if `cur` is known;
- on QF `v`: `step = v − prev` if `prev` is known; `cur = v`.

The recorder mirrors this model and writes a QF op only when the prediction is
wrong, so steady NTSC play costs nothing and PAL's 4/5-QF cadence costs a few
bytes per frame. QF is the ghost's own clock (the same mapping as poses and
inputs). Calls tagged QF `q` happen while the game advances from `q` to the
next frame. Frames where the recorder could not read the timer (stage loads)
carry the extrapolated QF. The tape is not trimmed to the ghost's
`[startQf, endQf]`; readers should clamp.

## Recorder (src/ghost_rng.cpp)

- **rand()**: its first instruction is patched to `b susamuneRngRand`, an exact
  reimplementation that reads LR before anything else, advances MSL `next`
  once, and logs only while a tape is armed. Results are bit-identical. Calls
  are serialized with interrupts off, since the stage loader thread also rolls.
- **Objects**: `JDrama::TViewObj::testPerform` gets an entry trampoline (only if
  its first word is a plain `stwu r1` or `mflr r0`, checked at install) that
  keeps a small stack of objects being performed. The innermost one on the main
  thread is the caller's object.
- **Arming**: `beginAttempt` starts a tape for every V6 recording. `frameControl`
  advances it once per unfrozen frame and stops it when recording stops, when
  Watch runs, or on failure. Race keeps recording the local player, so its tape
  is the player's own run; ghost playback never calls `rand()`.
- **Storage**: the slot's unused pose tail. A V6 track uses at most 17,983 of the
  slot's 26,974 pose samples, which leaves exactly 143,856 bytes at offset
  0x463F0, the SGRN budget. The tape therefore travels with its track when the
  record and playback slots swap, and needs no new memory owner. Importing a
  ghost into a slot forgets any tape there.
- **Export**: `exportLatest` appends the chunk after SGTI and sets the bit.
- **Savestates**: the rewind state rides in the ghost's savestate sidecar,
  words 104–127 after the prefix (older builds ignore them). The tape is
  append-only, so a saved prefix is intact unless a later load rewound below it
  and new calls overwrote it. Without per-save history this is judged
  conservatively: a load is accepted if nothing was loaded since that save, or
  if no load ever rewound shorter than its prefix; a tape id rejects states
  whose tape sat in the other ghost slot. Otherwise the tape becomes LOST.
  Repeatedly reloading one practice state always works.
- **Controls**: the Ricco fruit and crane rolls go through
  `susamuneRngRandFrom(gameLR)`; a fruit result that differs from its roll adds
  OVERRIDE; Petey route, blue-bird and Gelato fish patterns add OVERRIDE_NODE.

## Validation

- **PPC** (`validCanonicalFile`, catalog): exact feature set; the tape's header
  must describe exactly the bytes after SGTI. The file checksums cover them.
- **ARM kernel** (`SusamuneGhost.c`): exact feature set; SGTI sized from its
  counts; the tape gets the full structural check
  (`SusamuneGhostRngChunkValid`, shared header) and its CRC before the
  chunked pass; the pass then only checksums it. Any other unknown bit is still
  a forward version.
- **Host**: `scripts/ghost_rng.py` (reference decoder/encoder, mirrors the C
  check) and `scripts/validate_ghost.py`.

## Builds

| Build | Tape |
|---|---|
| US, PAL (V2.3.3) | on, with savestate rewind |
| JP (V2.3.3) | **compiled out** (`SUSAMUNE_GHOST_RNG 0`) |

The clean V2.3.3 JP `mod_jp.bin` is 548,824 bytes against a ceiling of 548,864
(`SUSAMUNE_JP_UI_OFFSET`: the Japanese UI asset follows the mod in MEM2
staging, and that asset has 1,824 bytes of slack). The recorder and its hooks need
about 4–4.5 KB of code, so JP cannot take it without moving that asset or the model
vault. With the tape compiled out, the JP `mod_jp.bin` is byte-identical to
a clean V2.3.3 build. `SUSAMUNE_GHOST_RNG_REWIND 0` drops savestate rewind
(about 700 bytes) for a build that needs the room.

## Evidence

- All three regions build with Moonshine's own toolchain (the bundled Kuribo
  clang and binutils, run under Wine on Linux). US and PAL link with the tape,
  inside their span and staging limits; JP is byte-identical to clean V2.3.3;
  the Dolphin US objects compile.
- `scripts/test_ghost_rng.py` (27 tests):
  - the reference codec: MSL values, run merging, PAL cadence and lag, long
    gaps, overrides, seed breaks and rejections;
  - the shared C validator agrees with the reference on 1,600 mutated chunks;
  - whole files through `validate_ghost.py`, including the maximum size;
  - the production ARM validator, extracted and built for the host;
  - **`src/ghost_rng.cpp` executed as big-endian PowerPC under qemu-ppc**
    (`scripts/ghost_rng_ppc/`), with stub game memory at the US addresses. It
    runs the real patched `rand()` entry and the `testPerform` trampoline with
    nested objects and a loader-thread call, plus a savestate save, an
    abandoned future, a restore and replay, a seed break, a segment change, an
    unsafe rewind and a state from another tape (both LOST). Every roll, call site, object, frame, QF and segment
    is checked.
- The rest of the Python suite is unchanged against clean V2.3.3. Its Windows
  compiler/DLL tests error identically in both trees on Linux.

Not yet verified: anything in the real game. There is no run on Dolphin or a
Wii, no launcher build (devkitPro was unavailable), and no measurement of
real rand() volume. The first in-game step is a short US/PAL recording to
measure calls per frame across a few stages: that decides whether 143,856 bytes
holds a full ten-minute run or truncates (TRUNCATED is set and the viewer falls
back past the end).

## Porting to the dev build

1. **Find the tape a new home.** In the dev tree, V8's camera keys occupy the
   pose tail this branch uses (offset 287,728, 127,520 bytes). The remaining
   tail is 16,336 bytes, which is too small. Pick a region with an owner check
   in `mem2_map.h` that also travels with record/playback swaps (or swap it
   explicitly where the samples/segments/inputs pointers swap).
2. **Budget the file.** V8 already spends 127,520 bytes of the room below the
   shared limit, leaving 16,336 bytes for SGRN. Either raise the shared file and
   transfer limits or cap the tape (it already truncates cleanly). Measure real
   volume first.
3. **Chunk order.** Put SGRN after SGCA, so V8 readers that locate SGCA from
   SGTI keep working; validators find SGRN from SGCA's size.
4. **Number it.** Replace the provisional bit with a real one (or a version)
   in `ghost_rng.h` and `scripts/ghost_rng.py`, and in the three exact-set
   checks (PPC validator, catalog, ARM header).
5. **Savestate words.** Snapshot 18's ghost sidecar layout decides where the 24
   rewind words go; V8 already uses reserved metadata words 126/127.
6. **JP space.** The dev JP package has about 2,080 bytes of headroom, so it
   needs the same staging change as V2.3.3 JP (or `SUSAMUNE_GHOST_RNG 0`).
7. **Keep the separations** from the camera work: tape only while recording,
   never during Watch; Race/online keep their own simulation; nothing on the
   playback side calls `rand()`.

Files: `include/susamune/ghost_rng.h` (format, shared validator),
`include/susamune/ghost_rng.hxx` + `src/ghost_rng.cpp` (recorder), integration
in `src/ghost.cpp`, `src/ghost_storage.cpp`, `src/rng_control.cpp`,
`src/ricco_fruit.cpp`, `src/pattern_selector.cpp`,
`src/gelato_patterns.cpp`, `launcher/kernel/SusamuneGhost.c`, and
`scripts/{ghost_rng.py, validate_ghost.py, test_ghost_rng.py, ghost_rng_ppc/}`.
`scripts/link_mod.py` gets a one-line fix that lets the mod link on Linux.
