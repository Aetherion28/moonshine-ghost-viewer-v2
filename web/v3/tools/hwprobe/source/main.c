// wiiprobe: a Wii program that does jobs for web/v3's hardware questions and gives back the results.
// A job is a script (made by web/v3/tests/hwprobe.ts; format in ../script.ts): blocks of memory to set, GPU commands
// that go to the GPU's command stream as they are (only addresses are set to where the blocks are), "save this
// block" marks, reads of memory and registers, and small pieces of PowerPC code to run.
// Jobs come from a server on the home network (../server.py on a PC): this program connects out to it (address and
// key in sd:/apps/wiiprobe/server.txt), asks for the next job, runs it and sends the answer. A script on the SD card
// (sd:/apps/wiiprobe/script.gxps, answered in answer.gxpo beside it) is run first if there.
// If a job stops the program for 90 seconds, it writes what it was doing and the GPU's state to
// sd:/apps/wiiprobe/crash.log, tries to tell the server, and restarts the console (with Priiloader set to start this
// program, it comes back by itself and hands the log over). Before every case of a script and every piece of code
// it runs, it sends what it has so far, so the server knows where a job that never finished had got to.
// Holding RESET or a GameCube controller button as it starts leaves to the Wii menu.
// It writes nothing but the SD script's answer and that log. Built with devkitPPC and libogc (see ../Makefile).
#include <gccore.h>
#include <fat.h>
#include <network.h>
#include <malloc.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ogc/machine/processor.h>
#include <ogc/lwp_watchdog.h>
#include <setjmp.h>
#include "rle.h"
#include "sha256.h"

// (hosttest/ builds this file for a PC with these replaced, to check the script and network handling)
#ifndef HOSTTEST
#include <tuxedo/ppc/exception.h>
#define FIFO8(v) (wgPipe->U8 = (v))
#define FIFO32(v) (wgPipe->U32 = (v))
#define HW16(a) (*(vu16 *)(a))
#define HW32(a) (*(vu32 *)(a))
#define PHYSICAL(p) MEM_VIRTUAL_TO_PHYSICAL(p)
#define CODE_READY(p, n) do { DCFlushRange(p, n); ICInvalidateRange(p, n); } while (0)
#define APPDIR "sd:/apps/wiiprobe"
#endif

enum { OP_END, OP_MEM, OP_FIFO, OP_BPADDR, OP_SYNC, OP_DUMP, OP_CPADDR, OP_READ16, OP_NOTE, OP_MEMRLE, OP_QUIT, OP_PEEK, OP_READ32, OP_CODE, OP_CALL, OP_EXTENSION = 32 };
enum { REC_CONSOLE = 100, REC_END = 101, REC_STOPPED = 102, REC_PROGRESS = 103, REC_FAULT = 104 };
#define MAGIC_SCRIPT 0x47585053 /* GXPS */
#define MAGIC_ANSWER 0x4758504F /* GXPO */
#define VERSION 3
#ifndef BUILD_ID
#define BUILD_ID 0
#endif
#define FIFO_SIZE (512 * 1024)
#define PAYLOAD_MAX (128 * 1024)
#define DUMP_PACK_MAX (512 * 1024)
#define ARENA_SIZE (8 * 1024 * 1024)
#define CODE_SIZE (1024 * 1024)
#define OUT_BUF (32 * 1024)
#ifndef WATCHDOG_SECONDS
#define WATCHDOG_SECONDS 90
#endif
#define W(a, b, c, d) (((u32)(a) << 24) | ((b) << 16) | ((c) << 8) | (d))

extern void __exception_setreload(int seconds);
static void *xfb;
static GXRModeObj *rmode;
static u8 payload[PAYLOAD_MAX] ATTRIBUTE_ALIGN(32);
static u8 packed[DUMP_PACK_MAX + DUMP_PACK_MAX / 128 + 16];
static u8 code[CODE_SIZE] ATTRIBUTE_ALIGN(32);
static u8 *arena;

// ---- sd:/apps/wiiprobe/server.txt: lines of name=value (host, port, key)
static char cfg_host[32], cfg_key[128];
static int cfg_port = 4300;
#define CRASH_LOG APPDIR "/crash.log"

