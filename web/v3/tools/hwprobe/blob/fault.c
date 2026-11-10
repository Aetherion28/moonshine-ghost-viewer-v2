// Tests the fault handling: reads from an address where nothing is, which must come back as a FAULT record
// (exception 3, DSI) with the job going on.
#include "blob.h"
ENTRY u32 entry(const Services *sv, u32 argument) {
    return *(volatile u32 *)0x00000100 + argument;
}
