# v3: the game's own code, run from the user's DOL

v2 is a hand port of Super Mario Sunshine's code to TypeScript, checked function by function against the decomp and the DOL.
v3 instead runs the game's machine code from the user's own `main.dol` in a PowerPC (Gekko) interpreter, so the game logic is bit-exact by construction.
The site still hosts no game data: the DOL comes from the user's disc in their browser, as the stage files already do.
v3 only reads the newest trace format (the user, 2026-11-09).

## Plan

1. **CPU** (`ppc/`): the Gekko's user-mode integer, branch, load/store, FPU and paired-single instructions, with Dolphin's hardware-tested float rules (single ops round once, fused ops too; a single multiply's frC keeps 25 bits; single results go to ps0 and ps1; the fres / frsqrte tables). **Done**: see the tests below.
2. **Boot without hardware**: run `__start` → `main` with the SDK's hardware-facing functions replaced by JS (high-level emulation, hooked by address from the decomp's `symbols.txt`): OS (heap, threads, interrupts, time), DVD (reads from the user's disc image or extracted files), GX (the write-gather FIFO discarded: rendering stays the viewer's), VI (the retrace count), PAD (the trace's inputs), AI / AR / DSP (audio off). The decomp is used only to know what to hook and where state lives.
3. **Play a trace**: the director's frame loop driven by the trace's pads; Mario's record compared tick by tick with the game's memory (`TMario` at `gpMarioOriginal`). What the GPU feeds back (occlusion, the bath water's height) comes from the trace's feedback records, as in v2.
4. **Viewer**: the game's object state (positions, models' matrices) read out of the interpreter's memory each frame and drawn with the existing renderer.

## Where boot stands (2026-11-09)

`tests/boot.ts` runs the DOL from its entry with `ppc/machine.ts` (time base, decrementer, the 60 Hz retrace) and `ppc/hw.ts` (PI interrupts, ARAM DMA, EXI, VI; the GX FIFO discarded) plus the HLE hooks in `ppc/hle.ts` (the DSP handshake, cache maintenance).
In 60 million instructions it goes through `__start`, OSInit, all the static constructors, `main`, `TApplication::initialize` (the heaps, ARAM), into the thread scheduler, taking VI retrace interrupts (`__VIRetraceHandler`).
Next: see what the threads wait for (DVD reads: HLE the DVD file API on the user's extracted disc), then the controller (PAD from the trace), then the first stage load.

## Tests

- `tests/leaf.ts`: calls the DOL's MSL `sinf`, `cosf`, `atan2f` (60,000 inputs) and the SDK's paired-single `PSMTXConcat` / `PSMTXMultVec` (45,000 values) and compares them bit for bit with v2's ports (which were checked against the DOL): 0 differences.
  Build and run: `npx esbuild v3/tests/leaf.ts --bundle --platform=node --format=esm --outfile=/tmp/v3leaf.mjs && node /tmp/v3leaf.mjs [main.dol]`.
