# wiiprobe for the Wii (the Homebrew Channel, or Priiloader, loads boot.dol). Needs devkitPPC, libogc and libfat:
#   make DEVKITPRO=/opt/devkitpro
DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
CC := $(DEVKITPPC)/bin/powerpc-eabi-gcc
ELF2DOL := $(DEVKITPRO)/tools/bin/elf2dol
MACHDEP := -DGEKKO -mrvl -mcpu=750 -meabi -mhard-float
# (the build's number: from the sources, so that code sent to a console can be checked to fit its program)
BUILD_ID := 0x$(shell cat source/main.c source/rle.h source/sha256.h | sha256sum | cut -c1-8)
CFLAGS := -O2 -Wall $(MACHDEP) -DBUILD_ID=$(BUILD_ID) -I$(DEVKITPRO)/libogc/include
# (all of libogc and libfat, used or not: code sent to the console later may call any of it)
LDFLAGS := $(MACHDEP) -L$(DEVKITPRO)/libogc/lib/wii -Wl,--allow-multiple-definition -Wl,--no-gc-sections -Wl,--whole-archive -lfat -logc -Wl,--no-whole-archive -lm -Wl,-Map,build/wiiprobe.map

build/boot.dol: build/wiiprobe.elf
	$(ELF2DOL) $< $@
build/wiiprobe.elf: source/main.c source/rle.h source/sha256.h Makefile
	mkdir -p build
	$(CC) $(CFLAGS) $< $(LDFLAGS) -o $@
clean:
	rm -rf build
