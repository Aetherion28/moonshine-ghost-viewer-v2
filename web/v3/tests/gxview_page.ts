// The page side of tests/gxview.mjs: feeds dumped frames (web/gxframe.ts, one file a frame) to the page's GPU
// (page/gx/renderer.ts) and hands back each frame's statistics and the canvas as a PNG.
import { GxRenderer, GxStats } from '../page/gx/renderer.js';
import { decodeGxFrame } from '../web/gxframe.js';

let renderer: GxRenderer | null = null;
const canvas = document.getElementById('gx') as HTMLCanvasElement;

const api = {
    start(scale: number) { renderer?.destroy(); renderer = new GxRenderer(canvas, scale); },
    /** fetches and draws frame `name`; returns its statistics and the time it took with the GPU's work done */
    async feed(name: string): Promise<GxStats & { total: number; bytes: number; fifo: number } | null> {
        const r = await fetch('/frames/' + name);
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer()), f = decodeGxFrame(bytes);
        const t0 = performance.now();
        renderer!.frame(f);
        // (reading a pixel back waits for the drawing to be done)
        const gl = canvas.getContext('webgl2')!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        return { ...renderer!.stats, total: performance.now() - t0, bytes: bytes.length, fifo: f.fifo.length };
    },
    shot(): string { return canvas.toDataURL('image/png'); },
    /** the frame buffer copies as PNGs (colour and alpha side by side), by the address of their image */
    copies(): { addr: number; png: string }[] {
        const out: { addr: number; png: string }[] = [];
        for (const addr of renderer!.copyAddresses()) {
            const c = renderer!.readCopy(addr);
            if (!c) continue;
            const cv = document.createElement('canvas'), cx = cv.getContext('2d')!;
            cv.width = c.w * 2; cv.height = c.h;
            const im = cx.createImageData(c.w * 2, c.h);
            for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
                const s = (y * c.w + x) * 4, d = (y * c.w * 2 + x) * 4, e = d + c.w * 4;
                im.data[d] = c.data[s]; im.data[d + 1] = c.data[s + 1]; im.data[d + 2] = c.data[s + 2]; im.data[d + 3] = 255;
                im.data[e] = im.data[e + 1] = im.data[e + 2] = c.data[s + 3]; im.data[e + 3] = 255;
            }
            cx.putImageData(im, 0, 0);
            out.push({ addr, png: cv.toDataURL('image/png') });
        }
        return out;
    },
};
(window as unknown as { gxview: typeof api }).gxview = api;
