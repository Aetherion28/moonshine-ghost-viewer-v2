# Suggestions (kept for the user; share only when asked)

Agents: add suggestions here instead of raising them in chat, newest first, with the date and the evidence.

## For Moonshine's recorder

- 2026-11-06 Mark the frames where Moonshine holds the game outside a menu. Some traces have long runs of frames (180 to 250) where the movement tick doesn't advance, the director stays in state 4 and the frame record's menu bit is clear: c/A7E1056F_8000006D (frames 900 to 1150, tick 2013), …051 (frames 1606 to 1786, tick 5288), …03D (tick 5833). The game didn't move there, but nothing in the record says why, so the viewer can't tell them from an in-game freeze it has to simulate (a Shine demo stops the world the same way) and its replay runs on through them. A bit in the frame record for "the game was held this frame" (a savestate's disk write, the stage loader or warp wheel holding updateGameMode, or anything else) would let the viewer skip exactly those frames.

- Record the PB-blocking state the trace can't show yet: the active PB profile (the hoverless profile's hover), the IL entry (FLUDD in a Secret-only IL), a ghost being watched, and Gecko codes that change gameplay (a run with the "DPad Functions" code, mamma0 trace_2A1D8909_80000014, has run flags 0: X + D-pad Up forces Mario into TAKE). The viewer now tags such runs TAS only when it can see the code's effect.

- 2026-11-05 Record TMario::checkStickRotate's result where the game makes it (JP 0x80130758: the return value and *outDir, or the four quadrant words `BOOL q[4]` at sp+0x10..0x1c just before `cmpwi r3, 4` at 0x801308A8), as a literal record like the GPU feedback ones. The flags are never initialised: the game reads whatever the stack held, often a 1 left by an earlier check through the same call chain, unless other code or an interrupt handler wrote over it since. The inputs can't decide it. Evidence: dolpic_ex2 c/…05E spin-jumps at QF 457 with a stick history (all recorded intended yaws match the sim's) that only covers three quadrants. The replay now infers the result from Mario's recorded status (the spin the caller would start), but that can't tell a leftover flag from a check that failed and a spin started some other way. The recorded result would make it exact.

- 2026-11-05 Record Mario's animation frame (M3UModelMario's body frame control, fc[0].frame) in the Mario record. The trace has the animation ID but no frame, so the viewer can only guess the pose while it follows a run the simulation has drifted from.
- 2026-11-04 — Record the crane-speed setting (and any other option that changes game behaviour) in the trace, e.g. as a run flag or in the stage-start record.
  The viewer currently works the Ricco cranes' speeds out from their recorded angles (traceCraneSpeeds), because the setting isn't in the trace.
- 2026-11-04 — Record the movement-state of each Ricco crane at stage start (its speed), so a trace that starts mid-swing or has no crane records still replays.
