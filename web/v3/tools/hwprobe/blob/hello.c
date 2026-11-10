// The smallest job: says hello on the console's screen, adds a record, returns its argument plus one.
#include "blob.h"
ENTRY u32 entry(const Services *sv, u32 argument) {
    static const char text[] = "hello from a job";
    sv->print("\n%s (argument %u)\n", text, (unsigned)argument);
    sv->record(200, argument, sv->version, text, sizeof text - 1);
    return argument + 1;
}
