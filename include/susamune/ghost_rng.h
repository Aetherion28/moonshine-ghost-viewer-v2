#ifndef SUSAMUNE_GHOST_RNG_H
#define SUSAMUNE_GHOST_RNG_H

/*
 * SGRN: the RNG tape. An optional chunk appended after a V6 ghost's SGTI
 * teaching chunk that records every call to the game's libc rand() made
 * while the ghost was recording, so an offline viewer can regenerate the
 * exact rolls each object received. See doc/ghost-rng-tape.md.
 *
 * Shared by the PPC mod, the ARM kernel and host tools: freestanding C, no
 * library calls, every integer big endian, untrusted bytes are decoded
 * rather than cast.
 *
 * PROVISIONAL: the required-feature bit below is a placeholder chosen to stay
 * clear of Moonshine's own numbering. Dogecyanide assigns the real version
 * and bit when this is merged; only these two macros need to change.
 */

#define SUSAMUNE_GHOST_REQUIRED_RNG_TAPE 0x00010000u

#define SUSAMUNE_GHOST_RNG_MAGIC 0x5347524Eu /* 'SGRN' */
#define SUSAMUNE_GHOST_RNG_VERSION 1u
#define SUSAMUNE_GHOST_RNG_HEADER_SIZE 32u
#define SUSAMUNE_GHOST_RNG_MAX_CALLERS 255u
#define SUSAMUNE_GHOST_RNG_MAX_ACTORS 255u
#define SUSAMUNE_GHOST_RNG_CALLER_SIZE 4u
#define SUSAMUNE_GHOST_RNG_ACTOR_SIZE 8u

/* The chunk may take exactly the room a maximum V6 file leaves below the
 * shared V5 file limit, so no transfer/storage bound changes. */
#define SUSAMUNE_GHOST_RNG_MAX_SIZE 0x000231F0u /* 143,856 bytes */

/* MSL rand.c, identical in all three retail revisions. */
#define SUSAMUNE_GHOST_RNG_LCG_MUL 0x41C64E6Du /* 1103515245 */
#define SUSAMUNE_GHOST_RNG_LCG_ADD 0x00003039u /* 12345 */

/* Header flags. */
#define SUSAMUNE_GHOST_RNG_TRUNCATED      0x01u /* tape filled; later calls missing */
#define SUSAMUNE_GHOST_RNG_LOST           0x02u /* stopped after an unreconcilable state load */
#define SUSAMUNE_GHOST_RNG_FOREIGN_THREAD 0x04u /* some calls came from another thread */
#define SUSAMUNE_GHOST_RNG_CONTROLS       0x08u /* an outcome control without OVERRIDE ops was on */
#define SUSAMUNE_GHOST_RNG_NO_ACTORS      0x10u /* object tracking was unavailable */
#define SUSAMUNE_GHOST_RNG_SEEDS_ONLY     0x20u /* only LOAD/SEED/SEGMENT: calls are not logged */
#define SUSAMUNE_GHOST_RNG_FLAGS          0x3Fu

/* Stream opcodes. */
#define SUSAMUNE_GHOST_RNG_OP_RUN_MAX       0x7Fu /* 0x00-0x7F: op+1 calls, u8 caller, u8 actor ref */
#define SUSAMUNE_GHOST_RNG_OP_FRAME         0x80u /* 0x80-0xBF: advance op-0x7F frames (longer gaps repeat it) */
#define SUSAMUNE_GHOST_RNG_OP_FRAME_MAX     0xBFu
#define SUSAMUNE_GHOST_RNG_OP_SEED          0xC1u /* u32 generator state before the next call */
#define SUSAMUNE_GHOST_RNG_OP_QF            0xC2u /* u32 QF of the current frame */
#define SUSAMUNE_GHOST_RNG_OP_SEGMENT       0xC3u /* u8 ghost segment of the current frame */
#define SUSAMUNE_GHOST_RNG_OP_OVERRIDE      0xC4u /* u16 value the game got instead of the last roll */
#define SUSAMUNE_GHOST_RNG_OP_OVERRIDE_NODE 0xC5u /* u8 actor ref, s16 graph node chosen by the mod */
#define SUSAMUNE_GHOST_RNG_OP_LOAD          0xC6u /* u32 load seed, u32 wait rolls, u32 setup seed, u32 untaped rolls */
#define SUSAMUNE_GHOST_RNG_WAIT_UNKNOWN     0xFFFFFFFFu

