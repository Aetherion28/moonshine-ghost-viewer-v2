# Handoff (2026-11-15)

Start here, then read `CLAUDE.md` (the long shared memory; its sections 2, 3, 6, 12 and 14 matter most).
This file is the short version: what was just done, what is open, where everything is.

## Who and how

- The user (doge / Aetherion28) is a Sunshine speedrunner. Ask them about game behaviour you can't verify; don't assume.
- They are short on usage: work quickly, no probes that don't decide anything, no helper agents unless asked.
- Commit and push every finished change (`git push origin HEAD:main`); the tree must be clean at the end of a turn.
  Commit messages end with the attribution lines your own session's system reminder gives.
- Never commit traces, DOLs, ISOs, game files, Moonshine packages, videos or anything from the user's disc.
- Decline cookies; downloads need the user's permission. Don't open the `agent-mailbox` repository unless asked.
- The user prefers that tests run on their real hardware: their Chrome (Claude in Chrome extension) has the live site with their disc already loaded.

## Repositories and branches

- `/home/claude/moonshine-ghost-viewer-v2` (GitHub `Aetherion28/moonshine-ghost-viewer-v2`).
  - `main` is the v2 viewer, deployed to https://aetherion28.github.io/moonshine-ghost-viewer-v2/ by the Pages workflow (`gh run list`).
    The last session worked on it in a worktree at `/tmp/claude-0/wt/main`; recreate it with `git worktree add <dir> origin/main`.
  - `v3` holds v3 (the exact emulator-style replay, `web/v3/`) and all the TAS capture work (`web/tools/tascapture/`). Its `CLAUDE.md` has the longer TAS notes.
- `/home/claude/sms-ai-decomp`: the matching decomp (read-only reference).
- Build: `cd web && npm install && node build.mjs` (writes `../site`, which is committed; rebuild before every commit that changes source).

## Workspace (lost on a container reset)

- Traces: `/tmp/claude-0/up3/{a,b,c}/*.msgt` (rebuild from the user's archives: `CLAUDE.md` section 6).
  The user's PC holds them in `C:\Users\Aetherion\Desktop\SMS\ghosts\_incoming` (the user connects the SMS folder with the desktop app's Add folder button): `moonshine-ghosts.tgz.part*` (the traces), `gve.tar` (the JP extract), `pal_scene.tar`; `CLAUDE.md` section 6 says where each goes.
  `pm.ts` imports `/tmp/claude-0/ct/files.ts`: copy `web/tools/harness/files.ts` there before bundling.
- A clean JP disc folder for headless tests: `/tmp/claude-0/jpdisc` (`files/` hard links to `/mnt/user-data/uploads/Games/_ghostviewer_extract/data` plus its `jp/` files, and `sys/boot.bin` = `GMSJ01`).
  The extract's root mixes JP and PAL, so don't point the viewer at it directly.
