// RNG tape recorder for ghosts. See include/susamune/ghost_rng.h for the
// SGRN format and doc/ghost-rng-tape.md for the design.
//
// rand() is replaced at its entry by an exact reimplementation that, while a
// tape is armed, also logs who called it. The game's results are unchanged:
// the same LCG runs on the same MSL `next` word, once per call.

#include "susamune/ghost_rng.hxx"

#include "Dolphin/OS.h"
#include "Dolphin/mem.h"
#include "Dolphin/string.h"
#include "Dolphin/types.h"
#include "JSystem/JDrama/JDRViewObj.hxx"
#include "susamune/addresses.hxx"
#include "susamune/checksum.hxx"
#include "susamune/features.hxx"
#include "susamune/ghost_format.h"
#include "susamune/ghost_rng.h"
#include "susamune/settings.hxx"

#if SUSAMUNE_GHOST_RNG

// The per-call path lives in the low span; setup, export and savestate code
// in the upper (.foxtrot) span. JP V2.3.3 has little room in either.

namespace {

const u32 kRandSite = SUSAMUNE_MEM1_ADDR(0x80085AC4u, 0x8033B1A4u, 0x80333324u);
const u32 kTestPerformSite =
    SUSAMUNE_MEM1_ADDR(0x80046F6Cu, 0x802FCC94u, 0x802F4E24u);

// Live tape layout inside the slot's pose tail. Tables are kept at their
// maximum size and compacted on export.
const u32 kLiveMagic = 0x53475257u;  // 'SGRW'
const u32 kLiveSize = 32;
const u32 kCallersAt = kLiveSize;
const u32 kActorsAt = kCallersAt + SUSAMUNE_GHOST_RNG_MAX_CALLERS * 4;
const u32 kPointersAt = kActorsAt + SUSAMUNE_GHOST_RNG_MAX_ACTORS * 8;
const u32 kStreamAt = kPointersAt + SUSAMUNE_GHOST_RNG_MAX_ACTORS * 4;
const u32 kStreamCapacity = GhostRng::kTapeSize - kStreamAt;
static_assert(GhostRng::kTapeOffset + GhostRng::kTapeSize ==
                  SUSAMUNE_GHOST_MAX_SAMPLE_DATA_SIZE,
              "RNG tape must end where the slot's pose area ends");
static_assert(GhostRng::kTapeSize == SUSAMUNE_GHOST_RNG_MAX_SIZE,
              "RNG tape and SGRN chunk budgets differ");
static_assert(SUSAMUNE_GHOST_RNG_HEADER_SIZE + SUSAMUNE_GHOST_RNG_MAX_CALLERS * 4 +
                  SUSAMUNE_GHOST_RNG_MAX_ACTORS * 8 + kStreamCapacity <=
                  SUSAMUNE_GHOST_RNG_MAX_SIZE,
              "a full tape must export within the SGRN budget");

struct Live {
    u32 magic;
    u16 callers;
    u16 actors;
    u32 streamSize;
    u32 flags;
    u32 calls;
    u32 rewinds;      // savestate restores applied to this tape
    u32 rewindFloor;  // shortest stream any restore rewound to
    u32 id;           // which recording this tape belongs to
};
static_assert(sizeof(Live) == kLiveSize, "live tape header changed");

struct Writer {
    u8 *tape;
    u32 predicted;      // MSL `next` the tape expects before the next call
    u32 lastRun;        // offset of the open RUN op, 0 when none
    u32 pendingFrames;  // frames advanced but not yet written
    u32 cur;            // reader's QF model, mirrored exactly
    u32 prev;
    u32 step;
    u8 curKnown;
    u8 prevKnown;
    u8 segment;
    u8 armed;
    u8 lastCaller;
    u8 lastActor;
};

Writer sW;
u32 sTapeSerial;
u32 sTestPerformTrampoline[2];
const JDrama::TViewObj *sPerforming[8];
u32 sPerformDepth;
OSThread *sMainThread;

inline Live &live(u8 *tape) { return *reinterpret_cast<Live *>(tape); }
inline u32 *callers(u8 *tape) {
    return reinterpret_cast<u32 *>(tape + kCallersAt);
}
inline SusamuneGhostRngActor *actors(u8 *tape) {
    return reinterpret_cast<SusamuneGhostRngActor *>(tape + kActorsAt);
}
inline const void **pointers(u8 *tape) {
    return reinterpret_cast<const void **>(tape + kPointersAt);
}

void stopWith(u32 flag) {
    if (sW.tape) live(sW.tape).flags |= flag;
    sW.armed = 0;
}

#pragma clang section text=".foxtrot.text"
bool reserve(u32 bytes) {
    if (live(sW.tape).streamSize + bytes <= kStreamCapacity) return true;
    stopWith(SUSAMUNE_GHOST_RNG_TRUNCATED);
    return false;
}

u8 *streamEnd() { return sW.tape + kStreamAt + live(sW.tape).streamSize; }

#pragma clang section text=""
bool flushFrames() {
    while (sW.pendingFrames) {
        const u32 frames = sW.pendingFrames < SUSAMUNE_GHOST_RNG_MAX_FRAME_SHORT
            ? sW.pendingFrames : SUSAMUNE_GHOST_RNG_MAX_FRAME_SHORT;
        if (!reserve(1)) return false;
        *streamEnd() = static_cast<u8>(0x7Fu + frames);
        live(sW.tape).streamSize += 1;
        sW.pendingFrames -= frames;
    }
    sW.lastRun = 0;
    return true;
}

#pragma clang section text=".foxtrot.text"
// Writes op + big-endian payload (payloadBytes of value's low bytes).
bool emit(u8 op, u32 value, u32 payloadBytes) {
    if (!flushFrames() || !reserve(1 + payloadBytes)) return false;
    u8 *p = streamEnd();
    p[0] = op;
    for (u32 i = 0; i < payloadBytes; ++i)
        p[1 + i] = static_cast<u8>(value >> (8 * (payloadBytes - 1 - i)));
    live(sW.tape).streamSize += 1 + payloadBytes;
    sW.lastRun = 0;
    return true;
}

#pragma clang section text=""
// Caller index, or -1 when the table is full (the tape stops). A linear
// search: the open run already covers repeated calls from one site.
s32 callerIndex(u32 address) {
    Live &l = live(sW.tape);
    u32 *table = callers(sW.tape);
    for (u32 i = 0; i < l.callers; ++i)
        if (table[i] == address) return i;
    if (l.callers >= SUSAMUNE_GHOST_RNG_MAX_CALLERS) {
        stopWith(SUSAMUNE_GHOST_RNG_TRUNCATED);
        return -1;
    }
    table[l.callers] = address;
    return l.callers++;
}

// Actor reference: 0 for none, otherwise table index + 1. Pointers are
// forgotten at each scene change, so a recycled address is a new entry.
u8 actorRef(const void *object) {
    if (!object) return 0;
    const u32 vtable = *static_cast<const u32 *>(object);
    const u16 key = static_cast<const JDrama::TViewObj *>(object)->mKeyCode;
    Live &l = live(sW.tape);
    for (u32 i = 0; i < l.actors; ++i)
        if (pointers(sW.tape)[i] == object && actors(sW.tape)[i].vtable == vtable &&
            actors(sW.tape)[i].keyCode == key)
            return static_cast<u8>(i + 1);
    if (l.actors >= SUSAMUNE_GHOST_RNG_MAX_ACTORS) {
        l.flags |= SUSAMUNE_GHOST_RNG_NO_ACTORS;
        return 0;
    }
    SusamuneGhostRngActor &entry = actors(sW.tape)[l.actors];
    entry.vtable = vtable;
    entry.keyCode = key;
    entry.ordinal = 0;
    pointers(sW.tape)[l.actors] = object;
    return static_cast<u8>(++l.actors);
}

#pragma clang section text=".foxtrot.text"
bool outcomeControlsActive() {
    return gSettings.getBool(SETTING_KING_BOO_ALWAYS_FRUIT) ||
           gSettings.getBool(SETTING_PETEY_NO_TORNADO) ||
           gSettings.get(SETTING_RICCO_CRANE_SPEED) != 0;
}

#pragma clang section text=""
// The innermost scene object being performed on the main thread, if any.
const void *performing() {
    if (OSGetCurrentThread() != sMainThread) {
        if (sW.tape) live(sW.tape).flags |= SUSAMUNE_GHOST_RNG_FOREIGN_THREAD;
        return nullptr;
    }
    return sPerformDepth ? sPerforming[(sPerformDepth <= 8 ? sPerformDepth : 8) - 1]
                         : nullptr;
}

void logCall(u32 returnAddress, u32 state) {
    if (state != sW.predicted &&
        !emit(SUSAMUNE_GHOST_RNG_OP_SEED, state, 4))
        return;
    sW.predicted = SusamuneGhostRngNext(state);
    const s32 caller = callerIndex(returnAddress);
    if (caller < 0) return;
    const u8 actor = actorRef(performing());
    Live &l = live(sW.tape);
    u8 *stream = sW.tape + kStreamAt;
    if (sW.lastRun && !sW.pendingFrames &&
        stream[sW.lastRun] < SUSAMUNE_GHOST_RNG_OP_RUN_MAX &&
        sW.lastCaller == caller && sW.lastActor == actor) {
        ++stream[sW.lastRun];
    } else {
        if (!flushFrames() || !reserve(3)) return;
        u8 *p = streamEnd();
        p[0] = 0;
        p[1] = static_cast<u8>(caller);
        p[2] = actor;
        // Offset 0 is the tape's opening SEED, so a RUN is never at 0.
        sW.lastRun = l.streamSize;
        l.streamSize += 3;
        sW.lastCaller = static_cast<u8>(caller);
        sW.lastActor = actor;
    }
    ++l.calls;
}

int randFrom(u32 returnAddress) {
    volatile u32 *seed =
        reinterpret_cast<volatile u32 *>(SUSAMUNE_ADDR_LIBC_RAND_SEED);
    const bool enabled = OSDisableInterrupts();
    const u32 state = *seed;
    const u32 next = SusamuneGhostRngNext(state);
    *seed = next;
    if (sW.armed) logCall(returnAddress, state);
    OSRestoreInterrupts(enabled);
    return static_cast<int>(SusamuneGhostRngValue(next));
}

}  // namespace

