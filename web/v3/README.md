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

## Playing a trace

- `game/trace.ts`: a trace as the ordered events a replay must reproduce: the stage start (the flag manager's image, the RNG seed, the NPC pollution phase, the scenes), each frame (before `direct()`), each pad, each movement tick (Mario's first 0x574 bytes and the camera's first 0x350 as `TMario::perform` begins), every `rand()` call with its caller and seed, and the GPU results the game read back.
- `game/replay.ts`: boots the DOL; when the logos end it sends the application into the recorded stage with the recorded state; delivers the recorded pad at `PADRead`; and checks every event as it happens, in order.
  The first `rand()` call whose caller or seed differs names the function that diverged.
  Loading frames are aligned to the recording's (this machine's disc is faster than a console's).
- `game/moonshine.ts`: what Moonshine, the mod that records the traces, changes in the game: the arena floor raised by 0xC2000 (so heap addresses equal the console's), `gpPollution` cleared before `setupObjects`, and the settings' instruction patches, asm hooks (their caves run as the PowerPC code they are) and choice patches from its `features.cpp`, switched by the trace's session records.
  Not reproduced yet (no source in the snapshot): the Ricco crane and fruit controls, Petey's route and tornado, King Boo's reel, the pattern selector, the Gelato patterns, the box game, the level warps. `Moonshine.unsupported()` names the ones a session has on.

Taken from the recording, because the game itself can't know them:
- the pad object's state from before the recording (the last stick angle, the previous buttons), at the first pad record;
- bytes of Mario and of the camera the game hasn't written by their first record (uninitialised heap memory: zero on this freshly booted machine, leftovers on the console);
- Mario's occlusion bit (written from the GPU's draw-sync callback) at each tick, and the three GPU reads Moonshine records (occlusion at the camera and at the silhouette, the bath water's height);
- the size of the disc's file system table (it sets the arena's top): the replay boots, compares the stage heap's size with the recorded one, and boots again with the table padded by the difference.

## Where it stands (2026-11-09)

Bianco Hills episode 1 (`a/trace_41726535_80000003`, recorded on a Wii):
- the stage load matches: all 3,909 `rand()` calls in step, Mario at the console's address (0x814459EC), the stage heap the same size;
- 2,347 movement ticks (627 of 1,792 frames, about 10 s of play) with Mario's and the camera's records bit-identical, 754,667 `rand()` calls and 3,885 GPU reads in step;
- then `TPollutionLayer::action` rolls where the recording doesn't: **the goop map**. The game draws it on the GPU (stamps into the frame buffer, copied back to a texture the collision code reads, and pixel counts read back with `GXReadPixMetric`), and v3 discards the GX FIFO, so the goop is never cleaned. Next: a software model of those draws (nearest-filtered, integer-aligned quads, simple TEV and blending), fed from the FIFO.

What the trace taught about the hardware (each is a rule the replay breaks without):
- a single multiply's frC keeps 25 bits, rounded (Dolphin's rule): without it the replay breaks at tick 253;
- **in `ps_muls0` and `ps_madds0` the second lane's multiplier (frC's first lane) is cut to 25 bits, not rounded**: Dolphin rounds it. With Dolphin's rule the replay breaks at tick 598 (one ulp in a row of Mario's head matrix, from `MsVECNormalize`); with a 24-bit multiplier, at tick 592. See `trunc25` in `ppc/fpu.ts`. So Dolphin is not a bit-exact reference for console recordings.

Speed: a frame of play is about 5 million instructions, so real time needs about 350 million a second; the interpreter does 40 to 60 million in Node. A replay is computed ahead of its playback for now; a faster core (blocks compiled to JS) comes after correctness.

Open questions:
- stages with goop need the GPU model above; `GXReadPixMetric` too (how much goop is left);
- Moonshine's features without source (the PR76 Dolphin package's JP patch carries the mod's compiled code: read them from there);
- uninitialised memory outside the recorded objects is zero here and leftovers on the console (the stage heap isn't cleared between stages);
- what a non-single value becomes when `ps_merge` moves it into the second lane (kept bit for bit here);
- only GMSJ01 revision 0 is set up (the addresses in `game/replay.ts` and the HLE names from the decomp's `symbols.txt`).

## Tests

Build each with `npx esbuild v3/tests/<name>.ts --bundle --platform=node --format=esm --outfile=/tmp/claude-0/ct/v3<name>.mjs` (from `web/`) and run it with `node`.

- `tests/unit.ts`: the integer instructions against a BigInt model, the fused multiply-add against exact rational arithmetic (including provoked halfway cases), `fres` / `frsqrte` and the float conversions against v2's ports, the 25-bit multiplier rules. 23 million checks.
- `tests/leaf.ts`: functions of the DOL run in the interpreter and compared with independent implementations: MSL `sinf` / `cosf` / `atan2f`, the SDK's paired-single `PSMTXConcat` / `PSMTXMultVec`, `rand`, `calcKeyCode`, and `decodeSZS` on a whole archive. 130,000 checks.
- `tests/boot.ts [millions of instructions]`: boots the game. Env: `START=area,episode`, `THREADS=1` (every OS thread with its call stack at the end), `PROFILE=1`, `FILES=1`, `QUIET=1`.
- `tests/replay.ts <trace.msgt> [millions of instructions]`: plays a trace and reports how far it matches (`ALL=1`: don't stop at the first issue; `QUIET=1`: without the game's console).
- `tests/tracedump.ts <trace.msgt> [from] [to]`: a trace's summary, or its events in a range.
