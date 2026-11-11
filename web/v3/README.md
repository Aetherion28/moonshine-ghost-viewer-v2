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
  With each frame Moonshine also samples every actor of the conductor's managers (the first 0x150 bytes of an enemy manager's, 0xF4 of the others'), FLUDD and Yoshi whole, and it records each water request of FLUDD's nozzles, each particle emitter made or deleted and each sound started: the replay compares the actors, FLUDD, Yoshi and the water requests too (issue kinds `actor`, `fludd`, `yoshi`, `water`; they don't stop a replay). Particle and sound calls are read but not compared as a whole: the emitters' lifetimes come from JPA's own random numbers, whose state is the console's whole session, and no sound runs here.
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
- one Moonshine setting the trace doesn't record, **Shiny Shines**: it makes a collected Shine share the item manager's model instead of loading the blue one, so everything allocated after it sits lower. When Mario's address at his first record differs from the recording's, the replay boots again with it on;
- an event script's lock word: `TSpcInterp`'s constructor never writes `mLocked` (+0x14), so a script starts with whatever the console's heap had there: 0 (each update runs 0x20 instructions) or not (each runs to the script's `yield`), until the script calls `lock` or `unlock`. It starts as 0 here. `Replay.scriptDoubts` lists the scripts for which the word decided what an update did; when a replay parts from its recording after one, the drivers boot again with that script's word not 0 and keep the replay that follows further (Manta Storm's `appearmanta.sb` ran locked on the recording console: its demo starts the frame after the talk ends, not a frame later);
- Mario's sound handle (`TMario::mSound`, +0x4E4) is not compared: which slot of the sound system his damage voice gets and when it ends is the sound hardware's doing, and no sound runs here. The game only starts and stops the sound through it.
- uninitialised bytes of the other recorded objects, as Mario's: an actor's at its first sample, FLUDD's and Yoshi's at theirs, and the padding in a water request object (`TWaterEmitInfo`'s parameters) at its first request;
- a sound the game waits for: Manta Storm's hotel rises when the all-Mantas-dead jingle has ended (`TBossMantaManager::TMantaBattleState::update` waits for its handle to be null again). No sound runs here, so the handle would be null at once and the hotel would rise 600 ticks early. The handle reads as the recording shows it: null in the tick before the one in which the recording makes the hotel's particles;
- what the console's session left in a static: `TShine::mUpSpeed` is 1 at boot and `TShine::appearSimple` leaves it 2 for the rest of the session. The recording's own Shine says which (the first run of three equal rises a frame), and the static is set to that as the stage starts.

## Where it stands (2026-11-10)

A recording counts as in step while every `rand()` call (caller and seed), every frame's seed and director state, and Mario's and the camera's records at every movement tick are bit-identical with it.

Whole recordings in step to their end: Ricco Harbor 3 (`a/2A1D8909_80000002`), Delfino Plaza (`…2D`, dolpic7), Bianco Hills 7 (`…34`), a Corona secret (`…15`, coro_ex1), a Noki secret (`…30`, mare_ex0).
Still in step when the test's time limit cut them: Delfino Plaza (`…2F`, dolpic9), and Pinna Park 1 (`…0B`) through three stages (pinnaParco0, pinnaParco6, the Mecha-Bowser fight) with each stage's seed, flags, NPC phase and heap equal to the recording's at its start.

The whole batch (124 recordings, 2026-11-10, after the texture-coordinate arithmetic below): 93 replay to their end, and 175,873 of 205,745 frames are in step (83 and 162,044 before it); none got worse.
Manta Storm (`b/A7E1056F_80000013`, sirena0) replays to its end with nothing off (2026-11-11): 3,299 frames, 11,720 movement ticks, 3,493,919 `rand` calls, every one of its 319 recorded actors (the 128 Mantas among them) at every frame, FLUDD, Yoshi and FLUDD's 1,252 water requests. It stopped at frame 540 before.
What it took, each found by checking, none by the goop: the Manta script's lock word, Mario's sound handle, the jingle the hotel waits for and the Shine's rise speed (all above). The stop at frame 2,419 looked like a goop texel and was the hotel rising 600 ticks early.
What ruled the goop out: every goop pass of the recording up to there (2,229 frames, up to 510 stamps a frame) was drawn on a Wii with the map carried from pass to pass on the console (`tests/hwprobe.ts chain`), and the console's map equals `ppc/gx.ts`'s after every one of them. The 549 water sounds the recording has sit, bit for bit and on the same tick, where one of the game's drops is here.
In Manta Storm the goop's stamp queues (255 stamps of each kind a frame) overflow: 13,670 goop stamps and 2,245 cleaning stamps are dropped in the game itself.
Four recordings stop with nothing reported where the run leaves its stage and enters it again (Pinna Park Beach 2 at frame 471, for one): a second stage isn't followed yet.

What stops the others:
- **the goop**: the game draws the goop map on the GPU (each layer's map through a fading texture environment, stamps blended over it, a model with vertex alpha under the gatekeeper, all copied back to the texture the collision code reads, pixels counted with `GXReadPixMetric`). `ppc/gx.ts` does those draws.
  It no longer stops anything: with the GPU's arithmetic measured on a Wii (2026-11-10, "The goop: what the GPU does" below) Bianco Hills 1 (7,008 ticks), Bianco Hills 5 (15,108) and Pianta Village 1 (4,201) replay to their ends. Before that they stopped at 4,533, 3,457 and 1,688; Ricco Harbor 1 is in step to tick 3,024, where its first stage ends (see the movie director below);
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

## The goop: what the GPU does, measured on a Wii (2026-11-10)

The goop maps are drawn by the GPU, so the replay needs the GPU's exact arithmetic for those passes. It was first fitted to the recordings (four sample points for the pixels of a 2 x 2 group); that fit was wrong and is gone. `tools/hwprobe` asked a real Wii instead (about 1,000 cases in seven jobs: stamps of every size from 2 to 128 pixels with a corner on every column and row, ramp and saw-tooth textures that show the texture coordinate at each pixel to 1/64 texel, the game's own stamp textures, flat squares on maps of every value, and three goop passes of a recording as they were). What it showed, and `ppc/gx.ts` now does:

- **A pixel takes its texture coordinates at its exact middle.** No difference between even and odd pixels, columns or rows.
- **A vertex past the viewport's middle lands 1/12 pixel lower.** Screen positions go to the rasteriser's grid of 1/12 pixel rounded down, and what is rounded is a hair smaller in size than the exact product: a vertex exactly on the grid right of (below) the middle comes out one twelfth lower, one left of (above) it stays, the middle itself stays. Seen on 256-pixel maps (129 and up shifted, 128 and down exact) and on 512-pixel maps (257 and up, 256 and down). A stamp across the middle is so stretched by a twelfth; one past it is moved by a twelfth.
- **Texture coordinates have 6 fractional bits** (1/64 texel), rounded down, and one exactly on a 64th comes out one lower (24,944 such pixels in the dense job, every one).
- **Bilinear filtering mixes along S first, each pair to 8 bits, then the two results along T**, with the 6-bit fractions. One sum of four weights (what Dolphin's software renderer does, with 7 bits) is off by one in many places.
- The blender and the layer's fade (the map's own quad) were right as they were: every value of the flat-square cases matches.

- **Texture coordinates come from two weights with a reciprocal cut short** (jobs 8 to 11: one stamp with the texture 16 to 1,024 times across, so that the rounding grows to whole 64ths; thin stamps of every length from 2 to 121 pixels; the same stamp on every row).
  Vertices 1 and 2 of a triangle each have a weight that is 0 on the edge facing it and 2^N at the vertex, with N = 10 + floor(log2(the triangle's area doubled, in 1/12 pixel squared)).
  The weight's step for 1/12 pixel across is (the facing edge's height << N) / area, and down (its width << N) / area, each rounded DOWN, toward minus infinity.
  The weights count from vertex 0, and the coordinate is vertex 0's plus each vertex's difference times its weight / 2^N.
  So the slope along a stamp of d twelfths is floor(2^N / d) / 2^N of the texture's length, not 1 / d: this matched all 120 lengths, at three places on the map, for S and T.
  Because a negative step rounds away from zero, the triangle of a quad where both weights change (S in the upper right one, T in the lower left one) loses one unit of 2^-N for every 1/12 pixel along the other axis.
  `Gx.raster3` does this for triangles without perspective; with perspective the old plane is kept (not measured).

With this the three goop recordings that stopped (Bianco Hills 1 at tick 4,533, Bianco Hills 5 at 3,457, Pianta Village 1 at 1,688) replay to their ends with no issue.

Still open (the model is wrong in 180 of about 12 million texels of the grid job, 752 in the dense job, 274 on 512-pixel maps; before the weights: 288, 1,132 and 423): the console loses a little more than the weights explain.
What the jobs show about it, none of it turned into arithmetic yet:
- at the game's scale it only shows in stamps with a vertex past the middle, in the triangle where both weights change, on coordinates up to about 60 units of 2^-N above a 64th;
- with the texture 1,024 times across it shows everywhere: the loss grows along the row, odd pixels lose more than even ones (first odd pixels fail, about 23 pixels later all), and it is the same on every row of the map;
- it depends on the column on the screen, not on the distance from the stamp's corner: a 100-pixel stamp starting at column 0 to 5 fails from column 57 (odd) and 80 (even), one starting at column 6 to 24 from 81 and 106. 25 pixels is 2^20 in 64ths there, so the steps look like a value kept in two parts or in floating point;
- two stamps of the same shape, with the same weights at a pixel, can differ (dense job, 14-pixel stamps across the middle).
The scratch scripts for these are `amp*.py`, `sw*.py`, `wt*.py`, `pl1.py` and `res*.py` in the workspace's `/tmp/claude-0/hwp` (not kept); the jobs are `tests/hwprobe.ts script` with `AMP=1`, `SWEEP=1`, `SWEEP=2` and `SWEEP=3`.

`tools/goopfit/` (the fitting tools) and the captures they read are history; they still run but nothing depends on them.

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

## Asking a real console (`tools/hwprobe/`, 2026-11-10; running on the user's Wii since then)

Where a recording can't say what the hardware does, a Wii can be asked. `tools/hwprobe/` is a Wii program (`source/main.c`, built with devkitPPC and libogc 3.2; `make DEVKITPRO=...`) that takes jobs from a small server on a PC of the same home network (`server.py`, standard library only), runs them and sends back the answers. The console connects out to the PC named in `apps/wiiprobe/server.txt` on its SD card and takes jobs only from a server that proves it has the key in that file. Jobs are files dropped in the server's `jobs/` folder; answers appear in `answers/`.

A job is a script (`script.ts`, `wiijob.py`):
- blocks of memory to set, GPU commands that go to the GPU's command stream as they are (only addresses are set to where the blocks are), blocks to save afterwards: a draw of the game replayed on the real GPU;
- reads of memory and hardware registers;
- small pieces of PowerPC code to load and call (`blob/`: linked for the console's code buffer, may call anything in the program, all of libogc included, by the build's `.elf`). A fault in such code comes back as a record with the registers and the job goes on. Code can stay and add operations of its own, so new abilities don't need a new program on the console.

What keeps it unattended: a job that stops the program for 90 seconds makes it write what it was doing and the GPU's state to `crash.log` (card and server) and restart the console; with Priiloader set to start the program, it comes back and reports. Before every case and every call the answer so far is sent, so a job that never ends shows where it was (`failed/NAME.partial`). Holding RESET as it starts leaves to the Wii menu.

Checked without a console (`hosttest/`): the same `main.c` built for big-endian PowerPC Linux with a stand-in for libogc and run under qemu against `server.py`: the greeting and key, a GPU script (the bytes sent to the GPU are the same as `tests/hwprobe.ts feed` gives), a code job, a hang (log to card and server, handed over after the "restart"). The fault handling and everything that touches hardware are not checked this way.

The goop's questions are `tests/hwprobe.ts`: `capture` records goop passes of a replay as the GPU got them (registers, textures, commands up to the copy; `Gx.rec`), `script` turns them into a job: passes as they were, and cases of the script's own: stamps of every size from 2 to 24 pixels with the corner on an even or odd column and row, in three arrangements, with ramp and saw-tooth textures from which the texture coordinate at each pixel can be read to 1/64 texel, the real stamp textures on a flat map, stamps of 64 pixels with flat squares on maps of every value (the blender's table), and bigger stamps. `check` / `model` run the job through `ppc/gx.ts` (the passes as they were give back the replay's own maps); `compare` sets a console's answer against it; `tools/hwprobe/analyse.py` reads the sample points out of an answer (on `ppc/gx.ts`'s own answer it finds 0.65625 and 0.59375, the model's).

`chain <trace> <prefix> <last tick>` makes jobs of every goop pass of a replay in which the layer's map is sent once and then left to the console: each pass draws over what the console's own last pass left, so the answers are the console's goop map after every frame of the recording. `chaincmp` checks each job's first save against the last job's final map (the console's memory must not have been touched in between), compares every pass with `ppc/gx.ts`'s own map and writes the console's maps out. Manta Storm's 2,229 passes are nine jobs of 4 to 12 MB and take about ten minutes on the console.

What else it is for, once it runs: the CPU (every floating-point and paired-single instruction on random operands against `ppc/fpu.ts`, the estimate tables, the quantised loads and stores, undefined corners), the rest of the GPU as it is modelled (depth, the copy filters, other texture formats, the pixel counters), and whole frames of the game redrawn on the console, should the viewer ever draw with this model.