// ---- what the program is doing (for the log of a hang)
static struct { u32 job, op_index, op; char note[96]; } doing;
static char report[1024];
static void make_report(const char *what) {
    snprintf(report, sizeof report,
        "wiiprobe %d build %08x: %s\n"
        "job %u, operation %u (kind %u), case: %s\n"
        "GPU command processor: status %04x control %04x; fifo base %04x%04x end %04x%04x write %04x%04x read %04x%04x distance %04x%04x breakpoint %04x%04x\n"
        "CPU fifo: base %08x end %08x write %08x; pixel engine interrupts %04x\n",
        VERSION, (unsigned)BUILD_ID, what, (unsigned)doing.job, (unsigned)doing.op_index, (unsigned)doing.op, doing.note,
        HW16(0xCC000000), HW16(0xCC000002), HW16(0xCC000022), HW16(0xCC000020), HW16(0xCC000026), HW16(0xCC000024), HW16(0xCC000036), HW16(0xCC000034),
        HW16(0xCC00003A), HW16(0xCC000038), HW16(0xCC000032), HW16(0xCC000030), HW16(0xCC00003E), HW16(0xCC00003C),
        (unsigned)HW32(0xCC00300C), (unsigned)HW32(0xCC003010), (unsigned)HW32(0xCC003014), HW16(0xCC00100A));
}
static int send_all(s32 sock, const void *p, u32 n);
static volatile int reported;
// (its own thread: writing the card or reaching the server may itself never return)
static void *reporter(void *arg) {
    FILE *f = fopen(CRASH_LOG, "ab");
    if (f) { fputs(report, f); fclose(f); }
    s32 s = net_socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET; addr.sin_port = htons(cfg_port); addr.sin_addr.s_addr = inet_addr(cfg_host);
    if (s >= 0 && cfg_host[0] && net_connect(s, (struct sockaddr *)&addr, sizeof addr) >= 0) {
        u32 h[2] = { W('C', 'L', 'W', 'L'), strlen(report) };
        int sent = send_all(s, h, 8) && send_all(s, report, h[1]);
        net_close(s);
        if (sent) remove(CRASH_LOG);   // (the server has it: no need to hand it over after the restart)
    }
    reported = 1;
    return NULL;
}

// ---- the watchdog: while armed, 90 seconds without a beat: the log, then the console restarts
static volatile u64 last_beat;
static volatile int armed;
static void beat(void) { last_beat = gettime(); }
static void restart_console(void) {
    SYS_ResetSystem(SYS_RESTART, 0, 0);
    for (;;) HW32(0xCC003024) = 0;   // (should that return: the reset line itself)
}
static void *watchdog(void *arg) {
    for (;;) {
        sleep(1);
        if (armed && diff_sec(last_beat, gettime()) > WATCHDOG_SECONDS) {
            make_report("no progress for 90 seconds; restarting the console");
            printf("\n%s", report);
            lwp_t t;
            LWP_CreateThread(&t, reporter, NULL, NULL, 32 * 1024, 90);
            for (int i = 0; i < 8 && !reported; i++) sleep(1);
            restart_console();
        }
    }
    return NULL;
}

// ---- where a script comes from and its answer goes: a file pair, or the connection to the server
typedef struct { FILE *in, *out; s32 sock; u32 left; u8 buf[OUT_BUF]; u32 fill; int failed; } IO;
static IO io;

