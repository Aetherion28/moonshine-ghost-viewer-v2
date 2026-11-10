#pragma once
// A PC stand-in for libogc, enough to run ../source/main.c's script and network handling: the GPU's command stream
// goes to a file (fifo.bin), addresses count from 0x01000000 as in web/v3/tests/hwprobe.ts's own run, hardware
// registers read 0, the SD card's folder is ./sdcard, a console restart ends the program with status 3.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64; typedef int32_t s32; typedef volatile u16 vu16; typedef volatile u32 vu32;
#define ATTRIBUTE_ALIGN(n) __attribute__((aligned(n)))
typedef struct { int fbWidth, xfbHeight, viTVMode; } GXRModeObj;
#define VI_NON_INTERLACE 0
#define VI_DISPLAY_PIX_SZ 2
#define MEM_K0_TO_K1(x) (x)
extern FILE *fifo_log;
static inline u32 be32(u32 v) { return htonl(v); }
#define FIFO8(v) do { u8 b_ = (u8)(v); fwrite(&b_, 1, 1, fifo_log); } while (0)
#define FIFO32(v) do { u32 w_ = (u32)(v); u8 b_[4] = { w_ >> 24, w_ >> 16, w_ >> 8, w_ }; fwrite(b_, 1, 4, fifo_log); } while (0)
#define HW16(a) 0
#define HW32(a) host_hw32
#include <sys/mman.h>
#define CODE_READY(p, n) do { mprotect((void *)((uintptr_t)(p) & ~4095u), (((uintptr_t)(p) & 4095) + (n) + 4095) & ~4095u, PROT_READ | PROT_WRITE | PROT_EXEC); __builtin___clear_cache((char *)(p), (char *)(p) + (n)); } while (0)
#define APPDIR "sdcard"
#define SYS_RESTART 0
#define SYS_RETURNTOMENU 3
#define INADDR_NONE_ 0xffffffff
#include <pthread.h>
#include <time.h>
#include <stdbool.h>
extern u32 host_hw32;
typedef pthread_t lwp_t;
static inline int LWP_CreateThread(lwp_t *t, void *(*f)(void *), void *a, void *st, u32 ss, int prio) { return pthread_create(t, 0, f, a); }
static inline uint64_t gettime(void) { return (uint64_t)time(0); }
static inline u32 diff_sec(uint64_t a, uint64_t b) { return (u32)(b - a); }
static inline void SYS_ResetSystem(int a, int b, int c) { fflush(0); _exit(a == SYS_RETURNTOMENU ? 0 : 3); }
static inline void __exception_setreload(int t) {}
#define PHYSICAL(p) ((u32)((u8 *)(p) - arena) + 0x01000000u)
static inline void VIDEO_Init(void) {} static inline void PAD_Init(void) {} static inline GXRModeObj *VIDEO_GetPreferredMode(void *p) { static GXRModeObj m; return &m; }
static inline void *SYS_AllocateFramebuffer(GXRModeObj *m) { return 0; } static inline void console_init(void *a, int b, int c, int d, int e, int f) {}
static inline void VIDEO_Configure(GXRModeObj *m) {} static inline void VIDEO_SetNextFramebuffer(void *p) {} static inline void VIDEO_SetBlack(int b) {} static inline void VIDEO_Flush(void) {} static inline void VIDEO_WaitVSync(void) { usleep(2000); }
static inline void PAD_ScanPads(void) {} static inline int PAD_ButtonsDown(int i) { return 0; } static inline int PAD_ButtonsHeld(int i) { return 0; } static inline int SYS_ResetButtonDown(void) { return 0; }
static inline void DCFlushRange(void *p, u32 n) {} static inline void DCInvalidateRange(void *p, u32 n) {}
static inline void GX_Init(void *p, u32 n) {} static inline void GX_DrawDone(void) {}
static inline u32 SYS_GetHollywoodRevision(void) { return 0x11; }
