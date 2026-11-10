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
- `ppc/hw.ts`: the hardware the OS talks to, at register level: PI (interrupts), VI (the retrace, the beam position), DI (disc reads from `ppc/disc.ts`), DSP / ARAM (DMA), SI, EXI (no memory card), AI, and the GPU's command and pixel engines: the write-gather pipe's bytes go to memory at the FIFO's write pointer 32 at a time (so display lists the game builds through the pipe exist), the GPU reads behind it and stops at the FIFO's breakpoint when the game sets one (it does, around every draw-sync token, so that it can read the pixel counters before the GPU goes on).
- `ppc/gx.ts`: the GPU, as far as the game's logic depends on it. The command stream and the display lists it calls are parsed all the time, so the GPU's registers are always what the game last set and the tokens are found exactly. Nothing is drawn for the screen, but the game draws its goop maps on the GPU and reads them back, so while the replay marks a goop pass the primitives are rasterised in software into a frame buffer (fixed-point edges, texture sampling, the texture environment, blending, the depth test), the frame buffer copy writes the map back into memory, and the pixel counter counts. The arithmetic is Dolphin's software renderer's (compared with its source: edges, slopes, the texture filter, the texture environment, the blender), except where in a pixel the values are taken, which the recordings fixed ("The goop's sample point" below).
- `ppc/disc.ts`: a virtual disc built from the user's extracted files, with a file system table made the way the disc's is.
- `ppc/machine.ts`: time. The clock is the instruction count (one instruction = one cycle at 486 MHz); events (the video field, the decrementer, disc reads completing) are scheduled against it; the OS's idle loop skips to the next event.
- `ppc/jit.ts`: speed. Straight runs of the game's code (to the first unconditional branch) are compiled to WebAssembly, each a function, with a small WebAssembly dispatcher that calls them one after another. RAM, the registers and the block tables share one WebAssembly memory with the interpreter, which stays the definition: a block does exactly what the interpreter would (the tests compare the whole machine's state after a billion instructions), and anything rare, anything that touches hardware and the fused multiply-adds go through the interpreter's own methods. A block only runs when all of it fits before the next event, so the clock stays exact.
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
- the pad object wherever the recording's differs from what the game computes from the raw pad: Moonshine takes buttons away from the game for its own binds (counted as "pad corrections");
- uninitialised memory. The stage heap is not cleared between stages, so on the console it holds the previous stage's leftovers. Here the first stage's heap starts as zeros, and bytes of Mario, the camera and his controller work that are still zero at their first record are taken from it (the replay lists them). Later stages of the same recording need nothing: their leftovers are the previous stage's in both;
- Mario's occlusion bit (written from the GPU's draw-sync callback, at a time of its own) in `mFlag` and `mPrevFlag` at each tick, and the GPU reads Moonshine records (occlusion at the camera and at the silhouette; the bath water's height only in newer traces, observation bit 2);
- the timing of the disc: how many frames a stage loads for, and the frame a stage ends on (the exit waits for the sound's wave data to come off the disc);
- the size of the disc's file system table (it sets the arena's top): the replay boots, compares the stage heap's size with the recorded one, and boots again with the table padded by the difference (480 bytes for the traces at hand);
- one Moonshine setting the trace doesn't record, **Shiny Shines**: it makes a collected Shine share the item manager's model instead of loading the blue one, so everything allocated after it sits lower. When Mario's address at his first record differs from the recording's, the replay boots again with it on.

## Where it stands (2026-11-09)

A recording counts as in step while every `rand()` call (caller and seed), every frame's seed and director state, and Mario's and the camera's records at every movement tick are bit-identical with it.

Whole recordings in step to their end: Ricco Harbor 3 (`a/2A1D8909_80000002`), Delfino Plaza (`…2D`, dolpic7), Bianco Hills 7 (`…34`), a Corona secret (`…15`, coro_ex1), a Noki secret (`…30`, mare_ex0).
Still in step when the test's time limit cut them: Delfino Plaza (`…2F`, dolpic9), and Pinna Park 1 (`…0B`) through three stages (pinnaParco0, pinnaParco6, the Mecha-Bowser fight) with each stage's seed, flags, NPC phase and heap equal to the recording's at its start.

What stops the others:
- **the goop**: the game draws the goop map on the GPU (each layer's map through a fading texture environment, stamps blended over it, a model with vertex alpha under the gatekeeper, all copied back to the texture the collision code reads, pixels counted with `GXReadPixMetric`). `ppc/gx.ts` does those draws.
  Bianco Hills 1 is in step to tick 2,952 (2,347 before the GPU model, 2,427 with Dolphin's sample point) and Bianco Hills 5 to tick 2,933 (2,551); Ricco Harbor 1 stops at tick 2,713 on something else.
  See "The goop's sample point" below for what the recordings fixed and what is open (now: the model stamps under the gatekeeper);
- **Moonshine features without source**: the pattern selector (Pianta Village 1 at tick 127: a Chain Chomplet picks its graph node), and by the session records the Ricco crane and fruit controls, Petey's route. The PR76 Dolphin package's JP patch rebuilds into the whole Moonshine DOL (retail text with 35 patched words, the mod's code at 0x80426020 and 0x804A6020): the hooks' code can be read there (the pattern selector is the function at 0x8044BA74);
- **DPad Functions** (Gelato Beach 1 at tick 2,669: Moonshine writes Mario's status; a TAS-tagged run);
- **the bath water's height** in traces older than its recording (Bowser, observations 3).

What the traces taught (each is a rule the replay breaks without):
- a single multiply's frC keeps 25 bits, rounded (Dolphin's rule): without it Bianco Hills 1 breaks at tick 253;
- **in `ps_muls0` and `ps_madds0` the second lane's multiplier (frC's first lane) is cut to 25 bits, not rounded**: Dolphin rounds it. With Dolphin's rule the replay breaks at tick 598 (one ulp in a row of Mario's head matrix, from `MsVECNormalize`); with a 24-bit multiplier, at tick 592. See `trunc25` in `ppc/fpu.ts`. The traces are from a Wii (Moonshine's recorder exists only there), so Dolphin is not a bit-exact reference for them;
- the NPC pollution phase is a function-local static with a guard byte after it: on a freshly booted machine the first NPC zeroes the phase unless the guard is set too;
- `CLBPalFrame(30)` is 15 on this console (the phase wraps there).

Speed: a frame of play is 3 to 6 million instructions, so real time needs 90 to 180 million a second. The interpreter alone does about 40 million in Node; with the blocks compiled to WebAssembly (`ppc/jit.ts`) the game runs at about 100 million: a 21-second recording (Delfino Plaza, 629 frames) replays in 34 s, boot included. The goop's software drawing is slow still (Bianco Hills 1: twice as long). A first try compiled the blocks to JavaScript functions: no faster than the interpreter, because V8 takes minutes to optimise twenty thousand small functions. A replay is still computed ahead of its playback.

Open questions:
- uninitialised memory outside the recorded objects is zero here and leftovers on the console;
- what a non-single value becomes when `ps_merge` moves it into the second lane (kept bit for bit here);
- the other settings Moonshine doesn't record (the appearance choices load other models too);
- IL entries with a flag overlay (Moonshine sets or clears Shine flags between `loadResource` and `setupObjects`, and the stage-start image is taken before): the entry isn't recorded, so it has to be chosen by evidence as Shiny Shines is;
- only GMSJ01 revision 0 is set up (the addresses in `game/replay.ts` and the HLE names from the decomp's `symbols.txt`).

## The goop's sample point (how the GPU model is fitted to the recordings)

Dolphin's software renderer isn't bit-exact with the console where the goop needs it: a clean stamp's edge has alpha 1 to 10 of 255 and falls on a texel hundreds of times, so which texel of the stamp a pixel samples decides whether a goop texel is under the game's limit (30) at a given frame.
The recordings say what the console had: the game tests goop texels at random places every tick (`TPollutionLayer::action`, two `rand()` calls a test), and Mario's dirty flag is a test of nine texels.
So a replay that stops on a goop test names a texel and the console's verdict on it.

The method (tools in `tools/goopfit/`, logs from `tests/goopdbg.ts`):
1. the stopped replay's last goop tests (`POLL=1`) give the texel and whether the console had goop there;
2. every pixel drawn at that texel (`WATCH=x,y`, valid as long as the replay was in step: the draw commands are then the console's) gives its whole history: each stamp's quad, texture and height window;
3. `pixel.py` recomputes the texel from that history under any rule for sampling and blending, in milliseconds; `constraints.py` holds the texels found so far (A to I) and scores a rule against all of them.

What that fixed (2026-11-10, Bianco Hills 1):
- **The blender truncates**, as Dolphin has it: `(src * sf + dst * df) >> 8` with a factor of 255 counted as 256. Rounding (+128, or an exact division by 255) leaves texels above the limit that the console had under it (D: 64 stamps of alpha 7 take 253 under 30 on the console; with rounding, and even in exact arithmetic, they don't). A constant between (+10 to +30) satisfied the first seven texels and is refuted by the eighth (H).
- **Where in a pixel the texture coordinate is taken** is not the middle, and not the same in x and y: with the truncating blender all of A to H hold only for x in 0.646 to 0.687 and y in 0.438 to 0.484 of a pixel (the offline grid, and replays at the corners: x 0.625 stops at tick 2,427, x 0.6875 at 2,595 or 2,792, y 0.5 at 1,944). `Gx.sampleX` / `sampleY` are the middle, 2/3 and 11/24. Dolphin's 0.495 for both stops at tick 2,427.
  Dolphin's hardware test (`hwtests` gxtest/rasterization.cpp) puts the x where a primitive's left edge stops covering a pixel at 7/12; nothing tested y. The values here are what the recordings allow, not a known rule of the hardware: a rule that explains them (and their difference from 7/12) is still to find.
  An offset in texels instead of pixels fits the same texels only in a one-value-wide strip, so the pixel offset is the simpler reading; the stamps so far are 4, 18 and 24 pixels wide.
- The bilinear filter is Dolphin's (7-bit weights, the sum truncated): rounding it breaks A and E.
- A frame's test sees the map of the last frame drawn before it: `action` runs before Mario in a tick, so a test in the tick after a frame's last sees that frame.

Open:
- **I** (tick 2,952): a texel under the gatekeeper's puddle model is 33 here and at most 30 on the console. Its value comes from the model's triangles (about a pixel each, vertex alpha): the coverage rule (here Dolphin's: positions in 1/16 pixel, the test 9/16 in) and the colour's interpolation are next. `pixel.py` keeps a model stamp's alpha as logged, so it can't test rules for those yet.
- What the pixel counter counts is still the guess of before (2 x 2 groups with a pixel through the alpha test, plus one a triangle).
- Only Bianco Hills 1 gave texels so far; Bianco Hills 5 confirms the sample point (tick 2,551 to 2,933) without having been used for it.

## In the browser

- `web/verify.ts`: `tests/replay.ts`'s driver as a function: it plays a trace on a disc and returns a report (how far the game was in step, the first issue, the settings not reproduced). It boots again with the file table padded and with Shiny Shines as the test does.
- `web/worker.ts` (built by `web/build.mjs` into `site/v3worker.js`): a Web Worker around it. It gets the trace's bytes and the disc as the user picked it, runs the replay in slices of 50 million instructions and posts progress and the report. `{ type: 'cancel' }` stops it between slices.
- `web/discs.ts`: the drive over the user's disc, read on demand (`Bytes`: `FileReaderSync` over the user's file in the browser, a file descriptor in the Node tests).
  A plain disc image (.iso / .gcm) is served at its own offsets with its own boot.bin and file system table; an extracted folder (Dolphin's files/ and sys/) the same when it has sys/boot.bin and sys/fst.bin, otherwise through `ppc/disc.ts`'s table.
  The program is the image's DOL or the folder's sys/main.dol.
  A compressed or cut image (RVZ, WIA, GCZ, CISO, WBFS, NKit) is refused with what to do (convert it to ISO in Dolphin).
- **Checked with the plain retail image** (2026-11-09, the user's `JP 1.0 (GMSJ01).iso`, 1,459,978,240 bytes, through `tests/verify.ts` on the user's computer): Ricco Harbor 3 (298 frames) and Bianco Hills 7 (583 frames) in step to the end on the first boot, with no file table padding.
  So the 480 bytes of padding the workspace's extract needs are only the difference between the table made from its files and the disc's own; nothing about the recording console.
  The JP 1.1 and US images are refused by their ID and revision.
  In headless Chromium (`tests/browser.mjs`) the viewer with an image of the same layout verifies Ricco Harbor 3 to the end in 33 s.
- `game/syms_jp10.ts`: the addresses of the functions hooked by name, generated by `tools/gen_syms.mjs` from the decomp's `symbols.txt` (run it again when the code asks for a new name). Addresses in messages stay hexadecimal in the browser.
- The viewer's "Verify with the game's code" (viewer.html, under the replay mode) starts the worker on the shown replay; `window.__v3Report` keeps the last report.

## Tests

Build each with `npx esbuild v3/tests/<name>.ts --bundle --platform=node --format=esm --outfile=/tmp/claude-0/ct/v3<name>.mjs` (from `web/`) and run it with `node`.

- `tests/unit.ts`: the integer instructions against a BigInt model, the fused multiply-add against exact rational arithmetic (including provoked halfway cases), `fres` / `frsqrte` and the float conversions against v2's ports, the 25-bit multiplier rules. 23 million checks.
- `tests/leaf.ts`: functions of the DOL run in the interpreter and compared with independent implementations: MSL `sinf` / `cosf` / `atan2f`, the SDK's paired-single `PSMTXConcat` / `PSMTXMultVec`, `rand`, `calcKeyCode`, and `decodeSZS` on a whole archive. 130,000 checks.
- `tests/boot.ts [millions of instructions]`: boots the game and prints a hash of the machine's state at the end. Env: `START=area,episode`, `THREADS=1` (every OS thread with its call stack at the end), `PROFILE=1`, `FILES=1`, `QUIET=1`; `JIT=0` (the interpreter alone: the hash must be the same), `JITVERIFY=1` (each block checked against memory as it is entered), `MARK=n` (the speed after n million instructions), `MIPSLOG=1`.
- `tests/replay.ts <trace.msgt> [millions of instructions]`: plays a trace and reports how far it matches (`ALL=1`: don't stop at the first issue; `QUIET=1`: without the game's console).
- `tests/verify.ts <disc image or extracted folder> <trace.msgt>`: the browser's check from Node, on a disc as the browser gets it. The bundle needs nothing else, so it can run where the disc is.
- `tests/browser.mjs <site folder> <disc image> <trace.msgt>`: the same in headless Chromium through the built viewer.
- Every test that takes the workspace's extract takes `DISC=<disc image or extracted folder>` instead (`tests/jpdisc.ts`); then `FSTPAD` isn't needed.
- `tests/goopdbg.ts <trace.msgt> <from tick> <to tick>`: the goop under Mario per tick and what the GPU model draws (its header lists the switches: `WATCH`, `POLL`, `REGION`, `DUMP`, `GX_SX` / `GX_SY`).
- `tests/tracedump.ts <trace.msgt> [from] [to]`: a trace's summary, or its events in a range.
- `tests/survey.mjs <replay bundle> <list of traces> [workers] [seconds a trace]`: plays many traces and prints a line each: how far it matched and what stopped it.
