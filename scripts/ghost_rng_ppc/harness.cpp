// Runs the production RNG tape recorder (src/ghost_rng.cpp) on big-endian
// PowerPC under qemu-ppc, with game memory stubbed at the US addresses.
//
// It installs the real hooks (rand() and TViewObj::testPerform are patched in
// place in the stub memory), calls rand through the patched game entry from
// several call sites and scene objects, saves and restores mid-tape, and
// prints the exported SGRN chunk plus every value rand() returned, as hex
// lines on stdout. scripts/test_ghost_rng.py decodes and compares them.

#include "Dolphin/OS.h"
#include "Dolphin/types.h"
#include "JSystem/JDrama/JDRViewObj.hxx"
#include "susamune/addresses.hxx"
#include "susamune/ghost_rng.h"
#include "susamune/ghost_rng.hxx"
#include "susamune/settings.hxx"

extern "C" {
void *memcpy(void *d, const void *s, unsigned long n) {
    u8 *a = (u8 *)d; const u8 *b = (const u8 *)s;
    while (n--) *a++ = *b++;
    return d;
}
void *memset(void *d, int c, unsigned long n) {
    u8 *a = (u8 *)d;
    while (n--) *a++ = (u8)c;
    return d;
}
}

// --- Linux syscalls -------------------------------------------------------
static long sys3(long n, long a, long b, long c) {
    register long r0 asm("r0") = n;
    register long r3 asm("r3") = a;
    register long r4 asm("r4") = b;
    register long r5 asm("r5") = c;
    asm volatile("sc" : "+r"(r3), "+r"(r0) : "r"(r4), "r"(r5)
                 : "memory", "cr0", "r6", "r7", "r8", "r9", "r10", "r11", "r12");
    return r3;
}
static void out(const char *s, u32 n) { sys3(4, 1, (long)s, n); }
static void outs(const char *s) { u32 n = 0; while (s[n]) ++n; out(s, n); }
static void hex(const u8 *p, u32 n) {
    static const char digits[] = "0123456789abcdef";
    char line[129];
    while (n) {
        u32 k = n < 64 ? n : 64;
        for (u32 i = 0; i < k; ++i) {
            line[2 * i] = digits[p[i] >> 4];
            line[2 * i + 1] = digits[p[i] & 15];
        }
        line[2 * k] = '\n';
        out(line, 2 * k + 1);
        p += k;
        n -= k;
    }
}
static void word(const char *tag, u32 v) {
    u8 b[4] = {(u8)(v >> 24), (u8)(v >> 16), (u8)(v >> 8), (u8)v};
    outs(tag);
    hex(b, 4);
}

// --- Stubs for the game and the rest of the mod ---------------------------
static OSThread sThreads[2];
static u32 sCurrentThread;
static bool sInterruptsOn = true;
extern "C" OSThread *OSGetCurrentThread() { return &sThreads[sCurrentThread]; }
extern "C" bool OSDisableInterrupts() { bool was = sInterruptsOn; sInterruptsOn = false; return was; }
extern "C" void OSRestoreInterrupts(bool on) { sInterruptsOn = on; }
static OSTime sNow = 0x123456789ll;
extern "C" OSTime OSGetTime() { return sNow += 0x10001; }
extern "C" void DCFlushRange(void *, size_t) {}
extern "C" void ICInvalidateRange(void *, size_t) {}
void writeGameCode(u32 addr, u32 w) { *reinterpret_cast<volatile u32 *>(addr) = w; }
u32 branchWord(u32 from, u32 to) { return 0x48000000u | ((to - from) & 0x03FFFFFCu); }

alignas(32) static u8 sSettingsStorage[4096];
Settings &gSettings = *reinterpret_cast<Settings *>(sSettingsStorage);

// Game memory for the US build lives in a NOLOAD section at 0x80000000
// (harness.ld); the stub testPerform is copied over the retail entry.
typedef void (*PerformFn)(void *object);
extern "C" PerformFn gPerform;
PerformFn gPerform;
extern "C" __attribute__((section("fake_test_perform"), noinline)) void
fakeTestPerform(void *object, u32, void *) {
    gPerform(object);
}
extern "C" char __start_fake_test_perform[], __stop_fake_test_perform[];

const u32 kRandSite = SUSAMUNE_MEM1_ADDR(0x80085AC4u, 0x8033B1A4u, 0x80333324u);
const u32 kTestPerformSite = SUSAMUNE_MEM1_ADDR(0x80046F6Cu, 0x802FCC94u, 0x802F4E24u);
typedef int (*RandFn)();
typedef void (*TestPerformFn)(void *, u32, void *);

static volatile u32 &seed() {
    return *reinterpret_cast<volatile u32 *>(SUSAMUNE_ADDR_LIBC_RAND_SEED);
}

// Each site is a distinct call instruction, so a distinct return address.
static u32 sValues[4096];
static u32 sValueCount;
__attribute__((noinline)) static void siteA() { sValues[sValueCount++] = reinterpret_cast<RandFn>(kRandSite)(); }
__attribute__((noinline)) static void siteB() { sValues[sValueCount++] = reinterpret_cast<RandFn>(kRandSite)(); }
__attribute__((noinline)) static void siteC() { sValues[sValueCount++] = susamuneRngRandFrom(0x80001234u); }

struct FakeObject {   // JDrama::TNameRef / TViewObj layout
    u32 vtable;
    const char *name;
    u16 keyCode;
    u16 pad;
    u16 performFlags;
};
static FakeObject sChomp = {0x803C1000u, "chomp", 0x1234, 0, 0};
static FakeObject sPianta = {0x803C2000u, "pianta", 0x0042, 0, 0};
static FakeObject sManager = {0x803C3000u, "manager", 0x0777, 0, 0};

