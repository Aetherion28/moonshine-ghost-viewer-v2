# Handover: fuller ghosts from live-play recording

For the agent helping with Moonshine development.

## Background

The v2 viewer has a hidden gamepad live-play mode.
It runs the stage with the player Mario, and F9 (or Z on a GameCube pad, Select on others) records the run as an `.smsghost`.
The recorded file replays in sync in the viewer and in the test harness, because live play uses the same stage opening and seed 0 that a replay uses.
The file is written by `web/src/game/ghostwrite.ts` (`writeSmsGhost`).
It is an SGHF v7 file: one segment, 16-byte pose samples, and an SGTI v3 section with one 24-byte record per frame.
The frame's input record is built by `liveFrame` / `LiveRunner` in `web/src/game/runner.ts`.

## What the recorded ghosts leave out

Everything below is known to the sim at record time, but is not written.
None of it affects replay sync, since the replay is driven by the pad and the seed.
It only matters for how complete the file looks to other tools, and for Moonshine itself.

1. **FLUDD observation bytes.**
   Only byte 0 is filled: `0x08 | nozzle | 0x10 while spraying` (runner.ts, around line 562).
   Offset, yaw, pitch and power are left at 0.
   The sim has these values for the live Mario's FLUDD, so they could be written.
   Check Moonshine's own writer (`aetherion28/moonshine`, the ghost recording code) for the exact layout, units and scaling of those bytes before filling them in.
   Match what a real Moonshine recording writes.
2. **Yoshi observation.**
   Yoshi's pose is written (flag 0x80, BCK id, frame x 16, blend), but the juice bit is not set.
3. **Camera (SGCA).**
   No camera section is written, so the file is v7 rather than v8.
   This is on purpose.
   A recorded camera would make the replay steer against it instead of the sim camera.
   If a camera section is ever added, replay must keep using the sim camera for sync.
4. **Splits and the RNG tape.**
   Neither is written.
   The seed is 0 and the stage opening is the stage's own.
5. **Region byte.**
   It comes from the disc id.
6. **Analog A/B.**
   Always 0.
   The A and B buttons are digital on the real pad, so this is correct and needs no change.

## Things to confirm against Moonshine

- Whether Moonshine accepts a v7 file with a single segment and no SGCA.
- How Moonshine treats the first pose sample, which is the first frame's pose copied back to the segment start.
- Whether positions truncated to 1/8 unit are what Moonshine writes (the recorded file shows a max error of about 0.19 units on replay, which is this rounding).

## Testing

- Record from the viewer (headless harness: `/tmp/claude-0/-home-claude/67c2e065-2cf4-5060-babc-cf5bfa3ca0f2/scratchpad/pad/t3.py`, which fakes `navigator.getGamepads`).
- Replay the file with `node pm.mjs auto rec.smsghost <frames>` in `/tmp/claude-0/ct`; the first desync QF should be -1 and all frames synced.
- Run `./dash.sh` there afterwards and diff against `dash_obj.txt`; the existing ghosts must not change.

## Related deferred item

Mario's cap, Mecha-Bowser's koopa rail, and the hard FLUDD landing are separate sim gaps, not part of this.
