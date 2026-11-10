#!/bin/sh
# Builds a piece of code for wiiprobe's code buffer:  blob/build.sh <source.c> <out.bin> <code address, hex> [the program's .elf]
# The address is the console's code buffer (status.json's "code", or `nm wiiprobe.elf | grep ' code$'`). With the
# program's .elf, the code may call anything in it by name (that build only: check the build number).
set -e
: "${DEVKITPRO:=/opt/devkitpro}"
P="${CROSS:-$DEVKITPRO/devkitPPC/bin/powerpc-eabi-}"
HERE=$(dirname "$0")
SYMS=""; [ -n "$4" ] && SYMS="-Wl,--just-symbols=$4"
"${P}gcc" -O2 -Wall -ffreestanding -nostdlib -mcpu=750 -mhard-float -msdata=none ${ABI--meabi} -fno-pic -I"$HERE" ${CFLAGS_EXTRA} "$1" -T "$HERE/blob.ld" -Wl,-Ttext=0x$3 -Wl,--build-id=none $SYMS -o "$2.elf"
"${P}objcopy" -O binary "$2.elf" "$2"
