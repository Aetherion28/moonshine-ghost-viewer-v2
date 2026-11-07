# Ghost viewer: everything an agent needs

This is the only agent file in the repository (it replaces the old AGENTS.md and CLAUDE.md).
Read all of it before you change anything.
It is the shared memory of every agent that worked here before you.
**Update it in the same commit as every fix, refutation or new finding**: the "Open threads", "Refuted" and "Fix log" sections at the end.

## 1. What this project is

Moonshine is a Super Mario Sunshine mod.
It records runs on a real console or an emulator: ghosts, and "traces" that also record the RNG, the director, the pad, actors, FLUDD, Yoshi, the session settings and more.
This repository (GitHub `Aetherion28/moonshine-ghost-viewer-v2`, local `/home/claude/moonshine-ghost-viewer-v2`) is a web viewer for those recordings.
Its **Simulate** mode is a TypeScript port of the game's own code.
It replays a run's recorded pad inputs and should reproduce the recorded path bit for bit.
The port is written function by function from the matching decompilation and, where the decomp is unsure or NonMatching, from the DOL's disassembly.
The main measure of progress is how long each recorded run stays in sync before its first drift.
The viewer also draws what the game draws, so a ported object that the viewer can't show yet needs viewer support too (the user asked).

## 2. The user's rules (never break them)

