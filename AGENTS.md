# Guide for agents working on the ghost viewer

Read this whole file before you change anything.
It is the shared memory of the agents that worked here before you.
**Update it every time something is fixed, refuted or learned** (the "Fix log" and "Open threads" sections at the end), in the same commit as the change.

The older `HANDOVER-*.md` files are from 2026-10-20 and partly out of date; this file wins where they disagree.

## What this project is

Moonshine records Super Mario Sunshine runs on a real console or emulator (ghosts, and "traces" that also record the RNG, the director, the pad, actors and more).
This repository is a web viewer for those recordings, plus **Simulate**: a TypeScript port of the game's own code that replays a run's recorded pad inputs and should reproduce the recorded path bit for bit.
The port is written function by function from the matching decompilation and, where the decomp is unsure, from the DOL's disassembly.
The main measure of progress is how long each recorded run stays in sync before its first drift.

## Rules (from the user; never break them)

1. **No guessing in game code.** Every change must match the decomp, and the DOL where the decomp is NonMatching or unsure. Read the function; don't tune behaviour.
   Data the game itself recorded in a trace (Mario's flag word, the RNG log, feedback records) is evidence and may be used; an assumption is not.
2. **No fake fixes.** A change that only makes some replays line up, without a decomp-matching reason, is not a fix, even if it helps several runs. It won't carry over to future replays.
3. **Prove every change with a full batch** (all ~143 traces, see "Testing") and report the better / worse counts. If it makes runs worse, revert it, record it under "Refuted", and move on.
4. The user's own disc only. The site hosts **no game data**; the viewer reads the user's files in their browser.
5. No autonomous work on the decomp's middleware (MSL, MetroTRK, THPPlayer, dolphin SDK, JSystem); the decomp repos are read-only references for this project anyway.
6. Do **not** push to or even inspect the `agent-mailbox` repository unless the user explicitly asks.
7. Decline the user's account cookies; downloading needs the user's permission.
8. Commit and push every finished change (a stop hook refuses to end a turn with uncommitted changes). Keep experiments out of commits: save them as a patch file instead.
9. Commit messages end with the attribution lines your session's system reminder gives (Co-Authored-By, Claude-Session). Use yours, not ones copied from old commits.

## Build, deploy

- Build: `cd web && node build.mjs` (production build into `../site`, which is committed).
- Push: `git push origin HEAD:main`. GitHub Pages deploys from the workflow; check with `gh run list`.
- The site is the user's; a stale `site/` is a stale site, so always rebuild before committing source changes.

## Where things are

| Path | What |
|---|---|
| `web/src/game/` | The simulation (the game port). |
| `web/src/game/scene.ts` | `Stage.runFrame`: one game frame = 4 ticks; the perform lists' order (Movement, Console, CalcAnim on the last tick). |
| `web/src/game/runner.ts` | `SimRunner`: sets a stage up from a ghost or trace (start state, pauses, demo end, frame pads, RNG and feedback replay), runs it, checks drift. |
| `web/src/game/player/` | TMario: `player.ts` (PlayerMario, director states, intro timing), `move.ts`, `run.ts`, `jump.ts`, `wait.ts`, `watergun.ts`, `emario.ts` (Shadow Mario), `fmath.ts` (f32 helpers). |
| `web/src/game/camera/polar.ts` | CPolarSubCamera (unk258 is the yaw Mario's intended yaw adds). |
| `web/src/game/water.ts` | TModelWaterManager (FLUDD's drops). Checked against the DOL, constants included. |
| `web/src/game/talk.ts` | Talk / the director's game-mode changes (pause entry). |
| `web/src/game/feedback.ts` | GPU feedback replay (occlusion, bath water height). |
| `web/src/game/engine.ts` | Hit check (TObjHitCheck), conductor, live actors. |
| `web/src/ghost/mstr.ts`, `mstrghost.ts` | Trace (MSTR / .msgt) reader and its conversion to a ghost with `g.trace`. |
| `web/src/hud/` | HUD and menu overlays (the pause menu replay). |
| `web/viewer.html` | The viewer page (Info box is off by default; localStorage `ghostViewer.infoBox`). |
| `web/tools/harness/` | The command-line test harness (see "Testing"). |

## References

- Decomp (read-only): `/home/claude/pub/SMS-Decomp-{JP-1.0,JP-1.1,US,PAL,KOR,3DAS}` (GitHub: Aetherion28/SMS-Decomp-*). One source tree, regional code behind `VERSION_*`; the viewer follows with `src/game/version.ts` (see REGIONS.md).
  Each has `config/<ver>/symbols.txt` (addresses and sizes) and its own CLAUDE.md on decomp methodology.
- DOL disassembly: the PAL DOL at `/tmp/claude-0/palx/main.dol` (from the user's disc) with `python3 -I /tmp/claude-0/doldis.py <dol> <hexaddr> <hexlen>` (capstone, skipdata). Find addresses in the PAL `config/GMSP01/symbols.txt`. The script must not be named `dis.py` (it shadows a Python module).
  To read a float constant, find r2 (PAL `_SDA2_BASE_` = 0x8040E280) and read the DOL at r2+offset.
  Map a game address to a function: look it up in the matching `symbols.txt` (JP addresses for JP traces' RNG callers).
- Speedrun guide (per-level routes, skips, techniques): https://smscommunity.github.io/sms-guide/ , source cloned at `/home/claude/refs/sms-guide` (`_game/shines/<world>/episodeN.md`, `_game/techniques/`). Check what a run is doing before calling a desync a code bug.
  Examples: Pinna Park ep 1 pauses and picks Exit Area to skip a cutscene; buffered spinjumps are everywhere.
- IL database, rough reference only: `/home/claude/refs/sms_il_*`.
- The claude.ai project "SMS" has a doc `claude/references.md` with the same rules and references.

## Game facts the port depends on (all verified)

### Ticks and labels in a trace
- A frame is 4 sim ticks. A Mario record labelled L is the state after tick L.
- A frame record W covers ticks W+1..W+4; its records are labelled W..W+3.
- The director record `qf` is W-1: the state before that frame's `direct()`.
- RNG and water-request records labelled L belong to sim tick L+1 (in the harness, the sim's `tickCount - 1` equals the record's label).
- The feedback (kind 15 literal) record for a read in tick L has label L, the same as Mario's record.
- The harness's RNG stack log (`RNGSTK`) is printed one call late; don't read a one-call offset there as a bug.

### Director
- The `changeState` after a frame's last tick runs at the start of the next frame, after the pad read; that's how pausing on Start freezes the whole frame.
- STATE_PAUSE_MENU (5) and 10, 11, 12 skip CUE_MOVE (`mMoveTickCount` stays) while `tickCount`, the console and the director's movement run (`NO_MOVE_STATES` in player.ts).

### Moonshine's own menu
- Frame record word 6 is the director state; word 7 bit 0 means Moonshine's menu is shown.
- A frame doesn't run when the menu is shown (in its record or the next one's) **and** Mario didn't move in it.
- Frame-start pad records (`s.input[4] & 0x80`) are kept as `inputs.framePads` (the pause menu replay uses them).

### Occlusion (MARIO_FLAG_OCCLUDED, bit 0 of Mario's flag)
- Set by `TMario::drawSyncCallback` from the Z buffer, so the sim can't compute it. The camera (`ctrlNormalOrTowerCamera_`, faster follow when occluded) and the silhouette read it.
- Newer traces record each read (feedback records). Older ones don't, but Mario's flag word is recorded every tick, and its bit 0 at the same label equals the read (2628/2628, 2584/2585, 12980/13164 in three JP traces). `mstrghost.ts` builds feedback from it for those traces.

### Water (TModelWaterManager)
- Move loop order and constants are checked against the PAL DOL (0x802767D4): gravity from the particle type's prm (`/Mario/WTP00_Normal.prm`…, e.g. type 0 -0.4, type 15 Hover -1), landing test `!(1.0f + ground < y)`, rand11 = ((rand() & 0xFF) - 128) / 128.
- The hit check (`checkWater`) runs on every 4th move tick; a particle's hit actor stays set until the next check.
- RNG sites (JP): 0x8015df70 hit-splash roll, 0x8015e3f4 surface ripple roll, 0x8015e540 ground splash roll, 0x8015e600 stay-on-ground roll (K[0] 0.5, or K[1] 0.35 with the L camera), 0x8015f1fc… makeEmit.

### Other verified details
- `checkStickRotate`'s `BOOL q[4]` is uninitialised stack in the game (the sim starts them at 0; carrying them over is refuted, see below).
- askHit uses fabs; TMapObjBall::touchWater uses fmadds; checkWater, getSideWalkValues, squating and move's hv match the DOL.

## Testing

Everything below runs in the cloud workspace; paths under `/tmp/claude-0` are that workspace's and may need recreating.

- **Traces**: the user's recordings, from their uploads (`/mnt/user-data/uploads/ghosts`, archives they sent). The batch set is in `/tmp/claude-0/up3/{a,b,c}/*.msgt`; `web/tools/harness/list4.txt` lists the 143 used (path, region, end QF) and `catalog.tsv` describes them. Never commit traces.
- **Game files**: the user's extracted disc at `/mnt/user-data/uploads/Games/_ghostviewer_extract/` (JP); PAL scenes at `/tmp/claude-0/palscene/data/scene` (`SCENEDIR`).
- **Harness** (`web/tools/harness/`, normally run from `/tmp/claude-0/ct`):
  - `pm.ts` replays one trace through the viewer's code: `node bpm.mjs pm.ts pm.mjs` bundles it, then `node pm.mjs auto <trace> <endQF>`. It mirrors `runner.ts`'s setup, so **new runner features must be mirrored in pm.ts**.
    It prints `[player] input replay drifted … at stage QF n` and a `SUM … drift {...}` line.
  - Env switches in pm.ts (many): `TICK=a-b` per-tick Mario state; `CAM`, `CAMD`, `CAMP` camera; `RNGSYNC=1 RNGCMP=n` compares the sim's RNG with the trace's; `WPART`, `PTRACK`, `EMITLOG`, `WTELL` water; `TALKLOG`, `EVLOG`; etc. Read the file.
  - `pm_debug.ts` is pm.ts plus more probes (`NPCHIT`, `CAMX` camera vs trace per tick, `CXL`, `WPROBE` walls, `GPROBE` ground, `WPOS`, `BOIDC`, `RNGSTK` RNG call sites with the sim's caller, `WTYP`).
  - Small readers of a trace: `gv.ts` (Mario per tick), `giy.ts` (intended yaw), `cyaw.ts` (camera yaw), `rk.ts` / `rcall.ts` (RNG calls with callers), `wreq.ts` (water requests), `fb.ts` / `fbcmp.ts` (feedback records), `ahit.ts` / `anear2.ts` (raw actor words: hit radii at 0x50–0x60).
  - `tdiff.sh <trace> a b` prints sim vs trace per tick (position error, status, forward speed, vy, face angle, flags).
  - Batch: `RUNS=runsNN ./run.sh <path> <region> <end>` per trace, e.g. `cat list4.txt | xargs -P 2 -L 1 ./run.sh`, then `python3 cmp.py runs_old runs_new` prints the bucket table and each run better / worse. A batch takes about two hours with 2 processes; run it in the background.
- The latest full batch is `/tmp/claude-0/up3/runs20` (plus the occlusion fix, re-run for its 17 traces in `runs22`).

## How to investigate a drift (the workflow that has worked)

1. Find the first drift: the run's log in the latest batch (`grep drifted`), or `node pm.mjs auto <trace> <end>`.
2. `tdiff.sh <trace> <first-30> <first+5>`: the first tick where any field differs (position, forward speed, vy, face angle, status, Mario's flag word) is the real start; the position drift threshold comes later.
   The trace's Mario record holds much more than the harness prints (MARIO offsets in `ghost/mstr.ts`: slideVel 0xb4/0xb8, floor 0xe8, flag 0x118, …), so compare the field the suspect code reads.
3. Work out which input changed: intended yaw (`giy`) → camera yaw (`cyaw`, `CAMX` compares the sim's camera with the trace's eye / look-at every tick: rec `eye` is unk124 / mPosition, rec `target` is unk148), a flag bit (often set by something other than Mario), a status change.
4. If the RNG is involved, compare call sites: `rk.mjs <trace> a b [regex]` lists the game's calls with callers; map a JP caller to a function with the JP `symbols.txt` (see the snippet below). `RNGSYNC=1 RNGCMP=n` reports the first seed or tick mismatch, but it allows ±4 ticks, so a call made at the wrong site in the same frame can hide; use `RNGSTK` (pm_debug) to see the sim's site for each call.
5. Read the decomp function, then the DOL where the decomp is unsure, and compare with the port line by line. Fix only what disagrees.
6. Run that trace, then the full batch, then commit, then update this file.

Caller lookup (JP traces' callers):

```python
import re
syms=[(int(m[2],16),int(m[3],16),m[1]) for l in open('/home/claude/pub/SMS-Decomp-JP-1.0/config/GMSJ01/symbols.txt')
      for m in [re.match(r'(\S+) = \.text:0x([0-9A-F]+); // type:function size:0x([0-9A-F]+)',l)] if m]
def who(a): return [(n,hex(a-s)) for s,z,n in syms if s<=a<s+z]
```

Common JP callers: 0x800c2458/24ac/2504 TTrembleModelEffect::tremble (Mario's cap, 264 calls a tick), 0x80363904 TBoidLeader::calcForces (fish / birds, on frame ticks), 0x801ebcb0/cec TPollutionLayer::action, 0x80168ad0 TBaseNPC::npcWetIn, 0x80169ee0/f7c and 0x80171818 NPC code, the water sites listed above. The GPU-feedback "callers" per game ID are in `mstrghost.ts` (`FEEDBACK_SITES`).

## Trace contents worth knowing

- Record kinds (`ghost/mstr.ts` `KIND_NAMES`): session, frame, Mario, camera, flags, actor, actor_removed, FLUDD, Yoshi, sound, particle, the RNG (15, which also carries the feedback literals), stage start (22), run flags (28: 1 assisted, 2 savestate, 4 fast-forward, 8 incomplete, 16 custom route, 32 TAS).
- Actor records are the actor object's first 0xF4 or 0x150 bytes, sent as changed words. Offsets: position 0x10, THitActor type 0x4C, attack radius 0x50, attack height 0x54, damage radius 0x58, damage height 0x5C, entry radius 0x60, hit filter 0x64; velocity words 43–45, live flag word 60 (0x150 records). Only some actors are recorded.
- A Mario / camera blob persists between records (only changed words are sent), so each tick's view is the real memory state.
- Water requests (`wreq`) are the TWaterEmitInfo the game passed to emitRequest: pos, v, dir, pow, size, tremble values, type, flag.

## Pitfalls

- `pgrep -f` matches itself and hangs watch loops; use background jobs and their notifications instead.
- The harness (pm.ts) re-implements setup; if you add a runner feature, mirror it there or the batch won't test it.
- `RNGSTK` prints one call late, and its sim tick label is `tickCount - 1`.
- The drift check (`checkMoved`): for a trace, the game moved in frame q iff a Mario record exists for one of q-4..q-1; the run's closing ticks (after `traceLastMove`) aren't checked.
- Remember the frame structure when comparing order: in `Stage.runFrame` each tick runs the hit check (every 4th move tick), the Movement list (conductor, wires, player and camera, water, events), the console, and on the last tick CalcAnim. The game's object order inside a list decides RNG order; check it with the trace's callers.
- A test hook in game code (e.g. `process.env` checks) must not be committed; keep experiments as patches.
- Background batches outlive a turn only as harness-tracked background tasks; a plain `&` job is killed.

## Current results (2026-11-04)

First drift per run, 143 traces:

| Desync | Runs |
|---|---|
| under 1 s | 0 |
| 1–5 s | 5 |
| 5–15 s | 49 |
| 15–30 s | 32 |
| 30 s+ | 8 |

48 runs stay exact to the end.

## Open threads (where to pick up)

- **Ricco Harbor "ricco2" cluster**: six runs drift at ~10.2 s (QF ~1227) at once by 14–90 units. At QF 1227 in a/trace_2A1D8909_80000008 the sim switches Mario to status 0x208B0 (forward speed -16) while the game stays in 0x896. Find what sets 0x208B0 there (a bonk / collision?) and why the game doesn't. Next to investigate.
- Other ~10 s drifts: bianco0, mamma2, mamma5, pinnaParco2, pinnaBeach3, dolpic_ex3, dolpic10 (QF 1188–1300); may share a cause.
- **Water drops land / hit a little earlier in the game than in the sim** (Noki Bay mare1 b/A7E1056F_80000028 at 4.9 s; Delfino dolpic10 c/…065 at 1.6 s and …067 at 3.1 s). The drops' emission matches the recorded requests and the move code matches the DOL, yet the game's drop hits the NPC (マーレＢ, cylinder r 80, h 110) or the ground 1–2 ticks before the sim's. The difference decides MARIO_FLAG 0x10 (RECENTLY_LEFT_WATER) and so dive-slide friction. Cause not found; don't tune it.
- dolpic_ex2 c/…05E at 3.8 s: the game spinjumps at QF 457. Related to `checkStickRotate`'s uninitialised `q[4]`; the leftover stack values would need modelling from evidence.
- Bianco b/41726535_80000023 (104 s): the camera's yaw step changes a tick early, which moves the intended yaw and the side-step position by 1 ulp. That trace has feedback records, so it isn't the occlusion fallback.
- Long runs (>30 s): five Sirena runs (ask the user before working on these), Gelato 4 (TSpcInterp mLocked is garbage), Pianta 8 (GPU pollution counter), Delfino bell (water hits on the bell).
- coro_ex1 a/2A1D8909_80000015: assisted / TAS with sparse ticks.

## Refuted (don't retry without new evidence)

- Carrying `checkStickRotate`'s q[4] over between calls (a persistent buffer): 57 runs worse, 3 better (runs21 vs runs20). Patch kept at `/tmp/claude-0/qpersist.patch`.

## Fix log (newest first)

- 2026-11-04 `6deed34` Occlusion: traces without feedback records read MARIO_FLAG_OCCLUDED from Mario's recorded flag word. Pinna Park 1 a/81BCC929_263FE90D: drift at 2.97 s → none. The other 16 such traces unchanged.
- 2026-11-04 `8c770e1` Moonshine's menu stops the game only in frames where Mario didn't move.
- 2026-11-04 `a56ab60` Pause menu overlay (with the cursor moves) during a trace's pause; Info box off by default.
- 2026-11-04 `656e43a` Moonshine's menu stops the game; the run's closing ticks aren't drift-checked.
- 2026-11-04 `8225b30` Drift check: Mario frozen in the sim while the game moved him (or the reverse) counts as a drift.
- 2026-11-04 `9f567e3` TMapObjBall::touchWater uses fmadds (as the DOL).
- 2026-11-04 `769c938` Pause menu (pause and Exit Area), Shadow Mario's talk (7 runs exact), Corona Mountain's start, the coaster cart drawn.
