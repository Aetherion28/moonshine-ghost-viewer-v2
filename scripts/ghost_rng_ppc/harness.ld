/* One RWX segment: the stub game memory and the harness both execute. */
ENTRY(_start)
PHDRS { all PT_LOAD FLAGS(7); }
SECTIONS {
    . = 0x80000000;
    .game (NOLOAD) : { . = . + 0x00480000; } :all
    . = 0x80480000;
    .text : { *(.text.start) *(.text .text.*) } :all
    fake_test_perform : { *(fake_test_perform) } :all
    .rodata : { *(.rodata .rodata.* .sdata2 .sdata2.*) } :all
    .data : { *(.data .data.* .sdata .sdata.* .got .got2 .toc) } :all
    .bss : { *(.bss .bss.* .sbss .sbss.* COMMON) } :all
    .stack (NOLOAD) : { . = ALIGN(16); . = . + 0x10000; stack_top = . - 16; } :all
    /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