1. **No guessing in game code.** Every change must match the decomp, and the DOL where the decomp is NonMatching or unsure. Read the function; don't tune behaviour.
   Data the game itself recorded in a trace (Mario's flag word, the RNG log, feedback records, actor records, session settings) is evidence and may be used. An assumption is not.
   Uninitialised memory in the game (garbage stack or heap) is taken from the recording, never invented.
2. **No fake fixes.** A change that only makes some replays line up, without a decomp-matching reason, is not a fix, even if it helps several runs.
3. **Prove every change with a full batch** (section 6) and report how many traces got better and how many got worse.
   If a change makes runs worse, revert it, record it under "Refuted", and move on.
   Test many fixes in one batch, and bisect when one regresses.
   If a batch fails badly, go back to the last commit known to be good.
4. The user's own disc only. The site hosts **no game data**; the viewer reads the user's files in their browser.
5. No autonomous work on the decomp's middleware (MSL, MetroTRK, THPPlayer, dolphin SDK, JSystem). The decomp repos are read-only references here.
6. Do **not** push to or even inspect the `agent-mailbox` repository unless the user asks.
   Exception (2026-11-05): when the DOL shows that the decomp's source is wrong, write the Decomp chat a message in `agent-mailbox/decomp/inbox/` (its README has the protocol: what the decomp has, what the DOL does with addresses, the trace evidence) and tell the user the filename.
7. Decline account cookies. Downloading anything needs the user's permission.
8. Commit and push every finished change. A stop hook refuses to end a turn with uncommitted changes, so the tree must be clean at the end of every turn. Keep experiments out of commits: save them as patch files.
9. Before each commit run `git fetch` and `git log HEAD..origin/main`. If another agent's version conflicts with yours, yours stands unless theirs tests better in a full batch.
10. Suggestions for the user go in `SUGGESTIONS.md`, not in chat (ideas for Moonshine go under "For Moonshine's recorder"). The user asks for them when needed.
11. Commit messages end with the attribution lines your session's system reminder gives (Co-Authored-By, Claude-Session). Use yours, not ones copied from old commits.
12. Sirena (Manta Storm, scene sirena0): don't work on its drifts. Refactoring code it uses is fine.
13. The user is short on usage: work quickly, avoid probes that don't decide anything, and don't spawn helpers unless the user asks.
14. Say episodes, not scene numbers: scene files count from 0, so the `ricco5` scene is Ricco Harbor episode 6.

## 3. Build and deploy

- Build: `cd web && node build.mjs`. It writes the production build into `../site`, which is committed.
- A stale `site/` is a stale website, so rebuild before every commit that changes source.
- Push: `git push origin HEAD:main`. GitHub Pages deploys from the workflow; check with `gh run list`.
- `npm install` in `web` after a container reset.

## 4. Where things are

| Path | What |
|---|---|
| `web/src/game/` | The simulation (the game port). |
| `web/src/game/scene.ts` | `Stage.runFrame`: one game frame = 4 ticks; the perform lists' order (Movement, Console, CalcAnim on the last tick). Registers objects that must exist before others load (TalkCursor). |
| `web/src/game/runner.ts` | `SimRunner`: sets a stage up from a ghost or a trace (start state, pauses, demo end, frame pads, RNG and feedback replay), runs it, checks drift. |
| `web/src/game/feedback.ts` | Everything read from the recording: `TraceFeeds` (one object holding the GPU feedback, RNG, status, actor and session contexts that runner.ts and pm.ts both install), `sessionCtx` / `sessionSetting` (Moonshine's settings in effect at a tick), `traceActorCtx`, `traceRngCtx`, `traceStatusCtx`. |
| `web/src/game/player/` | TMario: `player.ts` (PlayerMario, director states, intro timing), `tmario.ts`, `move.ts`, `run.ts`, `jump.ts`, `wait.ts`, `watergun.ts`, `emario.ts` (Shadow Mario), `fmath.ts` (f32 helpers and `fr`; `math.ts` re-exports it). |
| `web/src/game/camera/` | `polar.ts` CPolarSubCamera (unk258 is the yaw Mario's intended yaw adds), `jetcoaster.ts`, `shake.ts`, `lib.ts` (CLB helpers, setRotate33). |
| `web/src/game/mapobj/` | Map objects. `base.ts` MapObjBase (`marioIsOnActor` / `marioIsOn` / `marioHipAttack` as the decomp, `animatedRoot`, `anmRoot`). One file per area or family (corona, pinna, ricco, bianco, mamma, item, fruit, lib …). |
| `web/src/game/enemies/`, `npc/` | Enemies (with the SmallEnemy juice changes) and NPCs (`manager.ts`, neck pose, TNpcParts, effects). |
| `web/src/game/engine.ts` | Hit check (TObjHitCheck), conductor, live actors, MActor. |
| `web/src/game/collision.ts`, `mapwarp.ts`, `mapwire.ts` | Collision and the check lists, TMapWarp, the cube managers (`World.inAreaCube`, `World.isInOtherFastCube`). |
| `web/src/game/water.ts`, `splash.ts`, `bathwater.ts` | TModelWaterManager (FLUDD's drops, checked against the DOL), splashes, the bath water. |
| `web/src/game/talk.ts` | Talk and the director's game-mode changes (pause entry); `World.startDemoCamera` (the demo queue and its callbacks). |
| `web/src/game/mtxeffect.ts`, `timerec.ts`, `rumble.ts`, `vtxpos.ts` | Matrix effects (Mario's body wired), time records, rumble, trembling models. |
| `web/src/game/bastables.ts` | Generated by `gen_bastables.py` from the decomp. |
| `web/src/ghost/mstr.ts`, `mstrghost.ts` | Trace (MSTR / .msgt) reader and its conversion to a ghost with `g.trace`; `trace.session` keeps every session record. |
| `web/src/hud/` | HUD, menus (`menu.ts`), the pause menu replay. |
| `web/viewer.html` | The viewer page (the Info box is off by default; localStorage `ghostViewer.infoBox`). |
| `web/tools/harness/` | The command-line test harness (section 6). |
| `REGIONS.md` | How the regions differ and how `src/game/version.ts` follows the decomp's `VERSION_*`. |
| `SUGGESTIONS.md` | Suggestions kept for the user. |

## 5. References

- **Decomp** (read-only): `/home/claude/sms-ai-decomp` (the JP matching decomp; its own CLAUDE.md explains its methods). The per-region trees are `/home/claude/pub/SMS-Decomp-{JP-1.0,JP-1.1,US,PAL,KOR,3DAS}` (GitHub `Aetherion28/SMS-Decomp-*`) when present.
  `config/<ver>/symbols.txt` has addresses and sizes; `orig/GMSJ01/files/mario.MAP` names every function, including inlined ones.
- **DOL disassembly**: the JP DOL is `/mnt/user-data/uploads/ghosts/_main_jp.dol` (from the user's disc); PAL `/tmp/claude-0/palx/main.dol`.
  `python3 -I /tmp/claude-0/s/doldis.py <dol> <hexaddr> <hexlen>` (capstone, skipdata). The script must not be named `dis.py` (that shadows a Python module).
  A float constant: find r2 (`_SDA2_BASE_`; PAL 0x8040E280) and read the DOL at r2 + offset.
- **The compiler's habits that matter here**: MWCC fuses `a*b + c` into fmadds / fnmsubs wherever it can. Most of the fixes in the log are about where the ROM fuses or rounds to f32 and the port didn't. Read the ROM's instructions before writing float code: `fr()` rounds to f32, and `fmath.ts` has the fused helpers.
- **Moonshine's source**: `/tmp/claude-0/msrc/pr69` and `Prototype11` (the recorder's fields, GhostSimulation::Snapshot, ILing, Records). The dev's PR73 adds record fields (section 8).
- **Speedrun guide**: https://smscommunity.github.io/sms-guide/, source at `/home/claude/refs/sms-guide` (`_game/shines/<world>/episodeN.md`, `_game/techniques/`). Check what a run is doing before calling a desync a code bug. Examples: Pinna Park ep 1 pauses and picks Exit Area to skip a cutscene; buffered spinjumps are everywhere.
- IL database, rough reference only: `/home/claude/refs/sms_il_*`.
- The claude.ai project "SMS" has `claude/references.md` with the same rules and references.

## 6. Testing

Paths under `/tmp/claude-0` are the cloud workspace's and are lost when the container resets (see "Rebuilding the workspace").

### The batch set
- Traces: `/tmp/claude-0/up3/{a,b,c}/*.msgt`. `web/tools/harness/list4.txt` lists 143 (path, region, end QF) and `catalog.tsv` describes them.
  `list5.txt` (in `up3`) is the batch list: 141, without the TAS runs, which the viewer plays from their recording.
  Never commit traces.
- Game files: the user's extracted JP disc at `/mnt/user-data/uploads/Games/_ghostviewer_extract/`; PAL scenes at `/tmp/claude-0/palscene/data/scene` (`SCENEDIR`).

### Harness (`web/tools/harness/`, run the bundles from `/tmp/claude-0/ct`)
- `pm.ts` replays one trace through the viewer's code. It mirrors `runner.ts`'s setup, so **every new runner feature must be mirrored in pm.ts**, or the batch won't test it. Both now install `TraceFeeds`, so a new feed goes there once.
- Bundle: from `web/`, `node tools/harness/bpm.mjs tools/harness/pm.ts /tmp/claude-0/ct/X.mjs`. Build bundles from `pm.ts`, not from a probe copy that lacks runner features.
- One trace: `RUNS=runsT PM=<bundle> $H/run.sh <trace> JP <end>` (H = `web/tools/harness`; end QFs in `list5.txt`). Or `node X.mjs auto <trace> <endQF>`, which prints `[player] input replay drifted … at stage QF n` and a `SUM … drift {...}` line.
- **Full batch**: `cd /tmp/claude-0/up3 && LABEL=... $H/batch.sh runsNN <bundle> runsPrev`, then `python3 $H/cmp.py runsPrev runsNN` (the bucket table, then each better / worse trace). About 24 minutes on the 2 cores. Run it as a harness-tracked background task: a plain `&` job dies at the end of the turn. Don't run probes during a batch.
  `run.sh` stops each run 120 ticks after its first drift (`STOPDRIFT`; empty runs to the end), since cmp.py compares only first drifts.
  The latest batch is the highest `runsNN` in `up3`.
- Env switches in pm.ts (read the file): `TICK=a-b` per-tick Mario state; `CAM`, `CAMD`, `CAMP` camera; `RNGSYNC=1 RNGCMP=n`; `WPART`, `PTRACK`, `EMITLOG`, `WTELL` water; `TALKLOG`, `EVLOG`; `NOCLIP=1`; `MT0`.
  `pm_debug.ts` adds `NPCHIT`, `CAMX` (the sim's camera vs the trace's per tick), `CXL`, `WPROBE` walls, `GPROBE` ground, `WPOS`, `BOIDC`, `RNGSTK` (each RNG call with the sim's caller), `WTYP`, `RNGK2=a-b`, `RNGWHO`, `RNGCAT`.
  `/tmp/claude-0/ct/pm_probe.ts` runs `PJS=` probe scripts with the full setup (TraceFeeds included).
- Trace readers in `/tmp/claude-0/ct` (copies of the harness's): `tdiff.sh <trace> a b` (run with `bash`; `PMB=` picks the bundle) prints sim vs trace per tick (position error, status, forward speed, vy, face angle, flags); `gv.mjs` Mario per tick; `giy` intended yaw; `cyaw` camera yaw; `rk.mjs <trace> a b [regex]` RNG calls with callers; `wreq.mjs` water requests; `fb` / `fbcmp` feedback records; `ak.mjs`, `anear4.mjs`, `atype.mjs` (actor type and velocity), `aw.mjs` (actor position and rotation at full precision), `fl3.mjs` (the FLUDD blob), `yb.mjs` (the Yoshi blob), `rv.mjs`, `ct.mjs`, `kc.mjs`.
- Decomp coverage scans: `missing.py` (methods with no counterpart in the sim) and `missingcls.py` (whole classes). They match names only, so a hit can be a function the sim has under another name.
- Progress: `batch.sh` writes `/tmp/claude-0/progress.json`; the session's `test-progress` pane shows it.

### Rebuilding the workspace after a container reset
- The batch folders come from the user's three archives in `/mnt/user-data/uploads`: `a` = trace_A4362729_8C9D5ED7.zip, `b` = ref_41726535_80000018_….zip, `c` = trace_A7E1056F_8000002E.7z (py7zr), each flattened to its `.msgt` files.
- JP game files come from the user's computer when it is linked: tar `~/mnt/Games/_ghostviewer_extract` into `~/mnt/ghosts/_incoming/gve.tar`, stage it, unpack into `/mnt/user-data/uploads/Games/`. PAL scenes: `~/mnt/ghosts/_incoming/pal_scene.tar` into `/tmp/claude-0/palscene`.
- Copy `web/tools/harness/*.ts`, `list5.txt` and `cmp.py` into `/tmp/claude-0/ct` and `up3`, run `npm install` in `web`, and run a baseline batch at HEAD before you compare anything: old runsNN don't survive.

## 7. How to investigate a drift (the workflow that has worked)

1. Find the first drift: the trace's log in the latest batch (`grep drifted`), or run it alone.
2. `tdiff.sh <trace> <first-30> <first+5>`: the first tick where any field differs (position, forward speed, vy, face angle, status, Mario's flag word) is the real start. The position threshold trips later.
   The trace's Mario record holds much more than the harness prints (offsets in `ghost/mstr.ts`: slideVel 0xb4/0xb8, floor 0xe8, flag 0x118 …), so compare the field the suspect code reads.
3. Work out which input changed: intended yaw → camera yaw (`CAMX`: the record's `eye` is unk124 / mPosition, `target` is unk148), a flag bit (often set by something other than Mario), a status change, an actor (compare its actor records with `aw.mjs`).
4. If the RNG is involved, compare call sites by caller: `rk.mjs` lists the game's calls with callers; map a JP caller to a function with `symbols.txt` (snippet below). `RNGSYNC=1 RNGCMP=n` allows ±4 ticks, so a call at the wrong site in the same frame can hide; use `RNGSTK`.
5. Read the decomp function, then the DOL where the decomp is unsure, and compare with the port line by line. Fix only what disagrees.
6. Run that trace, then the full batch, then commit, then update this file.

```python
import re
syms=[(int(m[2],16),int(m[3],16),m[1]) for l in open('/home/claude/sms-ai-decomp/config/GMSJ01/symbols.txt')
      for m in [re.match(r'(\S+) = \.text:0x([0-9A-F]+); // type:function size:0x([0-9A-F]+)',l)] if m]
def who(a): return [(n,hex(a-s)) for s,z,n in syms if s<=a<s+z]
```

Common JP callers: 0x800c2458/24ac/2504 TTrembleModelEffect::tremble (Mario's cap, 264 calls a tick); 0x80363904 TBoidLeader::calcForces (fish and birds, on frame ticks); 0x80168ad0 TBaseNPC::npcWetIn; 0x80169ee0/f7c and 0x80171818 NPC code; 0x804546a8 Moonshine's gRiccoFruitRandShim; the water sites in section 9. The GPU-feedback "callers" per game ID are in `mstrghost.ts` (`FEEDBACK_SITES`).

## 8. What a trace contains

- Record kinds (`ghost/mstr.ts` `KIND_NAMES`): session, frame, Mario, camera, flags, actor, actor_removed, FLUDD, Yoshi, sound, particle, the RNG (15, which also carries the feedback literals), stage start (22), run flags (28: 1 assisted, 2 savestate, 4 fast-forward, 8 incomplete, 16 custom route, 32 TAS).
- **Session records** (GhostSimulation::Snapshot) come at the start and again whenever the runner changes a setting in Moonshine's menu. `trace.session` keeps all of them; `sessionCtx.at(field)` gives the value at a tick. Fields used: STAGE_INTRO_SKIP 20, RICCO_CRANE_SPEED 34, RICCO_FRUIT_MACHINE 35 (1 = Durians only), GAMEPLAY_SPEED 38, EFFECTIVE_FAST_TEXT 40, FAST_FORWARD_ACTIVE 44.
- Frame record word 6 is the director state; word 7 bit 0 means Moonshine's menu is shown.
- Actor records are the actor object's first 0xF4 or 0x150 bytes, sent as changed words. Offsets: position 0x10, THitActor type 0x4C, attack radius 0x50, attack height 0x54, damage radius 0x58, damage height 0x5C, entry radius 0x60, hit filter 0x64 (word 25); velocity words 43–45; live flag word 60 (0x150 records). Only some actors are recorded.
- The Mario, camera, FLUDD and Yoshi blobs persist between records (only changed words are sent), so each tick's view is the real memory.
  The Mario record covers TMario's first 0x574 bytes (mWaistRoll / mWaistPitch at 0x3D8 / 0x3DC are there).
  The FLUDD record (kind 8) is the whole TWaterGun (0x1DBC bytes: the nozzles inline from 0x0C, the turbo's at 0x18D8, mEmitPos 0x1C90, mPropellerAngle 0x1CD0), sampled once a frame after its last tick. The nozzles' MActors are pointers, so their animation frames aren't in it.
- Water requests (`wreq`) are the TWaterEmitInfo the game passed to emitRequest: pos, v, dir, pow, size, tremble values, type, flag.
- replayMstr's onTick counts world ticks: subtract the first segment's startQf to get the trace's labels.
- **Coming (PR73, the dev's handoff)**: new kind-29 subtypes: practice context, mod_control holds (with frame word 7 bit 8), the crane state, the spin's literal (checkStickRotate's result) and Mario's animation frame. When a trace with them arrives, parse them in `mstr.ts` / `mstrghost.ts` and feed them through `TraceFeeds`; the crane state should replace the `traceCraneSpeeds` fit, the spin literal the `traceStatusCtx` inference.

### Ticks and labels
- A frame is 4 sim ticks. A Mario record labelled L is the state after tick L, which is Mario as the next tick's perform begins.
- A frame record W covers ticks W+1..W+4; its records are labelled W..W+3.
- The director record `qf` is W-1: the state before that frame's `direct()`.
- RNG and water-request records labelled L belong to sim tick L+1 (in the harness, the sim's `tickCount - 1` equals the label).
- A feedback (kind 15 literal) record for a read in tick L has label L, the same as Mario's record.

## 9. Game facts the port depends on (all verified)

### Director
- The `changeState` after a frame's last tick runs at the start of the next frame, after the pad read; that is how pausing on Start freezes the whole frame.
- STATE_PAUSE_MENU (5) and 10, 11, 12 skip CUE_MOVE (`mMoveTickCount` stays) while `tickCount`, the console and the director's movement run (`NO_MOVE_STATES` in player.ts).
- The demo queue: a demo queued with a callback has it called with 0 when the demo starts (after the demos queued before it end) and 1 when it ends (MarDirectorDirect.cpp). Use `World.startDemoCamera`.
- The hit check runs on move ticks ≡ 0 mod 4 from the stage start (Mario's recorded mColCount is nonzero only at labels ≡ 3 mod 4).

### Moonshine's own menu
- A frame doesn't run when the menu is shown (in its record or the next one's) **and** Mario didn't move in it.
- Frame-start pad records (`s.input[4] & 0x80`) are `inputs.framePads` (the pause menu replay uses them).
- Moonshine can change the save flags after the stage-start image: Yoshi eggs, nozzle boxes and the Sirena pipe lid have to be taken from their first actor record, not the image.

### Occlusion (MARIO_FLAG_OCCLUDED, bit 0 of Mario's flag)
- Set by `TMario::drawSyncCallback` from the Z buffer, so the sim can't compute it. The camera (`ctrlNormalOrTowerCamera_`) and the silhouette read it.
- Newer traces record each read (feedback records). For older ones, bit 0 of the recorded flag word at the same label equals the read.

### Water (TModelWaterManager)
- The move loop and constants match the PAL DOL (0x802767D4): gravity from the particle type's prm (`/Mario/WTP00_Normal.prm`…: type 0 -0.4, type 15 Hover -1), the landing test `!(1.0f + ground < y)`, rand11 = ((rand() & 0xFF) - 128) / 128.
- The hit check (`checkWater`) runs on every 4th move tick; a particle's hit actor stays set until the next check.
- RNG sites (JP): 0x8015df70 hit-splash roll, 0x8015e3f4 surface ripple roll, 0x8015e540 ground splash roll, 0x8015e600 stay-on-ground roll (K[0] 0.5, or K[1] 0.35 with the L camera), 0x8015f1fc… makeEmit.

### Other verified details
- `checkStickRotate`'s `BOOL q[4]` is uninitialised stack; the sim starts them at 0, and the recorded status decides (see the fix log).
- MsVECMag2 (0x800c57d0) is a length, not a squared length.
- The juice block colour is a GXColorS10: the juice type (unk5D5F, the Yoshi mType that the spit sets) sets r, g and b; alpha is never written. Values can go past 255; the viewer divides by 255 and doesn't clamp.
- askHit uses fabs; checkWater, getSideWalkValues, squating and move's hv match the DOL.

## 10. Pitfalls

- An RNG check that compares seeds can't see a shifted consumer. Check consumers by caller. The sim's LOADCALLS should equal the trace's number of load calls.
- Parallel edits and merges: `git cherry-pick -X ours` silently dropped about 230 lines once, and parallel workers left duplicate class members (in a JS class the later one wins). After any merge, check that every intended line is there and grep for duplicate members.
- Circular imports crash at load (TalkCursor registered from talk.ts before scene.ts loaded; shake.ts importing polar). Register in scene.ts, and import low-level helpers from `camera/lib.ts`.
- `git apply` of a patch made on another base fails; commit each line of work in its own worktree and cherry-pick.
- `pgrep -f` matches itself and hangs watch loops; use background tasks and their notifications.
- A test hook in game code (`process.env` checks) must not be committed.
- The drift check (`checkMoved`): for a trace, the game moved in frame q iff a Mario record exists for one of q-4..q-1; the run's closing ticks (after `traceLastMove`) aren't checked.
- Object order inside a perform list decides RNG order; check it against the trace's callers.

## 11. Current state (2026-11-06)

First drift per trace, 141 batch traces (runs74):

| Desync | Runs |
|---|---|
| under 5 s | 0 |
| 5–15 s | 8 |
| 15–30 s | 26 |
| 30 s+ | 14 |
| never | 93 |

The big port of 2026-11-06 (one commit, see the fix log) added most of the decomp's remaining classes. Name scans (`missing.py`) went from 397 methods with no counterpart to about 343; the rest are mostly drawing, saving and particle code and functions present under other names.

### Still not ported (the remaining work, from the porting ledgers)
- **Rendering plumbing** the viewer does its own way: GX lighting sets (TLightWithDBSet, TPlayerLightWithDBSet, TLightDrawBuffer, TIndirectLightWithDBSet, TObjectLightWithDBSet, TMapObjectLightWithDBSet, TLightWithDBSetManager), lens glow (TLensGlow), the light beams (TBeamManager; TConeBeam's model is in `beam.ts` but not its multipass draw), light-cast shadows, TDrawSyncManager / TSMSDrawInit / TReInitGX / TAlphaCatch / TZBufferCatch / TGXAlphaUpdate / TAfterEffect / TScreenTexture, display-list helpers (TDLTexQuad, TDLColorTexQuad, TGDLStatic), TJointModelManager, TMapModelManager, TMapDrawWall, the static map objects' Sun / Shadow draw buffers, the sun's depth-read dimming and TSunShine (needs TSunMgr's getAddColor), TMapObjSeaIndirect, TEmitterViewObj / TEmitterIndirectViewObj, TJ3DSysSetViewMtx, TAlphaShadowQuadAry, TModelShadowInfo.
- **Mirrors**: TMirrorModelManager, TMirrorMapDrawBuf, and the mirror-only model refresh in ChuuHana.perform and Amenbo.perform.
- **Particles**: a renderer for the sim's own particles (the viewer draws recorded ones), and the emitter callbacks TMarioEmitterCallBackBindToMtxPtr / ToPosPtr / ToSRTMtxPtr.
- **Matrix effects**: `mtxeffect.ts` is wired into Mario's body only; FLUDD, the NPCs (TMtxSwingRZ, TNpcSaveNormal) and Mario's cap aren't.
- **Menus and screens**: the menu director isn't instantiated yet (hud/menu.ts has the classes); the options screen (TOptionSoundUnit, TOptionRumbleUnit, TOptionControl, TCameraOption, TToggleControl, TMapObjOptionWall), help balloons (TGCConsole2's balloon, TSwitchHelpActor), TProgSelect, TGameSequence, TGCLogoDir, TNintendo2D, TFlashPane, TQuestionManager / TQuestionRequest / TSilhouette, TMovieRumble (no movies).
- **Objects**: the minecart (torocco), TMapObjPlane and what needs it (TRockPlane, TSandPlane), TMapCheckGroundPlane, TMareWBaseManager, TMonteMBaseManager, TMonteWSpecialManager, TWarpInCallBack, TPatternAnmControl, TGraphGroup, TNameIndParCallback, TCamConnecter.
- **Collision internals** the sim does with its own structures: TBGCheckListRoot, TObjCheckList, TMapCollisionStatic, TBGCheckListWarp.
- **Rumble**: the commented `SMSRumbleMgr->start` sites in block, tree, dolpic, poihana, gatekeeper (with rumblePad / deathRumble / getRumblePow), cannon, bosstelesa, koopa, bombhei.
- **Bookkeeping with no game effect**: TModelDataKeeper / TModelDataNode, TProcessMeter, TTimeRec's display (timerec.ts is ported but not in a perform list), TMarioSoundValues.
- The bath water's TBathtubData getPos / getGravityDir port (fused ops, MSL atanf / atan2f, the 2^-18 epsilon) made coronaBoss worse and was left out; re-examine it on its own (see Refuted).

## 12. Open threads (where to pick up)

- mamma1 (b/1DD461CB_…006, first drift 4685): hovering Mario hits mirror L's underside, which tilts differently in the sim (recorded roof normal at 4221 (-0.167, -0.885, 0.435), sim (-0.354, -0.933, -0.070)). The Chuu Hanas walking on the mirror tilt it, and their recorded positions (actors 13–15) already disagree from about QF 435. Start from the Chuu Hanas there. The fused TLeanMirror sums alone made it worse (Refuted).
- ricco7 (b/41726535_…03F, first drift 6408): Mario jumps on Yoshi with A+R at 6385, and the spit's lift is 0.26 in the game and 0.05 in the sim (TNozzleDeform's mBomb emit, upper state idle so pressure 0). The spit's direction is Yoshi's tongue joint, whose pose the trace doesn't record (asked for in SUGGESTIONS.md).
- MARIO_FLAG 0x10 (recently left water) differs first in ricco b/41726535_…024 and mare b/A7E1056F_…041; maybe one cause.
- **Water drops land or hit a little earlier in the game than in the sim** (mare1 b/A7E1056F_80000028; dolpic10 c/…065, …067; clearest in Pinna Beach b/A7E1056F_8000000B, where the spray reveals `水ヒットコイン 25` at tick 1176 in the game and ~1204 in the sim). The game's drops are lower than the sim's by a few to ~20 units after 6–20 ticks. Emission, gravity, the move loop, the landing and hit tests and rand11 all match. Cause not found; don't tune it.
- Bianco b/41726535_80000023 (104 s): a TNerveAmenboSearch roll (0x8033dfa8) at tick 2058 comes a tick or two earlier in the game; also the camera's yaw step changes a tick early there (1 ulp in the intended yaw).
- Pinna Park 1 a/81BCC929_263FE90D (PAL, 5 s): its occlusion comes from the flag word. Taking it one label later fixes it, but the JP traces with real records say the same label, so that would be a fit. Needs a PAL trace with feedback records.
- Long runs: Gelato 4 (TSpcInterp mLocked is garbage: take it from the recording if it's recorded), Pianta 8, Delfino bell (water hits on the bell), Sirena (rule 12).

- Pinna Park Beach 2 b/1DD461CB_…026 (first drift 1436): Mario lands on a TCannon's dome (dome 2, cannondom.col moved by moveMtx(getConnectedMtx()) with the dome's sway unk28 concatenated in place) at y 751.6 in the sim, 746.2 in the game, then falls in the game. The RNG is in step and the dome code matches the decomp; the cannon isn't in the actor records, so its angle can't be checked. Needs the cannon recorded, or a decomp difference found in its BCK / joint path.

- Gelato Beach 3 b/1DD461CB_…007 (first drift 1572): falling Mario is pushed about 42 units by ボスハナチャンの足 (the Wiggler's leg, keepDistance) in both, 0.63 apart. The RNG is in step; the Wiggler isn't in the actor records, so look for a decomp difference in TBossHanachan's body / leg path. Two harmless one-tick status lags before it (366 the intro warp, 1278 THROWN_DOWN) line up again a tick later.
- Delfino Plaza 1 c/A7E1056F_…071 (first drift 1845): Mario stands in WAIT at (3045, 300, 1912) for half a minute and at 1842 the game sets MARIO_FLAG_NPC_TALKING with no button pressed, no director change and no NPC within 700 in the sim, so the sim lets him run. Find what starts a talk on its own there (an NPC that walks up and speaks, or an event).

- Gelato Beach 5 b/1DD461CB_…011 (first drift 6492, the race): Piantissimo stops at the goal one tick later in the sim (the game's record 6144 is the sim's position after 6142; the sim moves once more and TGoalFlag::touchActor stops him at the 6144 hit check). Mario's collision counts put this trace's hit checks on the sim's ticks, so look at what else can stop him a tick early (the flag's or his radii, the touch order). The forced talk at the finish (montemanrace.sb: isNearActors(マリオ, 300, モンテマン) then __forceStartTalkExceptNpc) follows from his final position.

## 13. Refuted (don't retry without new evidence)

- 2026-11-06 The TBathtubData port (bathwater.ts getPos / getGravityDir with fused ops, MSL atanf / atan2f and the 2^-18 epsilon): coronaBoss a/2A1D8909_80000028 1712 -> 1044 (Mario thrown down at QF 1041 by BathWater.tryHitMario), everything else the same (runs72). Probably one piece of it is wrong; port the pieces one at a time against the DOL.
- 2026-11-06 TLeanMirror's fused sums alone (patch `/tmp/claude-0/fx/11_mirror.patch`): mamma1 4685 -> 4572.
- 2026-11-06 A different hit-check phase (pm.ts MT0=2): one trace far better, but Mario's recorded mColCount rules it out; 0 stays.
- Loading a trace's whole stage-start flag image as world.flags: 7 worse, 1 better (runs45 vs runs44, mostly Delfino plaza runs whose setup flags.ts still infers). Worth retrying once those are understood.
- Carrying `checkStickRotate`'s q[4] over between calls: 57 worse, 3 better (runs21 vs runs20).

## 14. Fix log (newest first)

- 2026-11-07 checkStickRotate's fill-in from the recorded status (player/move.ts) applies only to the recorded Mario (this === world.mario): the trace's status is the player's, so Il Piantissimo and Shadow Mario (TEnemyMario, the same function) keep the cleared flags. Before, when the player started a spin the sim spun Piantissimo in the same tick (Gelato Beach 5, mamma4, the race: LEFT_ROTATE_JUMP at 2565), and he left his replayed course. Now he follows actor 264's records exactly to the goal. runs75 vs runs74: 140 the same, 1 worse (b/1DD461CB_…011 6496 -> 6492, its maxErr hundreds of units -> 7.75; committed on the user's say). Also found: actor records labelled L hold the sim's state after tick L-1 (one record a frame).
- 2026-11-06 TFireWanwanTailHit::bindBody moves its holder (enemies/firewanwan.ts, fireWanwan.cpp): the tail adds its last node's velocity x mTailEndPowRate (y 0) to its position and calls mHolder->moveRequest at the tail's x, z and the holder's y, then setTrans. The port called the tail's own moveRequest, whose translation() (identity33 + setTrans) wiped the rotation SMS_CalcToDirMatrix had just given the taking matrix, so pulling Mario (TMario::pulling: face angle from getTakingMtx) faced -32768 and wasn't dragged. Pianta Village 1 (monte0). runs74 vs runs73: 2 better (a/2A1D8909_…025 1612 -> 2040, b/A7E1056F_…041 1564 -> 1904), 0 worse.
- 2026-11-06 The static objects' particles are drawn and the model-less ones are quiet (sms_scene.ts static table from MapStaticObject.cpp's TActorData: falls, fountain, MareFalls, the SoundObj* sounds, BiancoAirWall, riccoSea and mareSeaPollutionS34567 have neither model nor particle). TMapStaticObj::perform emits its particle (type 1) every CALC_ANIM at its position, TopOfCorona's at mEffectCoronaScale 1.8: renderer.staticParticles lists them, V1Data.sceneJpa exports the files from the stage archive into JPA_RES (`scene:<file>`), and viewer.html staticFx keeps one held emitter each (jpaHoldRun). Corona Mountain's smoke (mapObj/ms_coronasmoke.jpa, 0x146) is in nearly every stage; Bianco boss's light (map/map/ms_wmlin_light.jpa, 0x151) in biancoBoss. Not yet checked by eye.
- 2026-11-06 Firefox still had a 3.6 s first game-draw frame and a 2.8 s frame from warmFx. noclip now compiles a program only when it is first drawn (createRenderPipeline no longer compiles; queryProgramReady compiles within the 12 ms budget whatever the extension, and _setProgram compiles a program a draw can't skip). warmFx waits until renderer.shadersPending (set by the render wrapper) is 0 and then warms one scene a call (renderer.compile on the whole scene made every pending program at once). Headless: longest frame 0.47 s, stage drawn 1.5 s after a disc load.
- 2026-11-06 Shaders compile a few a frame where the browser can't compile in the background (Firefox has no KHR_parallel_shader_compile and no shader cache, so a disc load's first frame took 7.7 s there: 3.6 s game draw, 4.1 s overlay; 0.76 s in Chrome). noclip (GfxPlatformWebGL2.ts queryProgramReady): without the extension a program is finished only while the frame's link waits stay under 12 ms (COMPILE_BUDGET_MS, reset in beginFrame); the others report not ready and their draws skip, as they do with the extension. three.js (viewer.html, a wrapper on renderer.render): a mesh whose material has no program yet is hidden for the frame once the frame's budget of new materials is used (it doubles while compiles take under 8 ms, else halves); checkShaderErrors is off (its status read waits for each link). Headless, no extension: the stage is drawn 1.6 s after a disc load instead of ~10 s, the longest frame 0.4 s, and everything is drawn once settled. The `[slow frame]` console line (frames over 400 ms, with the game-draw / overlay split and the overlay's program count) is the way to check this on a user's browser.
- 2026-11-06 Maps load from browser storage after their first load (v1data/store.ts): V1Data.get keeps each converter output (map and object GLBs, object JSON) in IndexedDB `ghostViewer.v1data`, keyed by V1DATA_VERSION (build.mjs: a hash of src/v1data and game/engine.ts, so any change to the converters drops the old entries), the disc (game ID, revision) and the path; bgeso.json isn't kept (it depends on what loaded before). Headless Delfino Plaza: 3.9 s the first time, 1.1 s from storage. Viewer only; the sim and the batch don't use it.
- 2026-11-06 The viewer wouldn't load maps after the big port: the new SunModel scene.bin case read its params without the trailing '.', so unpack's size assert failed (the entry has more after the TRS). Also wavedraw.ts used GX.BlendFactor.SRCCOLOR, which doesn't exist (SRCCLR). The harness never runs the viewer's drawing, so after a render change load maps in the built site headlessly (Playwright, swiftshader, setInputFiles on #folderFile with the extract folder) and read the console.
- 2026-11-06 **The big decomp port** (one commit; batch runs73 vs runs71: all 141 the same). Untangling: `TraceFeeds` (feedback.ts) holds every recording feed and runner.ts / pm.ts install it the same way; `World.startDemoCamera` (talk.ts); `MapObjBase.marioIsOnActor` / `marioIsOn` / `marioHipAttack` as the decomp; one `sendToMario`, one `itemManager`, one `fr` (fmath.ts). Ports: the Bob-omb's checkFlag(0xF); the town switch camera; lives through incMario and every 50th coin; incGoldCoinFlag (record slot COIN_RECORD_BASE + area); the fast cubes (World.isInOtherFastCube) with clipping in engine.ts, npc/manager.ts and animal.ts; Delfino's NPC far clip; Yoshi's setGroundCollision for the manhole and bridge board; water checkFlagBottom4Bits; the enemy-manager and conductor helpers; the fruit boat's spline rail; cannon area 5; the sunflower flag; the juice system (TJuiceBlock, TTelesaBlock, TBreakableBlock, the SmallEnemy change functions); the wave object and its drawing (wavedraw.ts); TObjHitCheck; the flag functions; the trembling model (vtxpos.ts); the bridge ropes; the NPC neck pose, TNpcParts and effects; the sand bomb; regenerated bastables; square and ship shadows; rumble (rumble.ts, audio/rumble.ts); bgmStop; saves in memory; the talk cursor; the jet coaster camera; water splashes (splash.ts); camera shake; matrix effects with Mario's body wired; the collision lists; the sun model; menus (hud/menu.ts); the multiplayer camera; time records; the light cone; bindshadow.ts; MSRandPlay. The bath water part was left out (Refuted).
- 2026-11-06 TFerrisWheel::becomeCalmlyCallback runs as the director starts its demo (mapobj/pinna.ts, through the demo queue). pinnaParco2 b/A7E1056F_…009's wheel slowed about 1200 ticks early, so a gondola sat under hovering Mario at 5631. runs70 vs runs69: 1 better (5632 -> 5684), 0 worse.
- 2026-11-06 TMario::hipAttacking's manhole snap (player/jump.ts): for each collision that is a TManhole more than 70 from Mario, his x and z become the manhole's. dolpic10 c/A7E1056F_…067 drifted by 75 at 4844. runs69 vs runs68: 1 better (-> never), 0 worse.
- 2026-11-06 TMuddyBoat as the ROM has it (mapobj/corona.ts): bind's and moveByWater's sums fused (JP 0x801AFF2C / 0x801AFF40, 0x801B05A0..0x801B0694); calc writes getAnmMtx(0) only, which the model's calc replaces once animations are on; kill copies that matrix into the base matrix, and while broken the root is the BCK's joint 0 from it at base scale 1 (`animatedRoot(scale)` in base.ts). coro_ex6 c/A7E1056F_…058: runs68 vs runs67: 1 better (4180 -> 4960), 0 worse.
- 2026-11-06 Moonshine settings changed mid-run: every session record is kept (trace.session) and `sessionCtx.at(field)` gives the value at a tick. TFruitLauncher::appearFruit (mapobj/ricco.ts) honours RICCO_FRUIT_MACHINE 1 = "Durians only": gRiccoFruitRandShim (JP 0x801a50f8 / 0x801a5214 / 0x801a5330) still rolls once per selection and picks the durian. runs67 vs runs66: 2 better (ricco7 …03F 4568 -> 6408, …040 2788 -> 3368), 0 worse.
- 2026-11-06 getModel()->getAnmMtx(0) as the game has it (mapobj/base.ts anmRoot / modelCalcRoot): for MOF.UNK8 objects the root matrix is the one the model's last calc made (CalcAnim, or the decomp's explicit calcs), with a playing BCK's joint 0 animated. Also the hit table's index in the DOL's f32 math (engine.ts, JP 0x80115A64). runs66 vs runs63: 2 better, 0 worse.
- 2026-11-06 Five fixes (runs63 vs runs62: 3 better, 0 worse): fast text from the session record (EFFECTIVE_FAST_TEXT); the language flag (correctOptFlag sets MSF_LANGUAGE 0x100 on every version but PAL; talk.ts textSpeed per version); the butterflies' and beehive's items as real registered objects; the bird's item for every event ID and its Shine with appearWithDemo. PAL's language is left 0 (unchecked).
- 2026-11-06 The bluebird's item is the real registered object (enemies/bird.ts, TAnimalBird::load / doDropCoin). dolpic_ex3 c/…062's bird red coin couldn't be collected. runs62 vs runs61: 1 better (73.3 s -> the end), 0 worse.
- 2026-11-06 Swimming Mario rides the waves (tmario.ts calcBaseMtxSwim, waveGetHeight, TMapObjWave registered as world.mapObjWave). runs61 vs runs60: 8 better, 0 worse.
- 2026-11-06 TAS tagging: a run is played from its recording whenever Moonshine wouldn't count it as a PB: run flags TAS / savestate / fast-forward / assisted, a session record with STAGE_INTRO_SKIP, GAMEPLAY_SPEED or FAST_FORWARD_ACTIVE, or the DPad Functions code (a pad of exactly X + D-pad Up writes TAKE 0x383 into Mario's status; D-pad Right reloads the position D-pad Left saved; detected in mstrghost.ts dpadFunctionsUsed). header.tasReasons lists why; the viewer shows a "TAS" tag. In the batch set: a/2A1D8909_80000014, …015, …01F.
- 2026-11-06 The camera's gun-angle ratio reads the nozzle's mLAngleMin from its params (camera/polar.ts calcAndSetMarioData). runs60 vs runs59: 1 better (dolpic_ex3 9.9 -> 73.3 s), 0 worse.
- 2026-11-06 MActor.anmMtxAll and the palm leaves' rest matrices use jointMatricesExact (J3DModel::calc's rounding); controlLeaf's spring step is one fnmsubs (JP 0x801CE4FC). runs58 vs runs57: 2 better, 0 worse.
- 2026-11-06 The drift check of a tick runs as the next tick's TMario::perform begins, after the map group's and conductor's movement (scene.ts). runs55 vs runs54: 4 better, 0 worse.
- 2026-11-06 gpCubeArea: thinkCube and setFlagOutOfCube (LIVE_FLAG_UNK200 outside Mario's area cube, +75 up), Hotel Delfino's floor rule (mapwire.ts). runs54 vs runs53: 1 better, 0 worse.
- 2026-11-06 TMapWarp's warp grounds (mapwarp.ts, collision.ts mapWarpFromPayload): BG 0x200 / 0x201 warp by the pair's offset, 0x202 / 0x203 only switch the model. runs53 vs runs52: 2 better, 0 worse.
- 2026-11-05 Rocket / turbo nozzle boxes valid from their first record (the hit filter, word 25). runs52 vs runs51: 2 better, 0 worse.
- 2026-11-05 The stream cubes' push (TMapWarp::watchToWarp) runs first in the tick's movement after the hit check. runs51 vs runs50: 3 better, 0 worse.
- 2026-11-05 TWaterGun::setBaseTRMtx's MTXConcat through j3dcalc.ts concat (PSMTXConcat's rounding). All the same.
- 2026-11-05 MsVECMag2 is a length at seven sites (Hane Hamukuri, Telesa, RollEnemy, Igaiga, TamaNoko, the elec carapace, BossTelesa). runs48/49: 2 better, 0 worse.
- 2026-11-05 TMario::checkWallPlane takes the first wall whose actor equals unk2C0 with no null test (JP 0x80134A88). runs47 vs runs46: 8 better, 0 worse.
- 2026-11-05 The Sirena pipe's pineapple lid is gone per its first actor record (mapobj/fruit.ts). 1 better, 0 worse.
- 2026-11-05 Amenbo walk arithmetic in single precision (enemies/amenbo.ts; by the user's local model). All the same.
- 2026-11-05 A puku's first landing depth from the recording (enemies/tobipuku.ts sankEnoughFromRecording): the check reads never-initialised unk1D0.y. runs44 vs runs43: 4 better, 0 worse.
- 2026-11-05 The running lean stops while FLUDD sprays (tmario.ts waistCtrl: the DOL reads mFlags 0x4000, the decomp mStatus). runs43 vs runs42: 2 better, 0 worse.
- 2026-11-05 A fresh TTobiPuku's first leap from the recording (flewOnGarbage: the next roll from the current RNG state is TEffectColumWater::reset). runs42 vs runs41: 1 better, 1 worse (ricco7 …040; its rolls line up further but a puku appear at label 476 is missing).
- 2026-11-05 Harness: pm.ts clips actors against the recorded camera, as runner.ts does. runs41 is the baseline from there.
- 2026-11-05 checkStickRotate's leftover quadrant flags from the recorded status (move.ts, traceStatusCtx; the user chose this). runs38 vs runs36: 2 better, 0 worse.
- 2026-11-05 MsPerpendicFootToLineR and TMapWire::getPosInWire as the DOL; TBaseNPC::execWalk's isCanWalk measures the flat offset. runs36 vs runs35: 1 better, 0 worse.
- 2026-11-05 MActor::curAnmEndsNext / isCurAnmAlreadyEnd in f32. All the same.
- 2026-11-05 Fruit wall bounce as the DOL (TMapObjBall::touchWall: vd * -(1 + bounce); the decomp's `-(-1 + unk8)` is a misreading). 1 better, 0 worse.
- 2026-11-05 Gull and bird flight in f32 as the DOL (MsGetRotFromZaxis, CLBChaseGeneralConstantSpecifySpeed, getRotationFlyToDir, execWalk, doFlyToCurPathNode, TKukku::updateRotation). runs34 vs runs31: 3 better, 3 worse (later errors exposed).
- 2026-11-05 TQuat4::setEulerX/Y/Z and SMS_Eular2Quat / TQuat4::rotate as the DOL (MSL sinf / cosf). 3 better, 0 worse.
- 2026-11-05 MSF_SHADOW_MARIO_EVENT from the recorded flags (runner.ts traceShadowMarioEvent). 1 better, 0 worse.
- 2026-11-05 Yoshi eggs load as the actor records show them (traceActorsAlive). runs28 vs runs27: 8 better, 2 worse (both with their load rolls now right).
- 2026-11-05 TRotation3::setRotate and PSMTXMultVecArray as the DOL. All the same.
- 2026-11-05 Display only: Mario's animation frame while following a trace (traces carry the animation but not its frame).
- 2026-11-05 math.ts sinf / cosf are MSL's trigf (JP 0x80087104 / 0x80086F70). All the same.
- 2026-11-04 TMapObjWave::getWaveHeight as the DOL. All the same.
- 2026-11-04 Feedback replay one label later. runs24 vs runs23: 13 better, 2 worse (committed on the user's say).
- 2026-11-04 Ricco cranes from the trace (`traceCraneSpeeds`: Moonshine can set the crane speed). 8 better, 0 worse.
- 2026-11-04 Occlusion from Mario's recorded flag word for traces without feedback records; Moonshine's menu stops the game only in frames where Mario didn't move; the pause menu overlay; the closing ticks aren't drift-checked; Mario frozen in one side counts as a drift; TMapObjBall::touchWater uses fmadds; the pause menu, Shadow Mario's talk, Corona Mountain's start.