static int recv_all(s32 sock, void *p, u32 n) {
    u8 *d = p;
    while (n) {
        s32 r = net_recv(sock, d, n > 8192 ? 8192 : n, 0);
        if (r <= 0) return 0;
        d += r; n -= r; beat();
    }
    return 1;
}
static int send_all(s32 sock, const void *p, u32 n) {
    const u8 *s = p;
    while (n) {
        s32 r = net_send(sock, s, n > 4096 ? 4096 : n, 0);
        if (r <= 0) return 0;
        s += r; n -= r; beat();
    }
    return 1;
}
static int io_read(void *p, u32 n) {
    if (io.in) return fread(p, 1, n, io.in) == n;
    if (n > io.left || !recv_all(io.sock, p, n)) return 0;
    io.left -= n;
    return 1;
}
static void io_flush(void) {
    if (io.fill && !io.failed) {
        if (io.out) { if (fwrite(io.buf, 1, io.fill, io.out) != io.fill) io.failed = 1; }
        else { u32 h[2] = { W('D', 'A', 'T', 'A'), io.fill }; if (!send_all(io.sock, h, 8) || !send_all(io.sock, io.buf, io.fill)) io.failed = 1; }
    }
    io.fill = 0;
}
static void io_write(const void *p, u32 n) {
    const u8 *s = p;
    while (n) {
        u32 k = OUT_BUF - io.fill;
        if (k > n) k = n;
        memcpy(io.buf + io.fill, s, k);
        io.fill += k; s += k; n -= k;
        if (io.fill == OUT_BUF) io_flush();
    }
}
static void put32(u32 v) { io_write(&v, 4); }
static void record(u32 kind, u32 a, u32 b, const void *data, u32 len) {
    static const u8 zero[4];
    put32(kind); put32(a); put32(b); put32(len);
    if (len) io_write(data, len);
    if (len & 3) io_write(zero, 4 - (len & 3));
}

// ---- code sent by a job. Its entry: u32 entry(const Services *, u32 argument). It is linked for the address of the
// code buffer and may call anything in this program by address (the build's wiiprobe.elf has the symbols; all of
// libogc is linked in for that). It can stay: a job may leave a handler for operations from OP_EXTENSION on, which
// later jobs then use (until the console restarts).
typedef const char *(*Extension)(u32 op, u32 a, u32 b, u8 *payload, u32 len);
static Extension extension;
static void set_extension(Extension e) { extension = e; }
typedef struct {
    u32 version;
    u8 *arena; u32 arena_size;
    u8 *code; u32 code_size;
    void (*record)(u32 kind, u32 a, u32 b, const void *data, u32 len);
    void (*flush)(void);
    int (*print)(const char *fmt, ...);
    void (*beat)(void);
    void (*set_extension)(Extension e);
} Services;
static Services services = { VERSION, NULL, ARENA_SIZE, code, CODE_SIZE, record, io_flush, printf, beat, set_extension };

// ---- faults. In code a job sent (guarded): the registers go into the answer and the job goes on with its next
// operation. Anywhere else: the registers go to the crash log (card and server) and the console restarts.
static struct { u32 exid, pc, msr, lr, cr, ctr, xer, dar, dsisr, gpr[32]; } fault;
#ifndef HOSTTEST
static jmp_buf guard;
static volatile int guarded, crashing;
static u8 fault_stack[32 * 1024] ATTRIBUTE_ALIGN(32);
static PPCExcptPanicFn libogc_panic;
static void fault_landing(void) { longjmp(guard, 1); }
static void crash_landing(void) {
    // (an ordinary thread again, on a stack of its own: say what happened where it can be read later, and restart)
    make_report("a fault in the program itself; restarting the console");
    snprintf(report + strlen(report), sizeof report - strlen(report), "exception %u at %08x, LR %08x, MSR %08x, DAR %08x, DSISR %08x, r1 %08x, r3 %08x r4 %08x r5 %08x\n",
        (unsigned)fault.exid, (unsigned)fault.pc, (unsigned)fault.lr, (unsigned)fault.msr, (unsigned)fault.dar, (unsigned)fault.dsisr, (unsigned)fault.gpr[1], (unsigned)fault.gpr[3], (unsigned)fault.gpr[4], (unsigned)fault.gpr[5]);
    printf("\n%s", report);
    lwp_t t;
    LWP_CreateThread(&t, reporter, NULL, NULL, 32 * 1024, 90);
    for (int i = 0; i < 8 && !reported; i++) sleep(1);
    sleep(5);   // (time to read the screen, or to hold RESET for what starts the program)
    restart_console();
}
// (called by libogc's exception entry with the faulting context; returning resumes that context as it then is)
static void on_fault(unsigned exid, PPCContext *ctx) {
    u32 sda2, sda;
    __asm__("mr %0,2" : "=r"(sda2));
    __asm__("mr %0,13" : "=r"(sda));
    if ((!guarded && crashing) || exid == PPC_EXCPT_IRQ || exid == PPC_EXCPT_DECR) { libogc_panic(exid, ctx); return; }
    fault.exid = exid; fault.pc = ctx->pc; fault.msr = ctx->msr; fault.lr = ctx->lr; fault.cr = ctx->cr; fault.ctr = ctx->ctr; fault.xer = ctx->xer;
    fault.dar = mfspr(DAR); fault.dsisr = mfspr(DSISR);
    memcpy(fault.gpr, ctx->gpr, sizeof fault.gpr);
    if (guarded) { guarded = 0; ctx->pc = (u32)fault_landing; }
    else { crashing = 1; ctx->pc = (u32)crash_landing; }
    u32 *sp = (u32 *)(fault_stack + sizeof fault_stack - 64);
    sp[0] = 0;
    ctx->gpr[1] = (u32)sp; ctx->gpr[2] = sda2; ctx->gpr[13] = sda;
    ctx->msr |= MSR_EE | MSR_RI | MSR_IR | MSR_DR;
}
#define GUARDED_CALL(call, faulted) do { if (setjmp(guard) == 0) { guarded = 1; call; guarded = 0; faulted = 0; } else faulted = 1; } while (0)
#else
#define GUARDED_CALL(call, faulted) do { call; faulted = 0; } while (0)
#endif

