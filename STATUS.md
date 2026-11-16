# Status (2026-11-16)

Start here, then read `DEVELOPMENT.md` (the long notes; its sections 2, 3, 6, 12 and 14 matter most).
This file is the short version: what was just done, what is open, where everything is.

## Repositories and branches

- This repository.
  - `main` is the v2 viewer, deployed to https://aetherion28.github.io/moonshine-ghost-viewer-v2/ by the Pages workflow (`gh run list`).
  - `v3` holds v3 (the exact emulator-style replay, `web/v3/`) and all the TAS capture work (`web/tools/tascapture/`). Its `DEVELOPMENT.md` has the longer TAS notes.
- `/tmp/gv/sms-decomp`: the matching decomp (read-only reference).
- Build: `cd web && npm install && node build.mjs` (writes `../site`, which is committed; rebuild before every commit that changes source).

## Workspace (outside the repository)

- Traces: `/tmp/gv/up3/{a,b,c}/*.msgt` (rebuild from the maintainer's archives: `DEVELOPMENT.md` section 6).
- A clean JP disc folder for headless tests: `/tmp/gv/jpdisc` (`files/` hard links to `/tmp/gv/extract/data` plus its `jp/` files, and `sys/boot.bin` = `GMSJ01`).
  The extract's root mixes JP and PAL, so don't point the viewer at it directly.
- Playwright is at `/opt/npm-tools/node_modules/playwright` (the scripts load it from there).
- Disc images for testing the viewer's disc reader: `/tmp/gv/discs/` (`jp10.iso` and the same disc as `.rvz`, `.gcz`, `.ciso`, `n.wia` uncompressed, `.wia` LZMA, `l2.wia` / `l2.rvz` LZMA2 and `b.wia` bzip2; `pal.iso`).
  nodtool converts them (`cargo install nodtool --root /tmp/nod`, from crates.io, about a minute): `nodtool convert -c zstd:19 jp10.iso jp10.rvz` (`.gcz`, `.ciso`, `.wia` by the output's extension, `-c none` for an uncompressed WIA).

## Testing the viewer

- Headless (swiftshader): `web/tools/smoke/smoke.mjs <site> <disc> <outdir> <files...>` loads the disc (an extracted folder, or an image file picked as a visitor does), then each recording, plays a few seconds, screenshots it and prints page errors and console errors.
  `badfiles.mjs` (same arguments) loads broken or wrong files one by one and reports the notice each showed, how often it was set (a retry loop sets it every frame) and whether the page still answers.
  `web/tools/disc/disctest.mjs <iso> <images…>` (node, from `web/`) reads every file of the disc through each image and compares it with the ISO, then checks that cut-off, empty and random files are turned down.
  `mobile.mjs` (iPhone 13 layout), `scrub.mjs` (screens at chosen times), `mirtest.mjs` (a view with the mirrors on and off), `palm.mjs` (header at several widths).
  Swiftshader draws some water black (Bianco's river): that is the software renderer, not the viewer.
  A background tab is throttled to near nothing (timers and rAF), so long scripted sweeps there stall; use headless for sweeps, Chrome for looking.

## Security audit (2026-11-16, live on main)

- A security audit of the viewer: no way found to run code in another visitor's browser. The denial-of-service holes it found are closed (ghost RNG tape count, share-link limits, disc file table, image header sizes), a Content-Security-Policy is in place, and the deploy now runs the checks first. `DEVELOPMENT.md` fix log has the list and what was left (shared github.io storage, cache keyed by disc ID, actions pinned by tag).

## Latest work (2026-11-16: a deep search, live on main)

- Two leaks fixed: the sim's byte-keyed caches (WeakMaps now) and the particle batches that grew with every stage load. Memory is flat across repeated stage loads.
- `tools/smoke/leak.mjs` hunts leaks by scenario (traces, stages, options, scrub, split) and names each survivor's holder; `tools/ci/pagescript.mjs` (in CI) catches undefined names in viewer.html's own script.
- Parsers fuzzed (3,000 ghosts, 300 replays): no hangs; one raw error made a plain message. Share links can't climb out of the ghosts folder. The ghost list's buttons wrap.
- Details: `DEVELOPMENT.md` fix log, 2026-11-16.

## Before that (2026-11-15, third part, live on main)

- **Report a problem** links (the disc box and the side panel) open a GitHub issue with the build, browser, graphics, disc version and recordings filled in.
- WIA and RVZ in every compression: LZMA, LZMA2 (`web/src/lzma.ts`) and bzip2 (`web/src/bzip2.ts`), each checked byte for byte against the ISO (Purge is written but untested).
- PAL: the HUD and the Shine overlay read PAL's per-language archives (`game_6_en.szs` …; `web/src/disclang.ts`, the reader's language, else English); before, a PAL disc had no HUD. All 16 PAL stages in the test set load from the PAL ISO.
- Accessibility (`web/tools/smoke/a11y.mjs`): the view's canvases are named or hidden for screen readers, notices are announced, the stage is the main landmark, the speed box shows its focus. Contrast passes AA in both themes; every control is reachable by Tab.
- Firefox and WebKit (Safari's engine): the sweep runs in both (`BROWSER=firefox|webkit`, under `xvfb-run -a` with `LIBGL_ALWAYS_SOFTWARE=1`; Playwright's builds are in `/opt/pw-browsers`) and six stages load and play in each from the RVZ.

## Earlier (2026-11-15, second part: robustness, live on main)

- Disc images in Dolphin's formats: RVZ, GCZ, CISO and uncompressed WIA are read (`web/src/discformats.ts`, wired into `disc.ts`), checked byte for byte against the ISO. WIA with LZMA or bzip2 gets a message saying how to convert.
- A cut-off disc image is turned down when it's opened; a stage that can't be read shows its error once (it used to retry every frame) and the status line says so.
- Memory: the stage caches kept every stage of a session, and a headless session through 57 stages stopped answering. They keep the last few stages now. Mip textures were cached across glTFs by texture index (one stage could get another's texture): fixed.
- A cut-off or damaged replay plays up to the damage, with a warning; broken files get plain messages.
- CI on every push (`.github/workflows/check.yml`, `DEVELOPMENT.md` section 3): the type-check against its baseline, `site/` against a fresh build, the page in headless Chrome.
- Sweeps: all 81 JP stages load and play from the ISO; RVZ, GCZ, CISO and WIA play; every broken file tried got a message.
- Licence: **GPL-3.0-or-later** (the maintainer's choice): `LICENSE`, README, the legal page (with the source link), `package.json`. Third-party code keeps its own licence (noclip, three.js, gl-matrix, fzstd, mp4-muxer MIT; the fonts OFL).
- The maintainer said most speedrunners use the JP disc, and that ghost simulation (.smsghost) no longer worries them; the US, PAL, JP 1.1 and Korean discs weren't swept this time.

## Earlier (2026-11-14/15: polish before the public announcement, live on main)

- The name is **Moonshine Ghost Viewer** everywhere (page title and header, README, legal page; the maintainer dropped the "v2" tag). The repo and URL keep `-v2`.
- The page serves three.js r128 and its two fonts itself (`web/vendor/`, copied to `site/vendor/` by build.mjs with their licences): no CDN or Google Fonts requests.
- Link previews: a meta description, Open Graph / Twitter tags, `social.png` (1200x630, made from the site's own pixel sprites and font, no game art) and `favicon.png` (the sun sprite).
- The legal page has Privacy and Credits and licences sections (noclip, three.js, gl-matrix, mp4-muxer, the fonts; licence files in `site/vendor/`).
- The comparison view's checkbox had lost its label in October (a bare checkbox under Wireframe stage): "Comparison view" is back.
- "Water reflections (experimental)" (the maintainer's choice: keep it, off by default, labelled as not yet checked).
- The frame-rate box shows only the frame rate; `?perf` in the address adds the timing split.
- A browser that can't start WebGL gets a message in the disc box (it used to throw and leave a dead page; seen once in the maintainer's Chrome); a lost context shows a notice.
- An old-format ghost's ⚠ no longer says "current is v8" (v9 exists); the drop zone and help text mention `.msgt` replays.
- README rewritten for visitors. `web/package.json` no longer claims an ISC licence (private, no licence chosen yet).
- Type-checking (no tsconfig in the repo; a lenient one in /tmp found these) turned up: `game/mario.ts` used `fr` without importing it (a ReferenceError when the ghost-following Mario sprays something), two duplicate imports, and five enemies' changeOut (TSmallEnemy, TBombHei, TKiller, TTelesa, TTobiPuku) passing `ANM_FRAME_RATE` uncalled to setFrameRate (the decomp has `SMSGetAnmFrameRate()`), which made their animation NaN after Yoshi's juice. All three are committed; the juice fix after a full batch (runs99 vs runs98, 2026-11-15: all 140 the same).

## Open on the viewer

- **Ask the maintainer**: is the yellow-green glow and the two beams over Gelato's tower right (are they always there in the game)? They may come from the stone's model or from the static `sun_mirror` object.
- **Mirrors**: not confirmed against the game. A mirror is used only while Mario is inside its 鏡キューブ (from map/tables.bin): Bianco's covers its water (plane y 2303), Pinna Park's the pond (y 710), Gelato's only the wet slopes high up, Hotel Delfino's is a wall mirror whose plane the game takes from the raw S16 vertex (z -8354; the mirror is at z -1044).
  Not done: TMirrorActor's coins, enemies and Yoshi; the lean mirrors' TMirrorModelObj (Gelato episode 2); lights in the mirror pass use the main camera.
  When the maintainer confirms the look, turn it on by default (the `__mirrors` check in setUpMirror and the option) and drop "(experimental)" from its label.
- NKit images and WIA's Purge compression are untested (no tool here makes either). The memory creep is fixed (the sim's byte-keyed caches are weak now: `DEVELOPMENT.md` fix log).
- The maintainer checks by eye: the water reflections, the Gelato tower's glow, the page on a phone.
- Specular light on Mario and NPCs is still off (turning it on washed them white; cause not found; `layer.ts`, search "specular").
- `DEVELOPMENT.md` section 11, "Still not ported", lists the remaining rendering plumbing.

## Open on the simulation (v2)

- 140 batch traces, runs99 (2026-11-15): 103 never drift. The open threads with their next steps are in `DEVELOPMENT.md` section 12; start each with the v3 oracle (section 12, "The oracle").
- Any change to `web/src/game` needs a full batch (section 6) unless it is provably behaviour-identical (say so in the fix log).

