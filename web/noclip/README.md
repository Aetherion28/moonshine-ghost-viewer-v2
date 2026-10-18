# noclip.website code used by v2

From [noclip.website](https://github.com/magcius/noclip.website) (commit fd973ff, MIT, see
`LICENSE` here): the graphics layer (`gfx/`), GameCube GX materials and drawing (`gx/`), the J3D
loader and animator, JPA and the archive / Yaz0 readers (`Common/`), and the small helpers they
use. Only the files the viewer's bundle actually uses are kept.

Changes for this viewer:
- `rustlib.ts` replaces noclip's Rust/WebAssembly support library with TypeScript versions of the
  parts used here (Yaz0, GX texture decoding, the frustum's convex hull), so there's no wasm build.
- `../stubs/` stand in for noclip's UI, camera studio, debug floaters and settings store
  (`build.mjs` swaps them in).
- The Sunshine stage loader (`src/j3d/sms_scenes.ts`) lives, trimmed, in `../src/sms_scene.ts`.
