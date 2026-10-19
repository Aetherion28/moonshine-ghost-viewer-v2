# Moonshine Ghost Viewer v2

Super Mario Sunshine practice-mod ghosts (Moonshine `.smsghost`) played back in the game's own
stages, drawn by the game's own models and materials, read from your own copy of the game.

Live at https://aetherion28.github.io/moonshine-ghost-viewer-v2/. It needs your own copy of the
game: nothing is loaded or drawn until a disc image (`.iso` / `.gcm`) or an extracted game folder is
given, and there is no fallback to the viewer's own models.

## How it works

v2 is v1's viewer (`web/viewer.html`, with v1's scripts in `web/legacy/`) with the game's renderer
under it:

- **Logic: v1's.** Everything v1 works out from the ghost — pickups and Shines (where they come
  from, their flights and demo cameras, the Shine get), carried and thrown objects, the Monty Mole
  cannon and its cork, the Chain Chomp, Gooper Blooper, moving platforms, walkers and birds, FLUDD's
  water and particles — runs unchanged, on v1's data (stage models and collision, object lists and
  libraries, Mario and Yoshi, particles, FLUDD's water textures, the Shine get). v2 makes that data
  in the browser from the user's disc: `web/src/v1data/` is a TypeScript port of v1's converters
  (`tools/` in the v1 repository), checked to give the same output. v2 doesn't load anything from
  v1's site; v1 stays up on its own.
- **Drawing: the game's.** With a disc image (`.iso` / `.gcm`) or an extracted game folder loaded
  ("Game disc"), the stage, its objects and Mario are drawn with the game's J3D models from the disc
  through [noclip.website](https://github.com/magcius/noclip.website)'s port of J3D / GX (MIT, see
  `web/noclip/`). The game layer (`web/src/layer.ts`) copies v1's scene graph onto the game's models
  every frame: each object's matrix, joints (walkers, NPCs, the Chain Chomp, Mario, FLUDD, Yoshi),
  visibility and the TEV colours v1 sets (NPC colours, the Chomp's heat, Boos, pictures), and Mario's
  hands, cap and nozzles. v1 then draws only what has no game model (water, particles, wires, goop,
  Gooper Blooper, overlays) on a transparent canvas on top, hidden behind its own depth-only copy of
  the stage and objects. Nothing from the disc leaves the browser; the site hosts no game data.

There is no option to draw with v1's own models.
The comparison view (two ghosts side by side, or one above the other on a phone held upright) draws
each half with the game too: the second half has its own game layer, a second canvas over that half
with its own stage and its own input replay.

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
