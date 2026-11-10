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
  The controls Moonshine writes in C++ are ported from its main repository (`Dogecyanide/susamune`; the same files as `panther03/moonshine` V2.3.3) as hooks at the same sites: the pattern selector (the Chomplets' and the Chain Chomp's graph nodes), Petey's route and no-tornado patch, the Gelato fish and blue bird patterns, King Boo's reel, the box game's flags, the Ricco cranes' speed band and the fruit machine. Each keeps the retail `rand()` call wherever Moonshine keeps it.
  Not reproduced: No Shine Get Animation, the gameplay speed, fast forward, the free camera, the level warps. `Moonshine.unsupported()` names the ones a session has on.

Taken from the recording, because the game itself can't know them:
- the pad object's state from before the recording (the last stick angle, the previous buttons), at the first pad record;
- the pad object wherever the recording's differs from what the game computes from the raw pad: Moonshine takes buttons away from the game for its own binds (counted as "pad corrections");
- uninitialised memory. The stage heap is not cleared between stages, so on the console it holds the previous stage's leftovers. Here the first stage's heap starts as zeros, and bytes of Mario, the camera and his controller work that are still zero at their first record are taken from it (the replay lists them). Later stages of the same recording need nothing: their leftovers are the previous stage's in both;
- two numbers of a matrix outside the recorded objects: the Blooper's grab objects (a tentacle's `TBGTakeHit`, the beak's `TBGBeakHit`) don't set their taking matrix in their constructors, and `TMario::pulling` reads it in the tick Mario grabs, before their own perform writes it. His face angle that tick is the angle of whatever the heap had (Ricco Harbor 1, tick 2,712: 0xC000 on the console, 0 from zeros). The replay sets the two entries `pulling` reads from the next record's face angle, only while the matrix is still all zeros;
- Mario's occlusion bit (written from the GPU's draw-sync callback, at a time of its own) in `mFlag` and `mPrevFlag` at each tick, and the GPU reads Moonshine records (occlusion at the camera and at the silhouette; the bath water's height only in newer traces, observation bit 2);
- the timing of the disc: how many frames a stage loads for, and the frame a stage ends on (the exit waits for the sound's wave data to come off the disc);
- the size of the disc's file system table (it sets the arena's top): the replay boots, compares the stage heap's size with the recorded one, and boots again with the table padded by the difference (480 bytes for the traces at hand);
- one Moonshine setting the trace doesn't record, **Shiny Shines**: it makes a collected Shine share the item manager's model instead of loading the blue one, so everything allocated after it sits lower. When Mario's address at his first record differs from the recording's, the replay boots again with it on.

## Where it stands (2026-11-10)

A recording counts as in step while every `rand()` call (caller and seed), every frame's seed and director state, and Mario's and the camera's records at every movement tick are bit-identical with it.

Whole recordings in step to their end: Ricco Harbor 3 (`a/2A1D8909_80000002`), Delfino Plaza (`…2D`, dolpic7), Bianco Hills 7 (`…34`), a Corona secret (`…15`, coro_ex1), a Noki secret (`…30`, mare_ex0).
Still in step when the test's time limit cut them: Delfino Plaza (`…2F`, dolpic9), and Pinna Park 1 (`…0B`) through three stages (pinnaParco0, pinnaParco6, the Mecha-Bowser fight) with each stage's seed, flags, NPC phase and heap equal to the recording's at its start.

What stops the others:
- **the goop**: the game draws the goop map on the GPU (each layer's map through a fading texture environment, stamps blended over it, a model with vertex alpha under the gatekeeper, all copied back to the texture the collision code reads, pixels counted with `GXReadPixMetric`). `ppc/gx.ts` does those draws.
  Bianco Hills 1 is in step to tick 4,533 (2,347 before the GPU model, 2,427 with Dolphin's sample point, 2,952 with Dolphin's 1/16-pixel grid, 4,018 with one sample point for every pixel) and Bianco Hills 5 to tick 3,457 (2,551); Ricco Harbor 1 is in step to tick 3,024, where its first stage ends (see the movie director below).
  Pianta Village 1 (`a/2A1D8909_80000025`, the pattern selector on with 2, 0, 1) is in step to tick 1,688 (127 before the selector's port), where a goop test stops it too: a third stage's texel for the fit.
  See "The goop's sample point" below for what the recordings fixed and what is open;
- **a movie between two stages**: Ricco Harbor 1's recording leaves its first stage at frame 797 (in step to there: tick 3,024) and has eight frames without a stage director before the boss stage;
- **a movie between two stages, continued**: with the frames without a stage director accepted, the replay follows Ricco Harbor 1 into the game's own movie director (the Blooper's movie) and stops where the recording starts the boss stage after eight frames: Moonshine's FMV skip ends the movie, and the movie director's own flow (its setup thread, the THP player) isn't aligned to the recording yet;
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
- **Where in a pixel the texture coordinate is taken** is not the middle, not the same in x and y, and not the same for the four pixels of a 2 x 2 group (the GPU draws in such groups; the scissor offset register counts in them). `Gx.samplePoint` holds the four points.
  One point for every pixel fits a single recording up to a point (x 0.646 to 0.687, y 0.438 to 0.484 took Bianco Hills 1 to tick 4,018), but three texels then contradict each other whatever the point (`tools/goopfit/field.py` shows it without a replay):
  P (Bianco Hills 1, tick 2,426: a 4-pixel pollute stamp's pixel must be 9 or more, x at least 0.625), B (Bianco Hills 5, tick 2,933: an 18-pixel clean stamp's pixel must be 3, x at most 0.604) and N (Bianco Hills 1, tick 4,018: a 24-pixel clean stamp's pixel must be 0, y at least 0.5625 where every other pixel needs y under 0.48).
  P is on an even column, B and N on odd ones, and N on an odd column of an even row. With a point for each of the four pixels all 20,000 tests of the two recordings agree (`sim.py`, rule `par4`): x 0.646 to 0.667 on even columns and 0.583 to 0.604 on odd ones; y 0.458 to 0.479 on odd rows, 0.458 to 0.54 on (even column, even row) and 0.583 to 0.667 on (odd column, even row).
  The replays then confirmed it on ticks the fit had not seen: Bianco Hills 1 passed tick 4,115 (where an experiment with N's pixel set by hand had stopped) and ran to 4,533, Bianco Hills 5 from 2,933 to 3,457.
  Dolphin's hardware test (`hwtests` gxtest/rasterization.cpp) puts the x where a primitive's left edge stops covering a pixel at 7/12, which is the odd columns' x here; nothing tested y. These are still the values the recordings allow, not a known rule of the hardware: what makes the four points (the group's own arithmetic, most likely) is still to find, and each new stopped replay narrows them.
- The bilinear filter is Dolphin's (7-bit weights, the sum truncated): rounding it breaks A and E.
- A frame's test sees the map of the last frame drawn before it: `action` runs before Mario in a tick, so a test in the tick after a frame's last sees that frame.

- **Screen positions are kept in twelfths of a pixel, rounded down, and a pixel is tested at its middle (6/12)**; colours and depth are taken at the middle too, from the positions so rounded (`SUB`, `MID` in `ppc/gx.ts`).
  This came from texel I (tick 2,952: a texel under the gatekeeper's puddle model, whose triangles are about a pixel each, was 33 here and at most 30 on the console) and two more like it (K, I2); with Dolphin's grid (1/16 pixel, the test 9/16 in) no rule for the colours satisfied them.
  It isn't only a fit: the GPU's sample location registers (BP 1 to 4) count in twelfths of a pixel and the game sets every one to 6 (`GXSetCopyFilter` without anti-aliasing; pureikyubu's notes on those registers, and the value seen in the game's own stream), and a left edge then stops covering a pixel 7/12 into it, which is what Dolphin's hardware test measured.
  The model warns if a game sets another sample location.
- The bilinear filter with 6-bit fractions and one lerp after the other (pureikyubu's description of the texture filter) was tried too: cut towards zero it breaks 13 of the stamp pixels the recordings fixed, and no form of it explains N below.

The whole-recording method (2026-11-10): `tests/goopcap.ts` writes every goop draw of a replay (stamps with their texture and height window, the model's triangles, the other quads, each copy) and every goop test with the game's verdict to a JSON-lines file; `tools/goopfit/sim.py` replays all the maps from it under any rule and checks every test (Bianco Hills 1 to tick 4,018: 11,303 tests in 0.8 s, the rule in `ppc/gx.ts` disagreeing with none but N).
`multi.py` scores a rule on several captures at once and `classes.py` scans the 32 kinds of pixel. `tables.py` changes one pixel of one stamp at a time and keeps the changes the recording refutes (clean stamp, 24 pixels: 77), and `check.py` tests a sampling rule against those without a replay; `scan.py` and `search.py` scan a rule's numbers; `history.py` and `tri.py` are the single-texel tools for the model's triangles.

What a goop test proves, corrected (2026-11-10): `TPollutionLayer::action` tries up to five places and stops at the first with goop, two `rand()` calls a try. So a test's verdict shows in the number of calls only for the first four tries; **the fifth try proves nothing** (the same calls follow either way), and `sim.py` no longer counts it. Before this, a fifth try had been read as evidence and made some rules look refuted.

Open (three stopped replays, each naming a texel; `tools/goopfit/multi.py` scores a rule on all captures at once):
- Bianco Hills 1, tick 4,532: texel (199,114) is 50 here and at most 30 on the console: one more unit of cleaning anywhere in its history (13 single stamp pixels would do).
- Bianco Hills 5, tick 3,457: texel (292,294) is 25 here and goop on the console: only the 24-pixel clean stamp's pixel (10,18) at (282,276) can be less (3 for 4), which needs its row sampled lower (y at least 0.565).
- Pianta Village 1, tick 1,688: texel (116,444) is 0 here and goop (over 128) on the console: the 24-pixel clean stamp's pixel (3,17) at (113,427) is 0 there (x under 0.5625), or the pollute stamp before it was stronger.
- No value of the four points does all three: within one kind of pixel (even column, even row) the same stamp row must be past its texel boundary at one place and not at another ((10,18) at (282,276) against (8,21) at (350,57) and (20,6) at (178,88)). `classes.py` splits the pixels 32 ways (the stamp's corner even or odd, the pixel's column and row in the stamp, the quad's two triangles) and shows what each kind allows: nearly every kind accepts x 0.58 to 0.67 and y 0.46 to 0.54, and the exceptions (y at least 0.58 for the even-column even-row pixels under the diagonal of a stamp whose corner row is even; x at most 0.54 for odd pixels under the diagonal of an odd-cornered stamp) fix all three texels, but as three more fitted numbers with no rule behind them. They are not in the model.
- Refuted on the three captures (each scored worse than the four points): one point for each of the quad's two triangles (10 tests wrong at best); the lower-left corner taken as displaced (4, all in Bianco Hills 5); a coordinate step cut to n bits with its error growing from a screen origin (18); a scale on the row coordinate (4).
- The honest state: the rule behind the sample points isn't known, and more fitting from recordings one texel at a time won't find it. A hardware test on a Wii measures it: see "Asking a real console" below.
- N's own history, for the record: texel (169,148) of the first layer had three 24-pixel clean stamps over it for 22 frames, four draws a frame, each taking 1 off (alpha 1): 210 draws from 193. The console kept it at 50 or more, so one of the three didn't touch it, and only the stamp's pixel (4,18) is at its edge (four texels of value 1 here; 0 if its row is sampled 0.11 pixel lower).
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
- `tests/goopdbg.ts <trace.msgt> <from tick> <to tick>`: the goop under Mario per tick and what the GPU model draws (its header lists the switches: `WATCH`, `POLL`, `REGION`, `DUMP`, `GX_SP`).
- `tests/tracedump.ts <trace.msgt> [from] [to]`: a trace's summary, or its events in a range.
- `tests/survey.mjs <replay bundle> <list of traces> [workers] [seconds a trace]`: plays many traces and prints a line each: how far it matched and what stopped it.

## Asking a real console (`tools/hwprobe/`, 2026-11-10; not yet run on a console)

Where a recording can't say what the hardware does, a Wii can be asked. `tools/hwprobe/` is a Wii program (`source/main.c`, built with devkitPPC and libogc 3.2; `make DEVKITPRO=...`) that takes jobs from a small server on a PC of the same home network (`server.py`, standard library only), runs them and sends back the answers. The console connects out to the PC named in `apps/wiiprobe/server.txt` on its SD card and takes jobs only from a server that proves it has the key in that file. Jobs are files dropped in the server's `jobs/` folder; answers appear in `answers/`.

A job is a script (`script.ts`, `wiijob.py`):
- blocks of memory to set, GPU commands that go to the GPU's command stream as they are (only addresses are set to where the blocks are), blocks to save afterwards: a draw of the game replayed on the real GPU;
- reads of memory and hardware registers;
- small pieces of PowerPC code to load and call (`blob/`: linked for the console's code buffer, may call anything in the program, all of libogc included, by the build's `.elf`). A fault in such code comes back as a record with the registers and the job goes on. Code can stay and add operations of its own, so new abilities don't need a new program on the console.

What keeps it unattended: a job that stops the program for 90 seconds makes it write what it was doing and the GPU's state to `crash.log` (card and server) and restart the console; with Priiloader set to start the program, it comes back and reports. Before every case and every call the answer so far is sent, so a job that never ends shows where it was (`failed/NAME.partial`). Holding RESET as it starts leaves to the Wii menu.

Checked without a console (`hosttest/`): the same `main.c` built for big-endian PowerPC Linux with a stand-in for libogc and run under qemu against `server.py`: the greeting and key, a GPU script (the bytes sent to the GPU are the same as `tests/hwprobe.ts feed` gives), a code job, a hang (log to card and server, handed over after the "restart"). The fault handling and everything that touches hardware are not checked this way.

The goop's questions are `tests/hwprobe.ts`: `capture` records goop passes of a replay as the GPU got them (registers, textures, commands up to the copy; `Gx.rec`), `script` turns them into a job: passes as they were, and cases of the script's own: stamps of every size from 2 to 24 pixels with the corner on an even or odd column and row, in three arrangements, with ramp and saw-tooth textures from which the texture coordinate at each pixel can be read to 1/64 texel, the real stamp textures on a flat map, stamps of 64 pixels with flat squares on maps of every value (the blender's table), and bigger stamps. `check` / `model` run the job through `ppc/gx.ts` (the passes as they were give back the replay's own maps); `compare` sets a console's answer against it; `tools/hwprobe/analyse.py` reads the sample points out of an answer (on `ppc/gx.ts`'s own answer it finds 0.65625 and 0.59375, the model's).

What else it is for, once it runs: the CPU (every floating-point and paired-single instruction on random operands against `ppc/fpu.ts`, the estimate tables, the quantised loads and stores, undefined corners), the rest of the GPU as it is modelled (depth, the copy filters, other texture formats, the pixel counters), and whole frames of the game redrawn on the console, should the viewer ever draw with this model.
