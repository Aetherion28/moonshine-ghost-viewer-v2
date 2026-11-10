# ../source/main.c for a PC, built for big-endian PowerPC Linux and run under qemu (the console's byte order, and the
# code a job sends can really run): connects to server.py like the console (./sdcard/server.txt), writes the GPU's
# command stream to a file.   make && qemu-ppc ./hostprobe fifo.bin      (needs gcc-powerpc-linux-gnu and qemu-user)
CC := powerpc-linux-gnu-gcc
hostprobe: host.c ../source/main.c ../source/rle.h ../source/sha256.h gccore.h network.h fat.h
	$(CC) -O1 -w -static -DHOSTTEST -DWATCHDOG_SECONDS=6 -Dmain=wii_main -I. -I../source -include gccore.h -c ../source/main.c -o main.o
	$(CC) -O1 -static -Wl,-z,execstack -I. host.c main.o -lpthread -o hostprobe
