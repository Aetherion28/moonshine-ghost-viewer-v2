#include "gccore.h"
FILE *fifo_log; u32 host_hw32;
int wii_main(void);
int main(int argc, char **argv) { fifo_log = fopen(argc > 1 ? argv[1] : "fifo.bin", "wb"); setvbuf(stdout, 0, _IOLBF, 0); return wii_main(); }