static void performChomp(void *object) {
    (void)object;
    siteA();
    siteA();
}
static void performManager(void *object) {
    (void)object;
    // A manager performs a child, then rolls itself after the child returns.
    gPerform = performChomp;
    reinterpret_cast<TestPerformFn>(kTestPerformSite)(&sChomp, 1, nullptr);
    gPerform = performManager;
    siteB();
}

static u8 *sTape;
alignas(32) static u8 sOut[0x24000];

static void frame(u32 qf, u8 segment) {
    GhostRng::frameStart(true, true, qf, segment);
}

static void play(u32 first, u32 count, u8 segment) {
    for (u32 f = first; f < first + count; ++f) {
        frame(1000 + f * 4 + (f > 30 ? 1 : 0), segment);
        gPerform = performManager;
        reinterpret_cast<TestPerformFn>(kTestPerformSite)(&sManager, 1, nullptr);
        if (f % 3 == 0) siteB();  // outside any object
        if (f % 7 == 0) {
            siteC();
            GhostRng::noteOverride(0x6000);
            sValues[sValueCount - 1] |= 0x80000000u;  // mark: game got 0x6000
        }
        if (f == 9) GhostRng::noteNodeOverride(&sPianta, 5);
        if (f == 12) {
            sCurrentThread = 1;  // a loader thread call
            siteA();
            sCurrentThread = 0;
        }
    }
}

extern "C" int main() {
    // Settings stay zero: no outcome controls.
    const u32 size = __stop_fake_test_perform - __start_fake_test_perform;
    memcpy(reinterpret_cast<void *>(kTestPerformSite), __start_fake_test_perform, size);
    seed() = 0x0BADF00Du;
    GhostRng::init();
    word("hook_rand ", *reinterpret_cast<volatile u32 *>(kRandSite));
    word("site_a ", reinterpret_cast<u32>(&siteA));

    alignas(32) static u8 slot[0x80000];
    sTape = GhostRng::tapeFor(slot);
    GhostRng::begin(sTape);

    play(0, 20, 0);

    // Savestate: capture, play an abandoned future, restore, replay.
    GhostRng::Saved saved;
    GhostRng::capture(saved);
    const u32 savedSeed = seed();
    const u32 savedValues = sValueCount;
    play(20, 15, 0);
    seed() = savedSeed;  // "Save RNG state" on: the state brings the seed back
    sValueCount = savedValues;
    GhostRng::restore(saved, sTape);
    play(20, 25, 0);
    // A load with the seed not restored, then a stage change.
    seed() = 0x12345678u;
    play(45, 10, 1);

    u32 n = 0;
    if (!GhostRng::exportChunk(sTape, sOut, sizeof(sOut), &n)) {
        outs("export failed\n");
        return 2;
    }
    // Second tape: rewinding below a later state's prefix and re-recording
    // makes that later state unusable (LOST); the earlier one stays valid.
    alignas(32) static u8 slot2[0x80000];
    u8 *tape2 = GhostRng::tapeFor(slot2);
    const u32 keepValues = sValueCount;
    GhostRng::begin(tape2);
    play(0, 5, 0);
    GhostRng::Saved s1, s2;
    GhostRng::capture(s1);
    play(5, 5, 0);
    GhostRng::capture(s2);
    GhostRng::restore(s1, tape2);  // valid: nothing restored since s1
    play(5, 3, 0);                 // overwrites what s2 relied on
    GhostRng::restore(s1, tape2);  // valid again: floor is s1's prefix
    play(5, 2, 0);
    u32 m = 0;
    GhostRng::exportChunk(tape2, sOut, sizeof(sOut), &m);
    word("relo_flags ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->flags);
    GhostRng::restore(s2, tape2);  // s2 is past the floor after a rewind: LOST
    GhostRng::exportChunk(tape2, sOut, sizeof(sOut), &m);
    word("lost_flags ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->flags);
    word("lost_stream ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->streamSize);
    // A state from one tape restored onto another (the slots swapped).
    alignas(32) static u8 slot3[0x80000];
    u8 *tape3 = GhostRng::tapeFor(slot3);
    GhostRng::begin(tape3);
    play(0, 3, 0);
    GhostRng::restore(s1, tape3);
    GhostRng::exportChunk(tape3, sOut, sizeof(sOut), &m);
    word("cross_flags ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->flags);
    // A reload across a scene change: segment 1 reuses the same addresses
    // (new entries); reloading into segment 0 must reuse segment 0's entries.
    alignas(32) static u8 slot4[0x80000];
    u8 *tape4 = GhostRng::tapeFor(slot4);
    GhostRng::begin(tape4);
    play(0, 2, 0);
    GhostRng::Saved s4;
    GhostRng::capture(s4);
    play(2, 2, 1);
    GhostRng::exportChunk(tape4, sOut, sizeof(sOut), &m);
    word("scene_actors ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->actorCount);
    GhostRng::restore(s4, tape4);
    play(2, 3, 0);
    GhostRng::exportChunk(tape4, sOut, sizeof(sOut), &m);
    word("reload_actors ", reinterpret_cast<SusamuneGhostRngHeader *>(sOut)->actorCount);
    sValueCount = keepValues;
    // Re-export the first tape for the main checks.
    GhostRng::exportChunk(sTape, sOut, sizeof(sOut), &n);

    outs("values\n");
    for (u32 i = 0; i < sValueCount; ++i) word("", sValues[i]);
    outs("chunk\n");
    hex(sOut, n);
    outs("end\n");
    return 0;
}

extern "C" __attribute__((naked, section(".text.start"))) void _start() {
    asm volatile(
        "lis 1, stack_top@ha\n"
        "addi 1, 1, stack_top@l\n"
        "bl main\n"
        "li 0, 1\n"
        "sc\n");
}
