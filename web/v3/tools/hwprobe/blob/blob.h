// For code a job sends to wiiprobe (see ../source/main.c): the entry is `u32 entry(const Services *sv, u32 argument)`,
// placed first by blob.ld; whatever it returns goes into the answer, and it can add records of its own.
#include <stdint.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int32_t s32; typedef uint64_t u64;
typedef const char *(*Extension)(u32 op, u32 a, u32 b, u8 *payload, u32 len);
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
#define ENTRY __attribute__((section(".entry"), used))