// Runs one script. Returns 0 to go on, else what the script asks: 1 leave to the Wii menu, 2 restart the console.
static int run_script(void) {
    u32 head[4], ops = 0, dumps = 0;
    int quit = 0;
    const char *why = NULL;
    if (!io_read(head, 16) || head[0] != MAGIC_SCRIPT || head[1] != 1) { printf("Not a script of this version.\n"); return 0; }
    put32(MAGIC_ANSWER); put32(1); put32(VERSION); put32(BUILD_ID);
    u32 info[4] = { SYS_GetHollywoodRevision(), mfpvr(), (u32)(size_t)arena, (u32)(size_t)code };
    record(REC_CONSOLE, 0, 0, info, sizeof info);
    if (head[2] > ARENA_SIZE) why = "The script needs more memory than there is.";
    while (!why) {
        u32 h[4];
        if (!io_read(h, 16)) { why = "The script ends early."; break; }
        u32 op = h[0], a = h[1], b = h[2], len = h[3], padded = (len + 3) & ~3;
        if (padded > PAYLOAD_MAX) { why = "An operation is too big."; break; }
        if (padded && !io_read(payload, padded)) { why = "The script ends early."; break; }
        if (op == OP_END) break;
        ops++;
        beat();
        doing.op_index = ops; doing.op = op;
        switch (op) {
        case OP_MEM:
            if (a > ARENA_SIZE || len > ARENA_SIZE - a) { why = "A block is outside the arena."; break; }
            memcpy(arena + a, payload, len);
            DCFlushRange(arena + (a & ~31), ((a & 31) + len + 31) & ~31);
            break;
        case OP_MEMRLE:
            if (a > ARENA_SIZE || b > ARENA_SIZE - a) { why = "A block is outside the arena."; break; }
            if (!rle_decode(payload, len, arena + a, b)) { why = "A packed block is damaged."; break; }
            DCFlushRange(arena + (a & ~31), ((a & 31) + b + 31) & ~31);
            break;
        case OP_FIFO:
            for (u32 i = 0; i < len; i++) FIFO8(payload[i]);
            break;
        case OP_BPADDR:
            FIFO8(0x61);
            FIFO32((a << 24) | ((PHYSICAL(arena + b) >> 5) & 0x00FFFFFF));
            break;
        case OP_CPADDR:
            FIFO8(0x08);
            FIFO8((u8)a);
            FIFO32(PHYSICAL(arena + (s32)b));
            break;
        case OP_SYNC:
            GX_DrawDone();
            break;
        case OP_DUMP:
            if (a > ARENA_SIZE || b > ARENA_SIZE - a) { why = "A block is outside the arena."; break; }
            // (the GPU wrote this memory, not the CPU: drop what the cache holds of it)
            DCInvalidateRange(arena + (a & ~31), ((a & 31) + b + 31) & ~31);
            if (b <= DUMP_PACK_MAX) {
                u32 n = rle_encode(arena + a, b, packed);
                if (n < b) record(OP_MEMRLE, a, b, packed, n); else record(OP_DUMP, a, b, arena + a, b);
            } else record(OP_DUMP, a, b, arena + a, b);
            dumps++;
            break;
        case OP_READ16: {
            u16 v[64];
            if (b > 64) b = 64;
            for (u32 i = 0; i < b; i++) v[i] = HW16(a + 2 * i);
            record(OP_READ16, a, b, v, 2 * b);
            break;
        }
        case OP_READ32: {
            u32 v[64];
            if (b > 64) b = 64;
            for (u32 i = 0; i < b; i++) v[i] = HW32(a + 4 * i);
            record(OP_READ32, a, b, v, 4 * b);
            break;
        }
        case OP_PEEK:
            // (ordinary memory, by its address)
            if (b > PAYLOAD_MAX) b = PAYLOAD_MAX;
            memcpy(payload, (const void *)(size_t)a, b);
            record(OP_PEEK, a, b, payload, b);
            break;
        case OP_CODE:
            if (a > CODE_SIZE || len > CODE_SIZE - a) { why = "Code outside its buffer."; break; }
            memcpy(code + a, payload, len);
            CODE_READY(code + (a & ~31), ((a & 31) + len + 31) & ~31);
            break;
        case OP_CALL: {
            if (a >= CODE_SIZE) { why = "Code outside its buffer."; break; }
            // (should it never come back: the server has everything up to here)
            record(REC_PROGRESS, ops, a, "call", 4);
            io_flush();
            volatile u32 r = 0;
            int faulted;
            services.arena = arena;
            GUARDED_CALL(r = ((u32 (*)(const Services *, u32))(code + a))(&services, b), faulted);
            if (faulted) { record(REC_FAULT, a, b, &fault, sizeof fault); printf("\nA fault in a job's code at %08x (exception %u).\n", (unsigned)fault.pc, (unsigned)fault.exid); }
            else { u32 v = r; record(OP_CALL, a, b, &v, 4); }
            break;
        }
        case OP_NOTE:
            // a case begins: its name on the screen and in the answer, and the answer so far sent
            payload[len < PAYLOAD_MAX ? len : PAYLOAD_MAX - 1] = 0;
            snprintf(doing.note, sizeof doing.note, "%.90s", (char *)payload);
            printf("\r%-70.70s", (char *)payload);
            record(REC_PROGRESS, ops, 0, payload, len);
            io_flush();
            break;
        case OP_QUIT:
            quit = a == 2 ? 2 : 1;
            break;
        default:
            if (op >= OP_EXTENSION && extension) {
                int faulted;
                const char *volatile e = NULL;
                GUARDED_CALL(e = extension(op, a, b, payload, len), faulted);
                if (faulted) { record(REC_FAULT, op, a, &fault, sizeof fault); extension = NULL; why = "A fault in the extension (it is switched off)."; }
                else if (e) why = e;
            } else why = "An unknown operation.";
            break;
        }
        if (io.failed) { why = "The answer could not be written."; break; }
    }
    GX_DrawDone();
    if (why) record(REC_STOPPED, 0, 0, why, strlen(why));
    record(REC_END, ops, dumps, NULL, 0);
    io_flush();
    printf("\n%s%s%u operations, %u blocks saved\n", why ? why : "", why ? " " : "", (unsigned)ops, (unsigned)dumps);
    return quit;
}