#define SUSAMUNE_GHOST_RNG_MAX_RUN 128u
#define SUSAMUNE_GHOST_RNG_MAX_FRAME_SHORT 64u

struct SusamuneGhostRngHeader {
    unsigned int   magic;
    unsigned short version;
    unsigned short headerSize;
    unsigned short callerCount;
    unsigned short actorCount;
    unsigned int   streamSize;
    unsigned int   flags;
    unsigned int   checksum;   /* CRC-32 of every byte after this header */
    unsigned int   callCount;  /* rand() calls the stream describes */
    unsigned int   reserved;
};

/* One tracked object: the innermost JDrama::TViewObj being performed when it
 * called rand(). vtable is the object's first word (identifies its class via
 * the source region's symbol map); keyCode is TNameRef::mKeyCode (the hash of
 * its scene name). Entries are in first-roll order; `ordinal` is reserved
 * (zero) and readers number repeated (vtable, keyCode) pairs themselves. */
struct SusamuneGhostRngActor {
    unsigned int   vtable;
    unsigned short keyCode;
    unsigned short ordinal; /* reserved, 0 */
};

static inline unsigned int SusamuneGhostRngNext(unsigned int state) {
    return state * SUSAMUNE_GHOST_RNG_LCG_MUL + SUSAMUNE_GHOST_RNG_LCG_ADD;
}
/* rand()'s return value for the state *after* the call advanced it. */
static inline unsigned int SusamuneGhostRngValue(unsigned int state) {
    return (state >> 16) & 0x7FFFu;
}

static inline unsigned int SusamuneGhostRngBe32(const unsigned char *p) {
    return ((unsigned int)p[0] << 24) | ((unsigned int)p[1] << 16) |
           ((unsigned int)p[2] << 8) | p[3];
}
static inline unsigned int SusamuneGhostRngBe16(const unsigned char *p) {
    return ((unsigned int)p[0] << 8) | p[1];
}

/* Total chunk size implied by a header that has passed the field checks. */
static inline unsigned int SusamuneGhostRngChunkSize(const unsigned char *p) {
    return SUSAMUNE_GHOST_RNG_HEADER_SIZE +
           SusamuneGhostRngBe16(p + 8) * SUSAMUNE_GHOST_RNG_CALLER_SIZE +
           SusamuneGhostRngBe16(p + 10) * SUSAMUNE_GHOST_RNG_ACTOR_SIZE +
           SusamuneGhostRngBe32(p + 12);
}

/* Structural validation of a whole chunk of exactly `size` bytes: header,
 * tables and every stream opcode. The caller checks the header CRC with its
 * own CRC-32 (bytes [32, size)). Returns 1 when valid. Linear in size. */
