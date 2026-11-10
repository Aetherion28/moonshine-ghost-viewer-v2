# hwprobe for the Wii (the Homebrew Channel loads boot.dol). Needs devkitPPC, libogc and libfat:
#   make DEVKITPRO=/opt/devkitpro
DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
CC := $(DEVKITPPC)/bin/powerpc-eabi-gcc
ELF2DOL := $(DEVKITPRO)/tools/bin/elf2dol
MACHDEP := -DGEKKO -mrvl -mcpu=750 -meabi -mhard-float
CFLAGS := -O2 -Wall $(MACHDEP) -I$(DEVKITPRO)/libogc/include
LDFLAGS := $(MACHDEP) -L$(DEVKITPRO)/libogc/lib/wii -lfat -logc -lm

build/boot.dol: build/hwprobe.elf
	$(ELF2DOL) $< $@
build/hwprobe.elf: source/main.c
	mkdir -p build
	$(CC) $(CFLAGS) $< $(LDFLAGS) -o $@
clean:
	rm -rf build
