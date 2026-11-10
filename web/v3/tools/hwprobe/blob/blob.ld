/* code for wiiprobe's code buffer: the entry first, everything in one piece (the address comes with -Ttext) */
ENTRY(entry)
SECTIONS {
    .text : { *(.entry) *(.text .text.*) *(.rodata .rodata.*) *(.data .data.*) *(.sdata .sdata.* .sdata2 .sdata2.*) *(.sbss .sbss.* .bss .bss.* COMMON) }
    /DISCARD/ : { *(.comment) *(.gnu.attributes) *(.eh_frame) *(.note*) }
}
