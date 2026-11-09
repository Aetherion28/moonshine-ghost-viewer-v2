# v3: the game's own code, run from the user's DOL

v2 is a hand port of Super Mario Sunshine's code to TypeScript, checked function by function against the decomp and the DOL.
v3 instead runs the game's machine code from the user's own `main.dol` in a PowerPC (Gekko) interpreter, so the game logic is bit-exact by construction.
The site still hosts no game data: the DOL and the disc's files come from the user's disc in their browser, as the stage files already do.
v3 only reads the newest trace format (the user, 2026-11-09).
v2 is no longer developed (the user, 2026-11-09).

## How it works

- `ppc/cpu.ts`: the Gekko interpreter. Integer, branch, load / store, FPU and paired-single instructions, exceptions (external, decrementer, FP unavailable: the OS switches FPU contexts lazily), the SPRs the OS uses, the locked cache's DMA.
  Hooks by address replace a function with JS (or just watch it, when they return `false`).
- `ppc/fpu.ts`: the float rules, as Dolphin has them from hardware tests. Single ops round once; fused ops are exact (error-free transformations, then one rounding); a single multiply's frC keeps 25 bits; single results go to ps0 and ps1; with FPSCR[NI] set (the OS sets it) results below the smallest normal become zero; `lfs` / `stfs` convert bits as the hardware does; the `fres` / `frsqrte` tables.
- `ppc/mem.ts`: 24 MB of RAM, the locked cache, memory-mapped I/O, the DOL loader.
- `ppc/hw.ts`: the hardware the OS talks to, at register level: PI (interrupts), VI (the retrace, the beam position), DI (disc reads from `ppc/disc.ts`), DSP / ARAM (DMA), SI, EXI (no memory card), AI, PE (draw-done and draw-sync tokens, found in the GX FIFO's stream; everything else written to the FIFO is discarded: drawing stays the viewer's).
- `ppc/disc.ts`: a virtual disc built from the user's extracted files, with a file system table made the way the disc's is.
- `ppc/machine.ts`: time. The clock is the instruction count (one instruction = one cycle at 486 MHz); events (the video field, the decrementer, disc reads completing) are scheduled against it; the OS's idle loop skips to the next event.
- `ppc/hle.ts`: the few SDK functions replaced: the DSP's boot and its command mails (no DSP program runs, audio is off), cache maintenance, `OSReport` (the game's console), `OSPanic`.

The decomp is used only for addresses (its `symbols.txt`): what to hook and where state lives.

## Where it stands (2026-11-09)

`tests/boot.ts` boots the JP 1.0 DOL from its entry: the OS banner, the Nintendo logos, the movie director.
With `START=area,episode` it goes from the logos straight into a stage (the application's state is set at `TApplication::proc`'s loop head): Bianco Hills episode 1 loads its archives and runs its frame loop.
About 1,000 million instructions for the first 16.5 s of game time (boot, logos, the stage load and the first frames), at 45 to 60 million instructions a second in Node.

Next: play a trace. Start the recorded stage with the trace's flag image, RNG seed and NPC pollution phase, feed the recorded pads at `PADRead`, and compare the RNG seed and Mario's record with the game's memory, frame by frame.

## Tests

Build each with `npx esbuild v3/tests/<name>.ts --bundle --platform=node --format=esm --outfile=/tmp/claude-0/ct/v3<name>.mjs` (from `web/`) and run it with `node`.

- `tests/unit.ts`: the integer instructions against a BigInt model, the fused multiply-add against exact rational arithmetic (including provoked halfway cases), `fres` / `frsqrte` and the float conversions against v2's ports. 23 million checks.
- `tests/leaf.ts`: functions of the DOL run in the interpreter and compared with independent implementations: MSL `sinf` / `cosf` / `atan2f`, the SDK's paired-single `PSMTXConcat` / `PSMTXMultVec`, `rand`, `calcKeyCode`, and `decodeSZS` on a whole archive. 130,000 checks.
- `tests/boot.ts [millions of instructions]`: boots the game. Env: `START=area,episode`, `THREADS=1` (every OS thread with its call stack at the end), `PROFILE=1`, `FILES=1`, `QUIET=1`.
