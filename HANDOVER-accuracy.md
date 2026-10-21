# Handover: what would make the viewer more accurate

State as of 2026-10-20, main at the commit that added the wake-up and legal notice.
Goal: bit-exact, input-driven replay of every stage, so a ghost's recorded pad inputs reproduce its recorded path.

## Where replay first drifts (per ghost)

"First drift QF" is the first quarter-frame where the sim's Mario disagrees with the ghost's recorded pose.
Run the dashboard to regenerate this table (see Tools).

| Ghost | First drift QF | Cause, if known |
|---|---|---|
| SB1 | 2452 | Cutscene after the talk (manta appears); Mario should be in T_WAIT |
| SB2 / SB4 | 1336 | Same cutscene |
| NB2 | 1012 | not yet investigated |
| PV4 | 1024 | T_WAIT stretch is a cutscene, not a talk |
| PP3 | 964 | not yet investigated |
| BH1 | 1184 | not yet investigated |
| PV6 | 836 | after the talk is ported; next not investigated |
| realNB1 | 672 | not yet investigated |
| BH4 | 616 | Missing input record in an old Moonshine build (CSX=540:-0.2 confirms); not a sim bug |
| RH4 | 2428 | not yet investigated |
| BH3 | 1720 | not yet investigated |
| SB4b | 1240 | not yet investigated |
| dp3 / PP7 / wire / NB1_v6 | 4 | These start mid-run, so the start state is wrong, not the sim |

## Highest value next

1. **Director demo mode.**
   `fireStartDemoCamera`, demo states 3 and 4, the demo camera BCK lengths, `NO_INPUT`, and `T_WAIT` in WAIT.
   In the game the manta's appear demo runs right after the Sirena 1 talk, and Mario stands in `T_WAIT` for ticks 1320 to 2760 in SB1.
   Without it Mario takes stick input (SB2/SB4) or gets hit (SB1, because he is invincible only in demo mode).
   PV4 and NB1 have the same kind of stretch.
   Also not modelled: the shine, demo and game-over parts of `updateGameMode`.
