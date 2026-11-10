# Suggestions (kept for the user; share only when asked)

Agents: add suggestions here instead of raising them in chat, newest first, with the date and the evidence.

## For Moonshine's recorder

- 2026-11-06 Record Yoshi's body animation frame (his MActor's frame control: the BCK ID and frame), next to PR73's Mario animation sample. FLUDD's spray on Yoshi comes out of his tongue joint, so its direction depends on his pose. In ricco7 (b/41726535_…03F, QF 6385) Mario jumps on Yoshi with A+R; the spit's lift on Mario is 0.26 in the game and 0.05 in the sim, the sim's tongue pointing about 12° higher. The trace's Yoshi record only has the upper body's eat frames (TYoshi +0x5C), so the body's pose can't be checked.

- 2026-11-08 Record the gatekeepers (TBiancoGateKeeper and its head hit object, TGKHitObj) as actors, and with them their wake counter (unk17C, a u16 at 0x17C) and hit count (unk154 at 0x154), which are past the 0x150 bytes an actor record holds now. In Bianco Hills 1 (a/41726535_…003) the sim's gatekeeper wakes at 2335 and the game's at about 2903. The wake rule matches the decomp, so the counter per tick would show exactly which ticks the game's spray hit it and where the sim's water starts to differ. It would also let the gatekeeper's cutscene fix go in.


- 2026-11-06 Mark the frames where Moonshine holds the game outside a menu. Some traces have long runs of frames (180 to 250) where the movement tick doesn't advance, the director stays in state 4 and the frame record's menu bit is clear: c/A7E1056F_8000006D (frames 900 to 1150, tick 2013), …051 (frames 1606 to 1786, tick 5288), …03D (tick 5833). The game didn't move there, but nothing in the record says why, so the viewer can't tell them from an in-game freeze it has to simulate (a Shine demo stops the world the same way) and its replay runs on through them. A bit in the frame record for "the game was held this frame" (a savestate's disk write, the stage loader or warp wheel holding updateGameMode, or anything else) would let the viewer skip exactly those frames.

- Record the PB-blocking state the trace can't show yet: the active PB profile (the hoverless profile's hover), the IL entry (FLUDD in a Secret-only IL), a ghost being watched, and Gecko codes that change gameplay (a run with the "DPad Functions" code, mamma0 trace_2A1D8909_80000014, has run flags 0: X + D-pad Up forces Mario into TAKE). The viewer now tags such runs TAS only when it can see the code's effect.

- 2026-11-05 Record TMario::checkStickRotate's result where the game makes it (JP 0x80130758: the return value and *outDir, or the four quadrant words `BOOL q[4]` at sp+0x10..0x1c just before `cmpwi r3, 4` at 0x801308A8), as a literal record like the GPU feedback ones. The flags are never initialised: the game reads whatever the stack held, often a 1 left by an earlier check through the same call chain, unless other code or an interrupt handler wrote over it since. The inputs can't decide it. Evidence: dolpic_ex2 c/…05E spin-jumps at QF 457 with a stick history (all recorded intended yaws match the sim's) that only covers three quadrants. The replay now infers the result from Mario's recorded status (the spin the caller would start), but that can't tell a leftover flag from a check that failed and a spin started some other way. The recorded result would make it exact.

- 2026-11-05 Record Mario's animation frame (M3UModelMario's body frame control, fc[0].frame) in the Mario record. The trace has the animation ID but no frame, so the viewer can only guess the pose while it follows a run the simulation has drifted from.
- 2026-11-04 — Record the crane-speed setting (and any other option that changes game behaviour) in the trace, e.g. as a run flag or in the stage-start record.
  The viewer currently works the Ricco cranes' speeds out from their recorded angles (traceCraneSpeeds), because the setting isn't in the trace.
- 2026-11-04 — Record the movement-state of each Ricco crane at stage start (its speed), so a trace that starts mid-swing or has no crane records still replays.

## For Moonshine's replay on the console: a memory dump (asked for on 2026-11-10)

What it is for: the game replaying a trace on a real Wii is the one place where the game's true memory exists. v3 runs the same code and claims the same memory; a dump from the console at chosen ticks proves or disproves that byte by byte, and shows the first difference wherever a replay here stops (the goop maps, the water drops, the Mantas, memory the game never set).
This is not a new record in the traces: it happens only while a recording is played back on the console, into a file of its own.

1. **The request**: a file on the card, for example `Moonshine data/dump/request.txt`, one line a dump:
   `tick address length` (hex; the tick is the record header's `movementTick`), or `tick ALL` for the whole of MEM1.
   Plain addresses are enough: v3 knows where everything is at every tick and writes the request.
2. **When**: at the point a tick's Mario record is taken (the start of his perform), so a dump at tick L lines up with the trace's records labelled L.
   Tick 0 (before the first movement tick) should be possible: with `ALL` it gives the console's memory as the stage starts, leftovers included.
3. **The answer**: one file a playback, for example `Moonshine data/dump/<the trace's name>.dump`: for each line of the request a header (`sourceFrame`, `movementTick`, address, length) and the bytes, in the request's order.
   Playback may stall while it writes; nothing in a playback depends on real time.
4. **Limits to state**: how many bytes a playback may dump (a few `ALL` dumps of 24 MB would already answer most questions), and what happens when the card is full (stop dumping, keep playing, say so in the file's last header).
5. **If a check fails** (the playback's own desync check): dump `ALL` once at that tick, even when the request doesn't ask. That one file usually names the cause.
6. **Later, for unattended use**: a way to start a playback without the menus, from a file the launcher reads (the game's region, the trace to play, the request), leaving to the Wii menu when the playback ends.
   With Priiloader starting wiiprobe (web/v3/tools/hwprobe), the console could then run a list of playbacks and hand the dumps to the PC by itself: wiiprobe can read the card and send files.