static void to_menu(void) { armed = 0; printf("Leaving to the Wii menu.\n"); SYS_ResetSystem(SYS_RETURNTOMENU, 0, 0); exit(0); }
static int button_held(void) { PAD_ScanPads(); return PAD_ButtonsHeld(0) || PAD_ButtonsHeld(1) || SYS_ResetButtonDown(); }
static void leave(const char *msg) {
    armed = 0;
    printf("\n%s\nPress RESET, or a button on a GameCube controller, to leave.\n", msg);
    while (!button_held()) VIDEO_WaitVSync();
    to_menu();
}
// (a pause that still answers the buttons)
static void wait_seconds(int s) { for (int i = 0; i < s * 60; i++) { if (button_held()) to_menu(); VIDEO_WaitVSync(); } }

static int read_config(void) {
    FILE *f = fopen(APPDIR "/server.txt", "rb");
    if (!f) return 0;
    char line[256];
    while (fgets(line, sizeof line, f)) {
        char *eq = strchr(line, '='), *end = line + strlen(line);
        while (end > line && (end[-1] == '\n' || end[-1] == '\r' || end[-1] == ' ')) *--end = 0;
        if (!eq) continue;
        *eq++ = 0;
        if (!strcmp(line, "host")) snprintf(cfg_host, sizeof cfg_host, "%s", eq);
        else if (!strcmp(line, "port")) cfg_port = atoi(eq);
        else if (!strcmp(line, "key")) snprintf(cfg_key, sizeof cfg_key, "%s", eq);
    }
    fclose(f);
    return cfg_host[0] && cfg_key[0];
}
// only a server on a home network: 10.x.x.x, 172.16-31.x.x, 192.168.x.x (127.x for the PC test)
static int private_address(u32 ip) {
    return (ip >> 24) == 10 || (ip >> 20) == 0xAC1 || (ip >> 16) == 0xC0A8 || (ip >> 24) == 127;
}