2. **Mid-run starts.**
   dp3, PP7, wire and NB1_v6 begin mid-stage.
   They need the state at the start to be reconstructable, not just a fresh stage start.
   Savestate export (Moonshine's `src/savestate.cpp` is a raw dump of the stage heap and BSS) would give exact starting state but was set aside for now.
   The plan then was a TAS tape export.
3. **Investigate the unexplained drifts** (NB2, PP3, BH1, realNB1, RH4, BH3, SB4b).
   Method that has worked: run the ghost, find the first QF the pose differs, dump the animation and status on both sides, then read the relevant function in the decomp or the DOL.

## Known sim gaps

- **Mario's cap** (`MarioCap.cpp`) is not simulated.
  DoroHamuKuri treats him as wearing it unless a `mario_cap` item is alive.
- **Mecha-Bowser's koopa rail** (`TMario::mKoopaRail`).
  `enemies/tinkoopa.ts` builds a stand-in from `map/map/koopa_rail`; when it advances is a guess (TODO in the file).
- **Hard landing with FLUDD.**
  `BROAD_JUMP_SLIP` and `floorDamageExec` are not simulated.
- **Script timers** are approximate (`spc.ts`, `eventwatcher.ts`).
- **Map joints.**
  Joint rotation is not exposed to the viewer; the viewer draws map.bmd with the sim's joint positions only.
- **Shadows** are missing from drawing.
- **Specular** is unresolved; `layer.specular` is a debug toggle.
- **Slot drum collision** on delfinoBoss (the Telesa slot's moving collision) is not ported.
- **Joint-object pollution stamp** in AirportEventSink is not modelled (turning the counter off clears the layer anyway).
- **Talk:** `makeBoxLine` cutting a line too wide for its curve is not modelled; the signpost window's text pane is assumed to start at alpha 255.
- **Talk speed.**
  Ghost files do not record whether Moonshine's "Fast text" was on.
  `TalkDirector.fastText` defaults to true, because every recorded talk closes on the first A press.
  Moonshine's own default is off.
  Ideally Moonshine would record the setting in the ghost file.
- **Voice lines:** the same voice id is sometimes posted several times in one audio frame.
  It comes from the sim's voice log or animation sounds, so replays share it.
  `loserDown` voice length (`marioVoiceHooks.playing`) is open.
- **Typical enemy** has no model and no `typical.prm` in params.szs, so defaults are used.

## What ghost files could record to help

- Whether Fast text was on.
- The RNG state at segment start (live-play recordings use seed 0; real ghosts need the tape).
- Any inputs dropped by the recorder; BH4 shows that a single missing input record is enough to desync a whole run.
- The camera is already recorded (SGCA, v8) and used for checking, but the sim's own camera drives replay.
- FLUDD offset, yaw, pitch and power, and Yoshi's juice (see `HANDOVER-live-recording.md`).

## Graphics and look

- Compare against the IL clips: `/home/claude/refs/sms_il_videos.json` (4075 links) and `/tmp/claude-0/yt/clips` (32 Twitch clips), notes in `/home/claude/refs/graphics_findings.md`.
  Most IL runs predate Moonshine, so they will not match a ghost exactly; use them for visuals only.
- Most players use 480p.
  The in-game heat haze does not need adding.
- PAL 50 Hz support was dropped, so PAL runs at 60.
- The copy filter (`layer.copyFilter`) is off by default.
- Live play: the camera cuts from the idle view to the sim camera on start; an ease is in progress.

## Tools

All scratch tools live in `/tmp/claude-0/ct/` and are not in the repo.
They are session-local, so the next agent should copy the ones it needs into the repo first.

- `pm.ts` (build with `node b.mjs pm.ts pm.mjs`): runs one ghost through the sim.
  Env switches: `CAM`, `CMP`, `CSX`, `TICK`, `DBG`, `SPRAY`, `SLIPFX`, `WETCHK`, `VOICES`, `NOYOSHI`, `TALKLOG`, `TW=a-b`, `NPCW=<name>`, `CAMP=a-b`.
- `dash.sh`: runs every ghost listed in `allghosts.txt` and prints the first drift QF.
  Baselines: `dash_wet.txt` (before talk), `dash_obj.txt` (current).
  A change must leave the other ghosts identical unless it is a deliberate improvement.
- `objtrace.ts`: traces objects over time on a stage.
- `simall.ts`, `unreg.ts`, `twice.ts`, `rails2.ts`: smoke test every scene, list unregistered object types, check determinism, and check rails.
- RNG audit: `/tmp/claude-0/rng/callers.py` and `callers.tsv` list all 170 `rand()` callers in the DOL.
  Every one is now accounted for, apart from the 2D `SelectShine2` ones, which are outside the sim.
- Disassembly: `cd /home/claude && python3 -I /tmp/claude-0/cam/dis.py <symbol>`.
- Headless browser: `/tmp/claude-0/-home-claude/67c2e065-2cf4-5060-babc-cf5bfa3ca0f2/scratchpad/gfx/` (`vw.py`, `shot.py`, `det.py`) and `.../scratchpad/pad/` for the gamepad tests.
  Debug hooks on the page: `gameViewer.setView`, `getView`, `layer.copyFilter`, `layer.specular`.

## Code map

- `web/src/game/scene.ts`: `Stage`, `runFrame` (4 ticks per frame), lead frame (objects run one frame before QF 0).
- `web/src/game/player/`: `player.ts` (PlayerDirector, readBillboard, sleepingStart), `move.ts`, `wait.ts`, `pad.ts`, `special.ts`, `yoshi.ts`, `tmario.ts`.
- `web/src/game/talk.ts`: message loader, `Talk2D`, `TalkDirector`.
- `web/src/game/runner.ts`: `ReplayHistory`, `SimRunner`, `LiveRunner`.
- `web/src/game/ghostwrite.ts`: writes `.smsghost` from live play.
- `web/src/game/mapevent.ts`, `eventwatcher.ts`, `spc.ts`, `flags.ts`, `msflags.ts`: map events, scripts, save flags (read and write through `world.flags`).
- `web/src/game/enemies/`, `mapobj/`, `npc/`: stage objects.
- `web/viewer.html`: the page, including the hidden gamepad mode.

## Working rules the user has set

- Match the game 1:1.
  Verify against the decomp (`/home/claude/sms-ai-decomp`, read-only) and the DOL, not memory.
- The viewer must use the user's own disc; the site hosts no game data.
- v1 (`/home/claude/smsghost`) stays up and disconnected from v2.
- Do not use the user's account cookies; they are a live token.
  Ask before downloads.
- Do not post artifacts.
- Push to GitHub after work.
- When several agents edit at once, commit from a worktree: add the worktree, copy in only the files to commit, symlink `node_modules`, build, commit, push, then reset the main tree to `origin/main`.
