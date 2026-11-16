# Moonshine Ghost Viewer

Watch Super Mario Sunshine ghosts and replays recorded with [Moonshine](https://dogecyanide.github.io/moonshine-site/),
the practice mod, played back in the game's own stages with the game's own models, read from your
own copy of the game.

**Open it: https://aetherion28.github.io/moonshine-ghost-viewer-v2/**

## What you need

- **Your own copy of the game**: a disc image (`.iso` / `.gcm`, or Dolphin's `.rvz`, `.gcz`,
  `.ciso` and `.wia`) or an extracted game folder, from the US, Japanese or European release.
  Nothing is drawn until the game is loaded: the site hosts no game data, and nothing you load is
  uploaded.
- **Ghosts**: `.smsghost` files exported from Moonshine (format v5 or newer; exports are in the
  share folder on your SD card), `.msgt` replays, or ghosts shared on
  [Delfino Ghosts](https://zeldocto.github.io/delfino-ghosts/), which the viewer can browse and load.
- A browser with WebGL 2, such as a current Chrome, Edge or Firefox. The page has a phone layout
  too.

## What it does

- Draws the stage, its objects and Mario with the game's own models, materials and HUD, and plays
  the stage's music and sound effects from your disc.
- Replays (`.msgt`) are re-run from the run's controller inputs and its recorded random numbers by
  a reimplementation of the game's logic, so the stage tries to react the way it did in the run.
  It is not perfect: some things depend on the hardware the run was played on, so enemies, water
  and objects can differ from what the runner saw. When the replay parts from the recording, Mario
  goes back to following his recorded path. Ghosts follow their recorded positions and animation.
- Comparison view: two ghosts side by side, each with its own time slider.
- Follow, fixed, free and top-down cameras; frame stepping, playback speed, the controller input
  display, splits and an info box (position, speed, animation, FLUDD).
- Clips: save a stretch of a ghost as an MP4 video.
- Share links to a moment (ghost, time and camera) for ghosts from Delfino Ghosts.
- Installable as an app (Chrome, Edge, Android, iPhone and iPad via Safari's Add to Home Screen, Safari
  on a Mac via Add to Dock; there is an **Install app** button at the top). Once installed it opens
  offline; the page asks about installing only once.
- Extras: the invisible triggers and cubes, model names, a wireframe stage, Mario drawn as Shadow
  Mario, Il Piantissimo and others, and the game's water mirrors (experimental).

## Privacy and legal

No accounts, cookies, analytics or ads. Settings, converted stages and (where the browser allows
it) a copy of your disc image are kept in your own browser so the next visit opens straight away;
**Forget disc** removes the copy. The shared ghosts list comes from Delfino Ghosts' server.

This project does not host, contain or distribute any copyrighted Nintendo assets or binaries.
All game data is read in the browser from your own copy of the game, and nothing is uploaded.
The replay logic is an independent reimplementation written for interoperability and research.
*Super Mario Sunshine* and Mario are trademarks of Nintendo; this is a fan project, not affiliated with or endorsed by Nintendo.

Copyright concerns can be sent to aetherion28+legal@gmail.com; every one is read and answered.
See the full [legal notice](https://aetherion28.github.io/moonshine-ghost-viewer-v2/legal.html), which also lists the credits and the
licences of the code and fonts the site uses.

## Credits

- The simulation is written from the [Super Mario Sunshine decompilation](https://github.com/doldecomp/sms)
  and would not exist without its contributors' work.
- **Dogecyanide** made [Moonshine](https://dogecyanide.github.io/moonshine-site/), which records the
  ghosts and replays, and tested the viewer.
- **zeldocto** made [Delfino Ghosts](https://zeldocto.github.io/delfino-ghosts/), where ghosts are
  shared, and tested the viewer.
- **Lotfy** and **Basten** tested the viewer.
- [noclip.website](https://github.com/magcius/noclip.website) by Jasper St. Pierre and contributors
  draws the game's models.

## Licence

The viewer's own code is free software, © 2026 Aether10n, under the GNU General Public License,
version 3 or (at your option) any later version: see [LICENSE](LICENSE). The code it includes from
others keeps its own licence: noclip.website's renderer (`web/noclip`, MIT), three.js
(`web/vendor/three`, MIT), gl-matrix, fzstd and mp4-muxer (MIT), and the fonts (`web/vendor/fonts`,
SIL Open Font License 1.1).

The licence covers this project's own work only. It grants nothing in *Super Mario Sunshine*,
which is Nintendo's; no game data is included.

## How it works

- `web/viewer.html` is the page: the ghost list, timeline, cameras and overlays (water, particles,
  wires, goop), with v1's scripts in `web/legacy/`.
- `web/src/layer.ts` is the game layer: it reads the disc (`web/src/disc.ts`) and draws the game's
  J3D models through [noclip.website](https://github.com/magcius/noclip.website)'s J3D / GX renderer
  (MIT, in `web/noclip/`). `web/src/v1data/` makes v1's stage and object data from the disc in the
  browser, and `web/src/hud/` and `web/src/audio/` are the game's HUD and sound.
- `web/src/game/` is the simulation: a TypeScript reimplementation of the game's logic that replays
  a run's recorded controller inputs and checks itself against the recording.
  `web/tools/harness/` replays recordings from the command line to measure how long each one stays
  in sync.

Known gaps: the specular light on Mario and the characters is off, the water mirrors are still being
checked against the game. Found a problem? [Open an issue](https://github.com/Aetherion28/moonshine-ghost-viewer-v2/issues)
(the viewer's **Report a problem** link fills in your browser and disc version).

## Building

```
cd web
npm install
node build.mjs          # writes ../site (minified); --dev for an unminified build
```

`site/` is what's published (GitHub Pages, `.github/workflows/pages.yml`) and is committed, so
rebuild before committing a source change. To run it locally, serve `site/` over HTTP (for example
`python3 -m http.server -d site`) and open it on `localhost`.

Notes for developers: `DEVELOPMENT.md` (how the simulation is built and tested) and `STATUS.md` (the current state).