- Playwright is at `/opt/npm-tools/node_modules/playwright` (the scripts load it from there).
- Disc images for testing the viewer's disc reader: `/tmp/claude-0/discs/` (`jp10.iso` and the same disc as `.rvz`, `.gcz`, `.ciso`, `n.wia` uncompressed, `.wia` LZMA, `l2.wia` / `l2.rvz` LZMA2 and `b.wia` bzip2; `pal.iso`). The ISOs are on the user's PC in `Desktop\SMS` (`JP 1.0 (GMSJ01).iso`, `NA (GMSE01).iso`, …): staging takes files under 400 MB, so cut one into parts with `dd bs=4000000 skip=… count=95` in device_bash (a plain `split` outlives the 3-minute call) and `cat` them here.
  nodtool converts them (`cargo install nodtool --root /tmp/nod`, from crates.io, about a minute): `nodtool convert -c zstd:19 jp10.iso jp10.rvz` (`.gcz`, `.ciso`, `.wia` by the output's extension, `-c none` for an uncompressed WIA).

## Testing the viewer

- Headless (swiftshader): `web/tools/smoke/smoke.mjs <site> <disc> <outdir> <files...>` loads the disc (an extracted folder, or an image file picked as a visitor does), then each recording, plays a few seconds, screenshots it and prints page errors and console errors.
  `badfiles.mjs` (same arguments) loads broken or wrong files one by one and reports the notice each showed, how often it was set (a retry loop sets it every frame) and whether the page still answers.
  `web/tools/disc/disctest.mjs <iso> <images…>` (node, from `web/`) reads every file of the disc through each image and compares it with the ISO, then checks that cut-off, empty and random files are turned down.
  `mobile.mjs` (iPhone 13 layout), `scrub.mjs` (screens at chosen times), `mirtest.mjs` (a view with the mirrors on and off), `palm.mjs` (header at several widths).
  Swiftshader draws some water black (Bianco's river): that is the software renderer, not the viewer.
- Real hardware: the Claude in Chrome extension on the live site. The page has `#mapSelect`, `#episodeSelect`, `#sharedList` (Delfino Ghosts' shared ghosts: their Load buttons need no files), `#play`, `#scrub`, `#clockNow`.
  A background tab is throttled to near nothing (timers and rAF), so long scripted sweeps there stall; use headless for sweeps, Chrome for looking.
  Local files can't be uploaded through the extension (only files shared with the session), so in Chrome use the shared ghosts.

## What the last session did (2026-11-15, third part, live on main)

- **Report a problem** links (the disc box and the side panel) open a GitHub issue with the build, browser, graphics, disc version and recordings filled in.
- WIA and RVZ in every compression: LZMA, LZMA2 (`web/src/lzma.ts`) and bzip2 (`web/src/bzip2.ts`), each checked byte for byte against the ISO (Purge is written but untested).
- PAL: the HUD and the Shine overlay read PAL's per-language archives (`game_6_en.szs` …; `web/src/disclang.ts`, the reader's language, else English); before, a PAL disc had no HUD. All 16 PAL stages in the test set load from the PAL ISO.
- Accessibility (`web/tools/smoke/a11y.mjs`): the view's canvases are named or hidden for screen readers, notices are announced, the stage is the main landmark, the speed box shows its focus. Contrast passes AA in both themes; every control is reachable by Tab.
- Firefox and WebKit (Safari's engine): the sweep runs in both (`BROWSER=firefox|webkit`, under `xvfb-run -a` with `LIBGL_ALWAYS_SOFTWARE=1`; Playwright's builds are in `/opt/pw-browsers`, downloaded with the user's OK) and six stages load and play in each from the RVZ.
- The temporary copies on the user's PC (`ghosts\_incoming\regions`) are deleted.

## What the session before that did (2026-11-15, second part: robustness, live on main)

- Disc images in Dolphin's formats: RVZ, GCZ, CISO and uncompressed WIA are read (`web/src/discformats.ts`, wired into `disc.ts`), checked byte for byte against the ISO. WIA with LZMA or bzip2 gets a message saying how to convert.
- A cut-off disc image is turned down when it's opened; a stage that can't be read shows its error once (it used to retry every frame) and the status line says so.
- Memory: the stage caches kept every stage of a session, and a headless session through 57 stages stopped answering. They keep the last few stages now. Mip textures were cached across glTFs by texture index (one stage could get another's texture): fixed.
- A cut-off or damaged replay plays up to the damage, with a warning; broken files get plain messages.
- CI on every push (`.github/workflows/check.yml`, `CLAUDE.md` section 3): the type-check against its baseline, `site/` against a fresh build, the page in headless Chrome.
- Sweeps: all 81 JP stages load and play from the ISO; RVZ, GCZ, CISO and WIA play; every broken file tried got a message.
- Licence: **GPL-3.0-or-later** (the user's choice): `LICENSE`, README, the legal page (with the source link), `package.json`. Third-party code keeps its own licence (noclip, three.js, gl-matrix, fzstd, mp4-muxer MIT; the fonts OFL).
- The user said most speedrunners use the JP disc, and that ghost simulation (.smsghost) no longer worries them; the US, PAL, JP 1.1 and Korean discs weren't swept this time.

## Earlier (2026-11-14/15: polish before the public announcement, live on main)

- The name is **Moonshine Ghost Viewer** everywhere (page title and header, README, legal page; the user dropped the "v2" tag). The repo and URL keep `-v2`.
- The page serves three.js r128 and its two fonts itself (`web/vendor/`, copied to `site/vendor/` by build.mjs with their licences): no CDN or Google Fonts requests.
- Link previews: a meta description, Open Graph / Twitter tags, `social.png` (1200x630, made from the site's own pixel sprites and font, no game art) and `favicon.png` (the sun sprite).
- The legal page has Privacy and Credits and licences sections (noclip, three.js, gl-matrix, mp4-muxer, the fonts; licence files in `site/vendor/`).
- The comparison view's checkbox had lost its label in October (a bare checkbox under Wireframe stage): "Comparison view" is back.
- "Water reflections (experimental)" (the user's choice: keep it, off by default, labelled as not yet checked).
- The frame-rate box shows only the frame rate; `?perf` in the address adds the timing split.
- A browser that can't start WebGL gets a message in the disc box (it used to throw and leave a dead page; seen once in the user's Chrome); a lost context shows a notice.
- An old-format ghost's ⚠ no longer says "current is v8" (v9 exists); the drop zone and help text mention `.msgt` replays.
- README rewritten for visitors. `web/package.json` no longer claims an ISC licence (private, no licence chosen yet).
- Type-checking (no tsconfig in the repo; a lenient one in /tmp found these) turned up: `game/mario.ts` used `fr` without importing it (a ReferenceError when the ghost-following Mario sprays something), two duplicate imports, and five enemies' changeOut (TSmallEnemy, TBombHei, TKiller, TTelesa, TTobiPuku) passing `ANM_FRAME_RATE` uncalled to setFrameRate (the decomp has `SMSGetAnmFrameRate()`), which made their animation NaN after Yoshi's juice. All three are committed; the juice fix after a full batch (runs99 vs runs98, 2026-11-15: all 140 the same).

## Open on the viewer

- **Ask the user**: is the yellow-green glow and the two beams over Gelato's tower right (are they always there in the game)? They may come from the stone's model or from the static `sun_mirror` object.
- **Mirrors**: not confirmed against the game. A mirror is used only while Mario is inside its 鏡キューブ (from map/tables.bin): Bianco's covers its water (plane y 2303), Pinna Park's the pond (y 710), Gelato's only the wet slopes high up, Hotel Delfino's is a wall mirror whose plane the game takes from the raw S16 vertex (z -8354; the mirror is at z -1044).
  Not done: TMirrorActor's coins, enemies and Yoshi; the lean mirrors' TMirrorModelObj (Gelato episode 2); lights in the mirror pass use the main camera.
  When the user confirms the look, turn it on by default (the `__mirrors` check in setUpMirror and the option) and drop "(experimental)" from its label.
- NKit images and WIA's Purge compression are untested (no tool here makes either). The memory creep is fixed (the sim's byte-keyed caches are weak now: `CLAUDE.md` fix log).
- The user checks by eye: the water reflections, the Gelato tower's glow, the page on a phone.
- Specular light on Mario and NPCs is still off (turning it on washed them white; cause not found; `layer.ts`, search "specular").
- `CLAUDE.md` section 11, "Still not ported", lists the remaining rendering plumbing.

## Open on the simulation (v2)

- 140 batch traces, runs99 (2026-11-15): 103 never drift. The open threads with their next steps are in `CLAUDE.md` section 12; start each with the v3 oracle (section 12, "The oracle").
- Any change to `web/src/game` needs a full batch (section 6) unless it is provably behaviour-identical (say so in the fix log).

## The any% TAS work (paused)

Everything is in the `v3` branch's `CLAUDE.md` (section 12, "The any% TAS through Dolphin") and `web/tools/tascapture/`.
- The TAS (TASVideos 3731M, 2018, Dolphin 5.0-114, GMSJ01) plays in real Dolphin on the user's PC up to Manta Storm, where it parts.
  35 per-level ghosts (.smsghost V9) and traces were made from the synced part (`convert.ts`, `mkghost.py`); they are in the user's `Desktop\SMS\ghosts\SMS any% TAS 3731M - ghosts`.
- The sweep runner is `mantasweep.ps1` on the user's PC (`Desktop\SMS\ghosts\_incoming\tas`; queue `sweep_queue.txt`, results `sweep_results.txt`, the loop `run_mantasweep.cmd`, which the user starts).
- **What was found**: the run really parts at Manta Storm's first split (~field 173182). The split's angle is a `rand()` in TBossMantaManager::spawn, so our RNG is already out of step there (a GPU-dependent consumer before it). The never-set f26 in spawn is not the cause.
  Only the savestate at Sirena's start (slot 1, field 170554) is faithful; a state saved mid-stage (slot 4) is not.
- Seed offsets of ±40 matched nothing (2026-11-15). Since then a sweep of **every value (0..32767) of the first split's rand()** runs on the user's PC by itself, six Dolphins at once, about 5 days in all.
  The user controls it with `sweep_control.cmd` (Pause / Start) in the `tas` folder; `README_SWEEP.txt` there explains it. Shine grabs land in `winners.txt` and `sweep\winners\`.
  How it works, and what to do with a winner: the v3 branch's `CLAUDE.md` ("The split sweep") and `web/tools/tascapture/sweep/`.
- The user's fallback is fine: re-sync per level.
- **zelpikukirby's newer TAS** (Any% No ACE, YouTube igm67ZABQgE, 2024-11-01) was made on a modern GPU and may sync better, but its .dtm isn't public.
  The user is contacting him (drafts were written for an X reply; other routes: speedrun.com message, TASVideos PM, YouTube or Niconico comment, Twitch).
  His posted Dolphin settings (Hacks tab, 2024-07-30): Skip EFB Access off, Ignore Format Changes off, Store EFB Copies to Texture Only off, texture cache Fast, XFB disabled, Fast Depth Calculation on, Disable Bounding Box on.

## Avoiding "chat dementia"

- Write findings into `CLAUDE.md` (fix log, open threads, refuted) in the same commit as the change, and keep this file current when the focus changes.
- Don't trust earlier messages for state that can change (deploys, the PC's sweep loop, the user's settings): check again.