// Entered by a plain `b` patched over rand()'s first instruction, so LR is
// still the game's return address.
extern "C" int susamuneRngRand() {
    return randFrom(reinterpret_cast<u32>(__builtin_return_address(0)));
}

extern "C" int susamuneRngRandFrom(u32 returnAddress) {
    return randFrom(returnAddress);
}

extern "C" void susamuneRngTestPerform(JDrama::TViewObj *object, u32 flags,
                                       JDrama::TGraphics *graphics) {
    typedef void (*TestPerformFn)(JDrama::TViewObj *, u32, JDrama::TGraphics *);
    if (sPerformDepth < 8) sPerforming[sPerformDepth] = object;
    ++sPerformDepth;
    reinterpret_cast<TestPerformFn>(sTestPerformTrampoline)(object, flags, graphics);
    --sPerformDepth;
}

#pragma clang section text=".foxtrot.text"
namespace GhostRng {

void init() {
    sMainThread = OSGetCurrentThread();
    const u32 first = *reinterpret_cast<volatile const u32 *>(kTestPerformSite);
    // Relocate only a plain prologue store or LR move into the trampoline.
    if ((first & 0xFFFF0000u) == 0x94210000u || first == 0x7C0802A6u) {
        sTestPerformTrampoline[0] = first;
        sTestPerformTrampoline[1] = branchWord(
            reinterpret_cast<u32>(&sTestPerformTrampoline[1]), kTestPerformSite + 4);
        DCFlushRange(sTestPerformTrampoline, sizeof(sTestPerformTrampoline));
        ICInvalidateRange(sTestPerformTrampoline, sizeof(sTestPerformTrampoline));
        writeGameCode(kTestPerformSite,
                      branchWord(kTestPerformSite,
                                 reinterpret_cast<u32>(&susamuneRngTestPerform)));
    }
    writeGameCode(kRandSite, branchWord(kRandSite,
                                        reinterpret_cast<u32>(&susamuneRngRand)));
}

// Ghost slots are always mapped; the record and playback tracks never have a
// null sample base.
u8 *tapeFor(const void *slotBase) {
    return const_cast<u8 *>(static_cast<const u8 *>(slotBase)) + kTapeOffset;
}

void reset(u8 *tape) {
    if (sW.tape == tape) sW.armed = 0;
    live(tape).magic = 0;
}

void begin(u8 *tape) {
    memset(&sW, 0, sizeof(sW));
    memset(tape, 0, kStreamAt);
    Live &l = live(tape);
    l.magic = kLiveMagic;
    l.id = ++sTapeSerial;
    if (!sTestPerformTrampoline[0]) l.flags |= SUSAMUNE_GHOST_RNG_NO_ACTORS;
    if (outcomeControlsActive()) l.flags |= SUSAMUNE_GHOST_RNG_CONTROLS;
    sW.tape = tape;
    sW.armed = 1;
    // The opening SEED; frameStart reports the QF and any segment change.
    const bool enabled = OSDisableInterrupts();
    sW.predicted = *reinterpret_cast<volatile u32 *>(SUSAMUNE_ADDR_LIBC_RAND_SEED);
    emit(SUSAMUNE_GHOST_RNG_OP_SEED, sW.predicted, 4);
    OSRestoreInterrupts(enabled);
}

void frameStart(bool armed, bool qfKnown, u32 qf, u8 segment) {
    if (!armed) sW.armed = 0;
    if (!sW.armed) return;
    const bool enabled = OSDisableInterrupts();
    ++sW.pendingFrames;
    sW.lastRun = 0;
    sW.prev = sW.cur;
    sW.prevKnown = sW.curKnown;
    if (sW.curKnown) sW.cur += sW.step;
    if (qfKnown && (!sW.curKnown || sW.cur != qf)) {
        if (emit(SUSAMUNE_GHOST_RNG_OP_QF, qf, 4)) {
            if (sW.prevKnown) sW.step = qf - sW.prev;
            sW.cur = qf;
            sW.curKnown = 1;
        }
    }
    if (sW.armed && segment < 64 && segment != sW.segment &&
        emit(SUSAMUNE_GHOST_RNG_OP_SEGMENT, segment, 1)) {
        sW.segment = segment;
        // A new scene recycles the heap: never match old object pointers.
        memset(pointers(sW.tape), 0, SUSAMUNE_GHOST_RNG_MAX_ACTORS * 4);
    }
    OSRestoreInterrupts(enabled);
}

void stop() { sW.armed = 0; }

// Both note functions run on the main thread right after the call they
// describe, from code that already holds the game's own ordering.
void noteOverride(u32 value) {
    if (sW.armed)
        emit(SUSAMUNE_GHOST_RNG_OP_OVERRIDE, value & 0x7FFFu, 2);
}

void noteNodeOverride(const void *object, s32 node) {
    if (!sW.armed) return;
    const u32 actor = actorRef(object ? object : performing());
    emit(SUSAMUNE_GHOST_RNG_OP_OVERRIDE_NODE,
         (actor << 16) | (static_cast<u32>(node) & 0xFFFFu), 3);
}

bool exportChunk(const u8 *tape, u8 *out, u32 capacity, u32 *size) {
    *size = 0;
    const Live &l = *reinterpret_cast<const Live *>(tape);
    const u32 callerBytes = l.callers * 4u;
    const u32 actorBytes = l.actors * 8u;
    const u32 total = SUSAMUNE_GHOST_RNG_HEADER_SIZE + callerBytes + actorBytes +
                      l.streamSize;
    if (l.magic != kLiveMagic || l.streamSize > kStreamCapacity ||
        total > capacity)
        return false;
    SusamuneGhostRngHeader &h = *reinterpret_cast<SusamuneGhostRngHeader *>(out);
    u8 *body = out + SUSAMUNE_GHOST_RNG_HEADER_SIZE;
    memcpy(body, tape + kCallersAt, callerBytes);
    memcpy(body + callerBytes, tape + kActorsAt, actorBytes);
    memcpy(body + callerBytes + actorBytes, tape + kStreamAt, l.streamSize);
    h.magic = SUSAMUNE_GHOST_RNG_MAGIC;
    h.version = SUSAMUNE_GHOST_RNG_VERSION;
    h.headerSize = SUSAMUNE_GHOST_RNG_HEADER_SIZE;
    h.callerCount = l.callers;
    h.actorCount = l.actors;
    h.streamSize = l.streamSize;
    h.flags = l.flags;
    h.checksum = Checksum::crc32(body, total - SUSAMUNE_GHOST_RNG_HEADER_SIZE);
    h.callCount = l.calls;
    h.reserved = 0;
    *size = total;
    return true;
}

#if SUSAMUNE_GHOST_RNG_REWIND
struct SavedLayout {
    Live live;
    Writer writer;  // writer.tape is not trusted on restore
    u32 runByte;    // the open RUN's count byte when saved
};
const u32 kSavedMagic = 0x53475253u;  // 'SGRS', replaces live.magic
static_assert(sizeof(SavedLayout) <= sizeof(Saved), "RNG tape savestate words overflow");

void capture(Saved &out) {
    memset(&out, 0, sizeof(out));
    if (!sW.tape) return;
    SavedLayout &saved = *reinterpret_cast<SavedLayout *>(&out);
    const bool enabled = OSDisableInterrupts();
    memcpy(&saved.live, sW.tape, sizeof(Live));
    saved.live.magic = kSavedMagic;
    memcpy(&saved.writer, &sW, sizeof(sW));
    saved.runByte = sW.tape[kStreamAt + sW.lastRun];
    OSRestoreInterrupts(enabled);
}

// The tape is append-only, so a saved prefix is intact unless a later restore
// rewound below it and new calls were written over it. Without per-save
// history this is decided conservatively: intact if nothing was restored since
// the save, or if no restore ever rewound shorter than the saved prefix.
void restore(const Saved &in, u8 *tape) {
    const SavedLayout &saved = *reinterpret_cast<const SavedLayout *>(&in);
    const bool enabled = OSDisableInterrupts();
    memset(&sW, 0, sizeof(sW));
    if (tape && live(tape).magic == kLiveMagic) {
        Live &l = live(tape);
        const Live &was = saved.live;
        const u32 run = saved.writer.lastRun;
        // The id rejects a state whose tape sat in the other ghost slot.
        if (was.magic == kSavedMagic && was.id == l.id &&
            was.streamSize <= l.streamSize &&
            was.callers <= l.callers && was.actors <= l.actors &&
            run + 3 <= was.streamSize + (run ? 0u : 3u) &&
            (was.rewinds == l.rewinds || was.streamSize <= l.rewindFloor)) {
            const u32 rewinds = l.rewinds + 1;
            const u32 floor = l.rewinds && l.rewindFloor < was.streamSize
                ? l.rewindFloor : was.streamSize;
            if (run) tape[kStreamAt + run] = static_cast<u8>(saved.runByte);
            memcpy(&l, &was, sizeof(Live));
            l.magic = kLiveMagic;
            l.rewinds = rewinds;
            l.rewindFloor = floor;
            memcpy(&sW, &saved.writer, sizeof(sW));
            sW.tape = tape;
        } else {
            // Keep nothing that could be wrong.
            memset(tape, 0, kStreamAt);
            l.magic = kLiveMagic;
            l.flags = SUSAMUNE_GHOST_RNG_LOST;
        }
    }
    OSRestoreInterrupts(enabled);
}
#else
// No room for rewind in this build: a loaded state ends the tape.
void capture(Saved &out) { memset(&out, 0, sizeof(out)); }

void restore(const Saved &, u8 *tape) {
    sW.armed = 0;
    if (live(tape).magic == kLiveMagic) {
        memset(tape, 0, kStreamAt);
        live(tape).magic = kLiveMagic;
        live(tape).flags = SUSAMUNE_GHOST_RNG_LOST;
    }
}
#endif

// Acceptance for the game, which never reads the stream: the header must
// describe exactly `size` bytes. The file's own checksums already cover these
// bytes; the storage kernel and host tools run SusamuneGhostRngChunkValid.
bool chunkPlausible(const u8 *p, u32 size) {
    const SusamuneGhostRngHeader &h = *reinterpret_cast<const SusamuneGhostRngHeader *>(p);
    // The caller bounds `size` by the file limit, which keeps the sum exact;
    // the sum is at least a header, so a shorter chunk cannot match. (A short
    // chunk's header read stays inside the caller's file buffer.)
    return h.magic == SUSAMUNE_GHOST_RNG_MAGIC &&
           h.version == SUSAMUNE_GHOST_RNG_VERSION &&
           h.headerSize == SUSAMUNE_GHOST_RNG_HEADER_SIZE &&
           h.streamSize <= SUSAMUNE_GHOST_RNG_MAX_SIZE &&
           SUSAMUNE_GHOST_RNG_HEADER_SIZE + h.callerCount * 4u +
                   h.actorCount * 8u + h.streamSize == size;
}

}  // namespace GhostRng

#pragma clang section text=""

#endif  // SUSAMUNE_GHOST_RNG
