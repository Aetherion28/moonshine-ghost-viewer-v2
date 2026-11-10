// hwprobe: feeds a Wii's GPU the commands of a script and gives back what it drew.
// A script (made by web/v3/tests/hwprobe.ts; format in ../script.ts) holds textures, GPU commands and "save this
// block" marks. Nothing here decides what is drawn: the commands go to the GPU's command stream as they are, only
// addresses are set to where the blocks are.
// Scripts come over the network (TCP port 4300: the script in, the answer back on the same connection; ../send.py)
// or from the SD card (sd:/apps/gxprobe/script.gxps, answered in answer.gxpo beside it), which is run first if there.
// Built with devkitPPC and libogc (see ../Makefile).
#include <gccore.h>
#include <fat.h>
#include <network.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ogc/machine/processor.h>
#include "rle.h"

// (hosttest/ builds this file for a PC with these four replaced, to check the script handling)
#ifndef HOSTTEST
#define FIFO8(v) (wgPipe->U8 = (v))
#define FIFO32(v) (wgPipe->U32 = (v))
#define HW16(a) (*(vu16 *)(a))
#define PHYSICAL(p) MEM_VIRTUAL_TO_PHYSICAL(p)
#endif

enum { OP_END, OP_MEM, OP_FIFO, OP_BPADDR, OP_SYNC, OP_DUMP, OP_CPADDR, OP_READ16, OP_NOTE, OP_MEMRLE, OP_QUIT };
#define MAGIC_SCRIPT 0x47585053 /* GXPS */
#define MAGIC_ANSWER 0x4758504F /* GXPO */
#define VERSION 2
#define PORT 4300
#define FIFO_SIZE (512 * 1024)
#define PAYLOAD_MAX (128 * 1024)
#define DUMP_PACK_MAX (512 * 1024)
#define ARENA_SIZE (8 * 1024 * 1024)
#define OUT_BUF (64 * 1024)

static void *xfb;
static GXRModeObj *rmode;
static u8 payload[PAYLOAD_MAX] ATTRIBUTE_ALIGN(32);
static u8 packed[DUMP_PACK_MAX + DUMP_PACK_MAX / 128 + 16];
static u8 *arena;

// ---- where a script comes from and its answer goes: a file pair or a connection
typedef struct { FILE *in, *out; s32 sock; u8 buf[OUT_BUF]; u32 fill; int failed; } IO;

static int io_read(IO *io, void *p, u32 n) {
    if (io->in) return fread(p, 1, n, io->in) == n;
    u8 *d = p;
    while (n) {
        s32 r = net_recv(io->sock, d, n > 8192 ? 8192 : n, 0);
        if (r <= 0) return 0;
        d += r; n -= r;
    }
    return 1;
}
static void io_flush(IO *io) {
    u32 at = 0;
    while (at < io->fill && !io->failed) {
        if (io->out) { if (fwrite(io->buf + at, 1, io->fill - at, io->out) != io->fill - at) io->failed = 1; break; }
        u32 n = io->fill - at;
        s32 r = net_send(io->sock, io->buf + at, n > 4096 ? 4096 : n, 0);
        if (r <= 0) io->failed = 1; else at += r;
    }
    io->fill = 0;
}
static void io_write(IO *io, const void *p, u32 n) {
    const u8 *s = p;
    while (n) {
        u32 k = OUT_BUF - io->fill;
        if (k > n) k = n;
        memcpy(io->buf + io->fill, s, k);
        io->fill += k; s += k; n -= k;
        if (io->fill == OUT_BUF) io_flush(io);
    }
}
static void put32(IO *io, u32 v) { io_write(io, &v, 4); }
static void record(IO *io, u32 kind, u32 a, u32 b, const void *data, u32 len) {
    static const u8 zero[4];
    put32(io, kind); put32(io, a); put32(io, b); put32(io, len);
    if (len) io_write(io, data, len);
    if (len & 3) io_write(io, zero, 4 - (len & 3));
}

