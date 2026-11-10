// Tests the fault handling: reads from an address where nothing is, which must come back as a FAULT record
// (exception 3, DSI) with the job going on.
#include "blob.h"
ENTRY u32 entry(const Services *sv, u32 argument) {
    volatile u32 *nowhere = (volatile u32 *)0x7FFF0000;
    return *nowhere + argument;
}