// One connection to the server: the greeting, then jobs until it breaks. Returns what a script asked (1, 2) or 0.
static int session(s32 sock) {
    u32 hello[12] = { W('C', 'L', 'W', '1'), VERSION, BUILD_ID, (u32)(size_t)code, CODE_SIZE, (u32)(size_t)arena, ARENA_SIZE, SYS_GetHollywoodRevision(), mfpvr(), 0, 0, 0 };
    u8 nonce[16], proof[32], want[32];
    u64 t = gettime();
    Sha256 sh;
    // (the nonce: the clock, hashed with what was left in the buffers)
    sha256_init(&sh); sha256_add(&sh, &t, sizeof t); sha256_add(&sh, io.buf, 64); sha256_add(&sh, payload, 64); sha256_end(&sh, want);
    memcpy(nonce, want, 16);
    u32 reply;
    if (!send_all(sock, hello, sizeof hello) || !send_all(sock, nonce, 16) || !recv_all(sock, &reply, 4) || !recv_all(sock, proof, 32)) { printf("The server did not answer the greeting.\n"); return 0; }
    sha256_init(&sh); sha256_add(&sh, cfg_key, strlen(cfg_key)); sha256_add(&sh, nonce, 16); sha256_end(&sh, want);
    if (reply != W('C', 'L', 'S', '1') || memcmp(proof, want, 32)) { printf("The server does not have the key in server.txt: not taking jobs from it.\n"); wait_seconds(20); return 0; }
    printf("Connected to %s. Waiting for jobs.\n", cfg_host);
    // the log of a restart, if one is waiting on the card
    FILE *f = fopen(CRASH_LOG, "rb");
    if (f) {
        u32 h[2] = { W('L', 'O', 'G', ' '), fread(payload, 1, 16384, f) };
        fclose(f);
        if (send_all(sock, h, 8) && send_all(sock, payload, h[1])) remove(CRASH_LOG);
    }
    for (;;) {
        u32 w = W('N', 'E', 'X', 'T'), r[3];
        armed = 1; beat();
        if (button_held()) to_menu();
        if (!send_all(sock, &w, 4) || !recv_all(sock, r, 4)) break;
        if (r[0] == W('I', 'D', 'L', 'E')) continue;
        if (r[0] != W('J', 'O', 'B', ' ') || !recv_all(sock, r + 1, 8)) break;
        printf("Job %u (%u bytes)\n", (unsigned)r[1], (unsigned)r[2]);
        memset(&io, 0, sizeof io); io.sock = sock; io.left = r[2];
        memset(&doing, 0, sizeof doing); doing.job = r[1];
        int quit = run_script();
        // (what the script did not read)
        while (io.left) { u32 k = io.left > PAYLOAD_MAX ? PAYLOAD_MAX : io.left; if (!recv_all(sock, payload, k)) break; io.left -= k; }
        u32 done[3] = { W('D', 'O', 'N', 'E'), r[1], (u32)quit };
        if (io.failed || io.left || !send_all(sock, done, 12)) break;
        if (quit) return quit;
    }
    armed = 0;
    printf("The connection to the server ended.\n");
    return 0;
}

