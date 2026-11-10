// Tests the watchdog: never returns. The console must write its log, tell the server and restart after 90 seconds.
#include "blob.h"
ENTRY u32 entry(const Services *sv, u32 argument) {
    for (;;) { }
    return 0;
}
