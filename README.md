# Moonshine Ghost Viewer v2

Super Mario Sunshine practice-mod ghosts (Moonshine `.smsghost`) played back in the game's own
stages, drawn by the game's own models and materials, read from your own copy of the game.

Live at https://aetherion28.github.io/moonshine-ghost-viewer-v2/ — v1 (no disc needed) is at
https://aetherion28.github.io/Moonshine-Ghost-Viewer/.

## How it works

v2 is v1's viewer (`web/viewer.html`, with v1's scripts in `web/legacy/`) with the game's renderer
under it:

- **Logic: v1's.** Everything v1 works out from the ghost — pickups and Shines (where they come
  from, their flights and demo cameras, the Shine get), carried and thrown objects, the Monty Mole
  cannon and its cork, the Chain Chomp, Gooper Blooper, moving platforms, walkers and birds, FLUDD's
  water and particles — runs unchanged, on v1's data (stage collision, object lists), which the page
  loads from v1's site.
- **Drawing: the game's.** With a disc image (`.iso` / `.gcm`) or an extracted game folder loaded
  ("Game disc"), the stage, its objects and Mario are drawn with the game's J3D models from the disc
  through [noclip.website](https://github.com/magcius/noclip.website)'s port of J3D / GX (MIT, see
  `web/noclip/`). The game layer (`web/src/layer.ts`) copies v1's scene graph onto the game's models
  every frame: each object's matrix, joints (walkers, NPCs, the Chain Chomp, Mario, FLUDD, Yoshi),
  visibility and the TEV colours v1 sets (NPC colours, the Chomp's heat, Boos, pictures), and Mario's
  hands, cap and nozzles. v1 then draws only what has no game model (water, particles, wires, goop,
  Gooper Blooper, overlays) on a transparent canvas on top, hidden behind its own depth-only copy of
  the stage and objects. Nothing from the disc leaves the browser; the site hosts no game data.

Untick "Game rendering" to see v1's own drawing. The comparison view falls back to v1's drawing.

Known gaps: the specular light is off (see the TODO in `layer.ts`), FLUDD's water gauge isn't drawn,
Gooper Blooper is still v1's model. `web/src/discformats.ts` (RVZ / WIA / GCZ / CISO) is written
but not wired in or tested yet: images need converting to ISO first.

## Building

```
cd web
npm install
node build.mjs          # site/ (minified); --dev for an unminified build
```

`site/` is what's published (GitHub Pages, `.github/workflows/pages.yml`). Locally, serve v1's
`site/` with this `site/` as its `v2/` folder.
