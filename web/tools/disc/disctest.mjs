// Checks the viewer's disc reader (src/disc.ts with src/discformats.ts) against a plain ISO.
//   node tools/disc/disctest.mjs <game.iso> [other images of the same disc: .rvz .gcz .ciso .wia ...]
// Every file on the disc is read through each image and compared with the ISO's bytes; then cut-off,
// empty and random images must be turned down with a message. Run from web/.
// Make the other images with nodtool (cargo install nodtool): nodtool convert -c zstd:19 game.iso game.rvz
import { build } from 'esbuild';
import { openAsBlob, openSync, readSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
const out = join(mkdtempSync(join(tmpdir(), 'disctest-')), 'disc.mjs');
await build({ entryPoints: ['src/disc.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning' });
const { openDisc } = await import(out);
const [iso, ...imgs] = process.argv.slice(2);
const named = (blob, name) => Object.assign(blob, { name });
const fd = openSync(iso, 'r');
const want = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
const isoBlob = await openAsBlob(iso);
const ref = await openDisc(named(isoBlob, basename(iso)));
const files = ref.list();
const h = want(0, 0x440), fst = want(h.readUInt32BE(0x424), h.readUInt32BE(0x428));
const where = new Map(); // path -> [off, len] from the ISO's own FST, read independently of disc.ts
{ const n = fst.readUInt32BE(8), str = n * 12, dec = new TextDecoder('shift_jis'), ends = [[n, '']];
  for (let i = 1; i < n; i++) { while (i >= ends.at(-1)[0]) ends.pop();
    const o = str + (fst.readUInt32BE(i * 12) & 0xFFFFFF), nm = dec.decode(fst.subarray(o, fst.indexOf(0, o)));
    const p = ends.at(-1)[1] + nm;
    if (fst[i * 12]) ends.push([fst.readUInt32BE(i * 12 + 8), p + '/']); else where.set(p.toLowerCase(), [fst.readUInt32BE(i * 12 + 4), fst.readUInt32BE(i * 12 + 8)]); } }
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fails++; };
ok(files.length === where.size && files.every((p) => where.has(p)), `${basename(iso)}: ${files.length} files listed (${ref.id} rev ${ref.revision})`);
for (const img of [iso, ...imgs]) {
  const t0 = Date.now();
  let d; try { d = await openDisc(named(await openAsBlob(img), basename(img))); } catch (e) { console.log(`--   ${basename(img)}: ${e.message}`); continue; }
  let bad = 0, bytes = 0;
  for (const p of files) { const [off, len] = where.get(p); const got = Buffer.from(await d.read(p)); bytes += len; if (Buffer.compare(got, want(off, len))) { if (bad++ < 3) console.log('     differs:', p); } }
  // ranges, as the movies are read
  const thp = files.find((p) => p.endsWith('.thp'));
  if (thp) for (const [o, l] of [[0, 64], [12345, 100000], [where.get(thp)[1] - 10, 50]]) { const [off, len] = where.get(thp); const e = Math.min(len, o + l); if (Buffer.compare(Buffer.from(await d.readRange(thp, o, l)), want(off + o, e - o))) bad++; }
  ok(!bad, `${basename(img)}: ${files.length - bad}/${files.length} files identical (${(bytes / 1048576) | 0} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// turned down, with a message
const refuse = async (what, blob, name, re) => { try { await openDisc(named(blob, name)); ok(false, `${what}: opened`); } catch (e) { ok(re.test(e.message), `${what}: "${e.message}"`); } };
await refuse('ISO cut at 1 GB', isoBlob.slice(0, 1e9), 'cut.iso', /incomplete/);
await refuse('ISO cut inside its file system', isoBlob.slice(0, 0x40B000), 'cut2.iso', /incomplete/);
await refuse('ISO cut at 256 bytes', isoBlob.slice(0, 256), 'cut3.iso', /isn't a GameCube disc/);
await refuse('empty file', new Blob([]), 'empty.iso', /isn't a GameCube disc/);
await refuse('random bytes', new Blob([crypto.getRandomValues(new Uint8Array(65536))]), 'random.iso', /isn't a GameCube disc/);
for (const img of imgs) { const b = await openAsBlob(img); await refuse(`${basename(img)} cut in half`, b.slice(0, Math.floor(b.size / 2)), 'cut-' + basename(img), /incomplete|compression/); }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