int main(void) {
    VIDEO_Init();
    PAD_Init();
    rmode = VIDEO_GetPreferredMode(NULL);
    xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
    console_init(xfb, 20, 20, rmode->fbWidth, rmode->xfbHeight, rmode->fbWidth * VI_DISPLAY_PIX_SZ);
    VIDEO_Configure(rmode);
    VIDEO_SetNextFramebuffer(xfb);
    VIDEO_SetBlack(false);
    VIDEO_Flush();
    VIDEO_WaitVSync();
    if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();
    printf("\n\nwiiprobe %d (build %08x)\n", VERSION, (unsigned)BUILD_ID);
    printf("Hold RESET or a GameCube controller button now to leave to the Wii menu.\n");
    wait_seconds(2);

    arena = memalign(32, ARENA_SIZE);
    if (!arena) leave("Not enough memory.");
    memset(arena, 0, ARENA_SIZE);
    DCFlushRange(arena, ARENA_SIZE);
    void *fifo = memalign(32, FIFO_SIZE);
    memset(fifo, 0, FIFO_SIZE);
    GX_Init(fifo, FIFO_SIZE);
    beat();
    __exception_setreload(8);   // (a fault inside the fault handling: libogc's report for 8 seconds, then out of the program)
#ifndef HOSTTEST
    libogc_panic = PPCExcptCurPanicFn;
    PPCExcptCurPanicFn = on_fault;
#endif
    lwp_t wd;
    LWP_CreateThread(&wd, watchdog, NULL, NULL, 16 * 1024, 100);

    // ---- a script on the SD card, if there is one
    int sd = fatInitDefault();
    if (sd) {
        FILE *in = fopen(APPDIR "/script.gxps", "rb");
        if (in) {
            FILE *out = fopen(APPDIR "/answer.gxpo", "wb");
            if (out) {
                printf("Running sd:/apps/wiiprobe/script.gxps ...\n");
                memset(&io, 0, sizeof io); io.in = in; io.out = out; io.sock = -1;
                armed = 1; beat();
                run_script();
                armed = 0;
                fclose(out);
                printf("The answer is in sd:/apps/wiiprobe/answer.gxpo\n");
            } else printf("sd:/apps/wiiprobe/answer.gxpo could not be made.\n");
            fclose(in);
        }
    }

    // ---- jobs from the server
    if (!sd || !read_config()) leave("No apps/wiiprobe/server.txt on the SD card (the server on the PC writes one to copy there).");
    u32 host = inet_addr(cfg_host);
    if (host == INADDR_NONE || !private_address(ntohl(host))) leave("server.txt: host must be an address on the home network (like 192.168.1.20).");
    printf("Starting the network ...\n");
    char ip[16] = "", mask[16] = "", gw[16] = "";
    while (if_config(ip, mask, gw, true, 20) < 0) { printf("No network yet; trying again.\n"); wait_seconds(5); }
    printf("This console is %s. The server is %s port %d.\n", ip, cfg_host, cfg_port);
    for (int tries = 0;; tries++) {
        s32 s = net_socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof addr);
        addr.sin_family = AF_INET; addr.sin_port = htons(cfg_port); addr.sin_addr.s_addr = host;
        if (s >= 0 && net_connect(s, (struct sockaddr *)&addr, sizeof addr) >= 0) {
            tries = 0;
            int quit = session(s);
            net_close(s);
            if (quit == 2) { printf("Restarting the console.\n"); restart_console(); }
            if (quit) to_menu();
        } else {
            if (s >= 0) net_close(s);
            if (tries % 12 == 0) printf("The server is not answering (is server.py running on the PC?); trying every 5 seconds.\n");
        }
        wait_seconds(5);
    }
    return 0;
}
