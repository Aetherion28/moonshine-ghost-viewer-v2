#ifndef _SUSAMUNE_GHOST_RNG_HXX
#define _SUSAMUNE_GHOST_RNG_HXX

// RNG tape recorder: logs every libc rand() call made while a ghost records,
// with the calling code and the scene object being performed, so the SGRN
// chunk lets a viewer regenerate the exact rolls. Format: ghost_rng.h.
//
// The tape lives in the ghost slot's unused pose tail (a V6 track uses at most
// 17,983 of the slot's 26,974 pose samples), so it travels with the track
// when the record and playback slots swap and needs no new MEM1/MEM2 owner.

#include <Dolphin/types.h>

// Savestate rewind of an in-progress tape. A build without room for it can
// set this to 0: a loaded state then ends the tape (LOST).
#ifndef SUSAMUNE_GHOST_RNG_REWIND
#define SUSAMUNE_GHOST_RNG_REWIND 1
#endif

// The whole recorder. Moonshine V2.3.3's JP mod is within 40 bytes of its
// packed-size ceiling (the Japanese UI asset follows it in MEM2 staging), so
// JP builds compile the tape out until that layout makes room.
#ifndef SUSAMUNE_GHOST_RNG
#if defined(SUSAMUNE_VERSION_JP)
#define SUSAMUNE_GHOST_RNG 0
#else
#define SUSAMUNE_GHOST_RNG 1
#endif
#endif

#if SUSAMUNE_GHOST_RNG
namespace GhostRng {

// Byte offset of the tape inside a ghost slot and its size.
const u32 kTapeOffset = 0x000463F0u;  // 17,983 * 16
const u32 kTapeSize = 0x000231F0u;    // up to the end of the pose area

struct Saved {
    u32 words[24];
};

// Installs the rand() and TViewObj::testPerform entry hooks.
void init();

u8 *tapeFor(const void *slotBase);
// Forgets any tape in this slot (the slot's pose area is being reused).
void reset(u8 *tape);
// Starts a new tape for the recording that just began.
void begin(u8 *tape);
// Once per simulated game frame, before TMarDirector::direct().
void frameStart(bool armed, bool qfKnown, u32 qf, u8 segment);
// The recording ended or failed; the tape keeps what it has.
void stop();
// Builds the SGRN chunk for a finished track's tape. Returns false when the
// slot holds no tape for it. *size is 0 for "no chunk".
bool exportChunk(const u8 *tape, u8 *out, u32 capacity, u32 *size);

// The mod handed the game a different value than the roll just recorded.
void noteOverride(u32 value);
// The mod replaced this object's random graph choice with `node`. A null
// object means the scene object currently being performed.
void noteNodeOverride(const void *object, s32 node);

// Header shape only (file checksums cover the bytes); see
// SusamuneGhostRngChunkValid for the full check.
bool chunkPlausible(const u8 *chunk, u32 size);

void capture(Saved &out);
// Rewinds the tape with a loaded savestate; marks it lost if it cannot.
void restore(const Saved &in, u8 *tape);

}  // namespace GhostRng

// rand() for mod code that was itself reached from a game call site: logs the
// game's return address instead of the mod's.
extern "C" int susamuneRngRandFrom(u32 returnAddress);

#else

extern "C" int rand();

namespace GhostRng {
const u32 kTapeOffset = 0x000463F0u;
struct Saved { u32 words[24]; };
inline void init() {}
inline u8 *tapeFor(const void *) { return nullptr; }
inline void reset(u8 *) {}
inline void begin(u8 *) {}
inline void frameStart(bool, bool, u32, u8) {}
inline void stop() {}
inline bool exportChunk(const u8 *, u8 *, u32, u32 *size) { *size = 0; return false; }
inline void noteOverride(u32) {}
inline void noteNodeOverride(const void *, s32) {}
inline bool chunkPlausible(const u8 *, u32) { return false; }
inline void capture(Saved &) {}
inline void restore(const Saved &, u8 *) {}
}  // namespace GhostRng

__attribute__((always_inline)) inline int susamuneRngRandFrom(u32) { return rand(); }

#endif  // SUSAMUNE_GHOST_RNG

#endif  // _SUSAMUNE_GHOST_RNG_HXX