static inline int SusamuneGhostRngChunkValid(const unsigned char *p,
                                             unsigned int size) {
    unsigned int callers, actors, stream, flags, calls, i, j, at, end;
    unsigned int counted = 0;
    int seeded = 0, rolled = 0;
    const unsigned char *table;

    if (!p || size < SUSAMUNE_GHOST_RNG_HEADER_SIZE ||
        size > SUSAMUNE_GHOST_RNG_MAX_SIZE ||
        SusamuneGhostRngBe32(p) != SUSAMUNE_GHOST_RNG_MAGIC ||
        SusamuneGhostRngBe16(p + 4) != SUSAMUNE_GHOST_RNG_VERSION ||
        SusamuneGhostRngBe16(p + 6) != SUSAMUNE_GHOST_RNG_HEADER_SIZE)
        return 0;
    callers = SusamuneGhostRngBe16(p + 8);
    actors = SusamuneGhostRngBe16(p + 10);
    stream = SusamuneGhostRngBe32(p + 12);
    flags = SusamuneGhostRngBe32(p + 16);
    calls = SusamuneGhostRngBe32(p + 24);
    if (callers > SUSAMUNE_GHOST_RNG_MAX_CALLERS ||
        actors > SUSAMUNE_GHOST_RNG_MAX_ACTORS ||
        (flags & ~SUSAMUNE_GHOST_RNG_FLAGS) ||
        SusamuneGhostRngBe32(p + 28) != 0 ||
        stream > SUSAMUNE_GHOST_RNG_MAX_SIZE ||
        SusamuneGhostRngChunkSize(p) != size)
        return 0;

    /* Callers: nonzero, word aligned, unique. */
    table = p + SUSAMUNE_GHOST_RNG_HEADER_SIZE;
    for (i = 0; i < callers; ++i) {
        const unsigned int address = SusamuneGhostRngBe32(table + i * 4);
        if (address == 0 || (address & 3u)) return 0;
        for (j = 0; j < i; ++j)
            if (SusamuneGhostRngBe32(table + j * 4) == address) return 0;
    }
    /* Actors: nonzero vtable; the ordinal word is reserved (readers number
     * repeated (vtable, keyCode) pairs themselves, in table order). */
    table += callers * SUSAMUNE_GHOST_RNG_CALLER_SIZE;
    for (i = 0; i < actors; ++i) {
        const unsigned char *a = table + i * SUSAMUNE_GHOST_RNG_ACTOR_SIZE;
        if (SusamuneGhostRngBe32(a) == 0 || SusamuneGhostRngBe16(a + 6) != 0)
            return 0;
    }

    at = size - stream;
    end = size;
    while (at < end) {
        const unsigned int op = p[at++];
        if (op <= SUSAMUNE_GHOST_RNG_OP_RUN_MAX) {
            if (end - at < 2 || !seeded || p[at] >= callers ||
                p[at + 1] > actors)
                return 0;
            counted += op + 1u;
            if (counted < op + 1u) return 0;
            rolled = 1;
            at += 2;
        } else if (op <= SUSAMUNE_GHOST_RNG_OP_FRAME_MAX) {
            /* nothing to read */
        } else if (op == SUSAMUNE_GHOST_RNG_OP_SEED ||
                   op == SUSAMUNE_GHOST_RNG_OP_QF) {
            if (end - at < 4) return 0;
            if (op == SUSAMUNE_GHOST_RNG_OP_SEED) seeded = 1;
            at += 4;
        } else if (op == SUSAMUNE_GHOST_RNG_OP_SEGMENT) {
            if (end - at < 1 || p[at] >= 64u) return 0;
            at += 1;
        } else if (op == SUSAMUNE_GHOST_RNG_OP_OVERRIDE) {
            if (end - at < 2 || !rolled ||
                SusamuneGhostRngBe16(p + at) > 0x7FFFu)
                return 0;
            at += 2;
        } else if (op == SUSAMUNE_GHOST_RNG_OP_LOAD) {
            if (end - at < 16) return 0;
            at += 16;
        } else if (op == SUSAMUNE_GHOST_RNG_OP_OVERRIDE_NODE) {
            if (end - at < 3 || p[at] > actors) return 0;
            at += 3;
        } else {
            return 0;
        }
    }
    return counted == calls;
}

typedef char SusamuneGhostRngHeaderSize[
    sizeof(struct SusamuneGhostRngHeader) == SUSAMUNE_GHOST_RNG_HEADER_SIZE
        ? 1 : -1];
typedef char SusamuneGhostRngActorSize[
    sizeof(struct SusamuneGhostRngActor) == SUSAMUNE_GHOST_RNG_ACTOR_SIZE
        ? 1 : -1];

#endif