// Runs one script. Returns 0 to go on, 1 if the script asks to leave.
static int run_script(IO *io) {
    u32 head[4], ops = 0, dumps = 0;
    int quit = 0;
    const char *why = NULL;
    if (!io_read(io, head, 16) || head[0] != MAGIC_SCRIPT || head[1] != 1) { printf("Not a script of this version.\n"); return 0; }
    put32(io, MAGIC_ANSWER); put32(io, 1); put32(io, VERSION); put32(io, 0);
    u32 info[4] = { SYS_GetHollywoodRevision(), mfpvr(), (u32)(size_t)arena, 0 };
    record(io, 100, 0, 0, info, sizeof info);
    if (head[2] > ARENA_SIZE) why = "The script needs more memory than there is.";
    while (!why) {
        u32 h[4];
        if (!io_read(io, h, 16)) { why = "The script ends early."; break; }
        u32 op = h[0], a = h[1], b = h[2], len = h[3], padded = (len + 3) & ~3;
        if (padded > PAYLOAD_MAX) { why = "An operation is too big."; break; }
        if (padded && !io_read(io, payload, padded)) { why = "The script ends early."; break; }
        if (op == OP_END) break;
        ops++;
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
                if (n < b) record(io, OP_MEMRLE, a, b, packed, n); else record(io, OP_DUMP, a, b, arena + a, b);
            } else record(io, OP_DUMP, a, b, arena + a, b);
            dumps++;
            break;
        case OP_READ16: {
            u16 v[64];
            if (b > 64) b = 64;
            for (u32 i = 0; i < b; i++) v[i] = HW16(a + 2 * i);
            record(io, OP_READ16, a, b, v, 2 * b);
            break;
        }
        case OP_NOTE:
            payload[len < PAYLOAD_MAX ? len : PAYLOAD_MAX - 1] = 0;
            printf("\r%-70.70s", (char *)payload);
            break;
        case OP_QUIT:
            quit = 1;
            break;
        default:
            why = "An unknown operation.";
            break;
        }
        if (io->failed) { why = "The answer could not be written."; break; }
    }
    GX_DrawDone();
    if (why) record(io, 102, 0, 0, why, strlen(why));
    record(io, 101, ops, dumps, NULL, 0);
    io_flush(io);
    printf("\n%s%u operations, %u blocks saved\n", why ? why : "", (unsigned)ops, (unsigned)dumps);
    if (why) printf("\n");
    return quit;
}

static void leave(const char *msg) {
    printf("\n%s\nPress RESET, or a button on a GameCube controller, to leave.\n", msg);
    for (;;) {
        PAD_ScanPads();
        if (PAD_ButtonsDown(0) || PAD_ButtonsDown(1) || SYS_ResetButtonDown()) break;
        VIDEO_WaitVSync();
    }
    exit(0);
}

static IO io;

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
    printf("\n\ngxprobe %d\n", VERSION);

    arena = memalign(32, ARENA_SIZE);
    if (!arena) leave("Not enough memory.");
    memset(arena, 0, ARENA_SIZE);
    DCFlushRange(arena, ARENA_SIZE);
    void *fifo = memalign(32, FIFO_SIZE);
    memset(fifo, 0, FIFO_SIZE);
    GX_Init(fifo, FIFO_SIZE);
    printf("blocks at %p\n", arena);

    // ---- a script on the SD card, if there is one
    if (fatInitDefault()) {
        FILE *in = fopen("sd:/apps/gxprobe/script.gxps", "rb");
        if (in) {
            FILE *out = fopen("sd:/apps/gxprobe/answer.gxpo", "wb");
            if (out) {
                printf("Running sd:/apps/gxprobe/script.gxps ...\n");
                memset(&io, 0, sizeof io); io.in = in; io.out = out; io.sock = -1;
                run_script(&io);
                fclose(out);
                printf("The answer is in sd:/apps/gxprobe/answer.gxpo\n");
            } else printf("sd:/apps/gxprobe/answer.gxpo could not be made.\n");
            fclose(in);
        }
    }

    // ---- scripts over the network
    printf("Starting the network ...\n");
    char ip[16] = "", mask[16] = "", gw[16] = "";
    if (if_config(ip, mask, gw, true, 20) < 0) leave("No network.");
    s32 server = net_socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET; addr.sin_port = htons(PORT); addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (server < 0 || net_bind(server, (struct sockaddr *)&addr, sizeof addr) < 0 || net_listen(server, 1) < 0) leave("The network port could not be opened.");
    for (;;) {
        printf("Waiting for a script at %s port %d (to stop: turn the console off)\n", ip, PORT);
        struct sockaddr_in from;
        socklen_t flen = sizeof from;
        s32 s = net_accept(server, (struct sockaddr *)&from, &flen);
        if (s < 0) { printf("accept failed (%d)\n", (int)s); VIDEO_WaitVSync(); continue; }
        memset(&io, 0, sizeof io); io.sock = s;
        int quit = run_script(&io);
        net_close(s);
        if (quit) break;
    }
    net_close(server);
    printf("Leaving.\n");
    exit(0);
    return 0;
}
