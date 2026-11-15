# Handoff (2026-11-14)

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

## Testing the viewer

- Headless (swiftshader): `web/tools/smoke/smoke.mjs <site> <disc> <outdir> <files...>` loads the disc folder, then each recording, plays a few seconds, screenshots it and prints page errors and console errors.
  `mobile.mjs` (iPhone 13 layout), `scrub.mjs` (screens at chosen times), `mirtest.mjs` (a view with the mirrors on and off), `palm.mjs` (header at several widths).
  Swiftshader draws some water black (Bianco's river): that is the software renderer, not the viewer.
- Real hardware: the Claude in Chrome extension on the live site. The page has `#mapSelect`, `#episodeSelect`, `#sharedList` (Delfino Ghosts' shared ghosts: their Load buttons need no files), `#play`, `#scrub`, `#clockNow`.
  A background tab is throttled to near nothing (timers and rAF), so long scripted sweeps there stall; use headless for sweeps, Chrome for looking.
  Local files can't be uploaded through the extension (only files shared with the session), so in Chrome use the shared ghosts.

## What the last session did (2026-11-14: polish before the public announcement, live on main)

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
- **For the user to decide**: a licence for the repository (there is none, so all rights are reserved); whether to wire in `web/src/discformats.ts` (RVZ / WIA / GCZ / CISO readers, written but never imported or tested; most Dolphin libraries are RVZ).
- Specular light on Mario and NPCs is still off (turning it on washed them white; cause not found; `layer.ts`, search "specular").
- `CLAUDE.md` section 11, "Still not ported", lists the remaining rendering plumbing.

## Open on the simulation (v2)

- 141 batch traces, runs97: 103 never drift. The open threads with their next steps are in `CLAUDE.md` section 12; start each with the v3 oracle (section 12, "The oracle").
- Any change to `web/src/game` needs a full batch (section 6) unless it is provably behaviour-identical (say so in the fix log).

## The any% TAS work (paused)

Everything is in the `v3` branch's `CLAUDE.md` (section 12, "The any% TAS through Dolphin") and `web/tools/tascapture/`.
- The TAS (TASVideos 3731M, 2018, Dolphin 5.0-114, GMSJ01) plays in real Dolphin on the user's PC up to Manta Storm, where it parts.
  35 per-level ghosts (.smsghost V9) and traces were made from the synced part (`convert.ts`, `mkghost.py`); they are in the user's `Desktop\ghosts\SMS any% TAS 3731M - ghosts`.
- The sweep runner is `mantasweep.ps1` on the user's PC (`Desktop\ghosts\_incoming\tas`; queue `sweep_queue.txt`, results `sweep_results.txt`, the loop `run_mantasweep.cmd`, which the user starts).
- **What was found**: the run really parts at Manta Storm's first split (~field 173182). The split's angle is a `rand()` in TBossMantaManager::spawn, so our RNG is already out of step there (a GPU-dependent consumer before it). The never-set f26 in spawn is not the cause.
  Only the savestate at Sirena's start (slot 1, field 170554) is faithful; a state saved mid-stage (slot 4) is not.
- Paused there: a seed-offset test (`seedk=K`, queued as `seed1k_*`, commented out) to see how many rand steps we are off.
- The user's fallback is fine: re-sync per level.
- **zelpikukirby's newer TAS** (Any% No ACE, YouTube igm67ZABQgE, 2024-11-01) was made on a modern GPU and may sync better, but its .dtm isn't public.
  The user is contacting him (drafts were written for an X reply; other routes: speedrun.com message, TASVideos PM, YouTube or Niconico comment, Twitch).
  His posted Dolphin settings (Hacks tab, 2024-07-30): Skip EFB Access off, Ignore Format Changes off, Store EFB Copies to Texture Only off, texture cache Fast, XFB disabled, Fast Depth Calculation on, Disable Bounding Box on.

## Avoiding "chat dementia"

- Write findings into `CLAUDE.md` (fix log, open threads, refuted) in the same commit as the change, and keep this file current when the focus changes.
- Don't trust earlier messages for state that can change (deploys, the PC's sweep loop, the user's settings): check again.
