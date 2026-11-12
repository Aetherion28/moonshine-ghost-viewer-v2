// v3, the page's GPU: the frame buffer the game draws into (the EFB: 640 x 528, colour with alpha, and depth),
// and what the copy command (BP 0x52) does with it: a copy to the display ends the frame and is shown on the
// canvas; a copy to a texture makes the texture the game will bind at that address (Mario's shadow, the screen
// behind heat haze and water, the goop maps); either can clear the rectangle afterwards.
//
// Rows are kept as the game counts them: row 0 of the textures here is the top line of the screen (so a copy is
// a texture like any decoded one, and only the last step to the canvas turns the picture over).
// Depth is kept reversed (1 at the near plane), as the shader generator's fog expects.

export const EFB_W = 640, EFB_H = 528;

const VERT = `#version 300 es
precision highp float;
uniform vec4 u_Rect;
out vec2 v_Uv;
void main() {
    vec2 p = vec2(float(gl_VertexID & 1) * 2.0, float(gl_VertexID & 2));
    v_Uv = u_Rect.xy + p * u_Rect.zw;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// the copy: the source's colour (or its depth as three bytes: high, middle, low) through a matrix that picks the
// channels the copy's format keeps
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Color;
uniform sampler2D u_Depth;
uniform int u_FromDepth;
uniform mat4 u_Pick;
uniform vec4 u_Add;
in vec2 v_Uv;
out vec4 o_Color;
void main() {
    vec4 c;
    if (u_FromDepth != 0) {
        uint z = uint(clamp(1.0 - texture(u_Depth, v_Uv).r, 0.0, 1.0) * 16777215.0 + 0.5);
        c = vec4(float(z >> 16u), float((z >> 8u) & 255u), float(z & 255u), 255.0) / 255.0;
    } else c = texture(u_Color, v_Uv);
    o_Color = u_Pick * c + u_Add;
}`;

/** which source channel each of the copy's red, green, blue and alpha takes (0..3; 4: one; 5: the brightness) */
type Pick = [number, number, number, number];
// the copy's formats (the number in the command: 0 R4, 1 R8, 2 RA4, 3 RA8, 4 RGB565, 5 RGB5A3, 6 RGBA8, 7 A8, 8 R8, 9 G8, 10 B8, 11 RG8, 12 GB8)
const COLOR_PICK: Pick[] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 3], [0, 0, 0, 3], [0, 1, 2, 4], [0, 1, 2, 3], [0, 1, 2, 3], [3, 3, 3, 3], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [0, 0, 0, 1], [1, 1, 1, 2]];
// the same numbers when the depth is copied: Z8 (its high byte), Z16 (middle byte with the high as alpha), Z24X8, the single bytes, Z16L
const DEPTH_PICK: Pick[] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 0], [0, 1, 2, 4], [0, 1, 2, 4], [0, 1, 2, 4], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [1, 1, 1, 0], [2, 2, 2, 1]];
const INTENSITY: Pick[] = [[5, 5, 5, 5], [5, 5, 5, 5], [5, 5, 5, 3], [5, 5, 5, 3]];
/** bits a texel of each copy format has in RAM */
const COPY_BITS = [4, 8, 8, 16, 16, 16, 32, 8, 8, 8, 8, 16, 16];

export class Efb {
    readonly w: number; readonly h: number;
    fbo: WebGLFramebuffer; color: WebGLTexture; depth: WebGLTexture;
    private copyFbo: WebGLFramebuffer;
    private prog: WebGLProgram;
    private uRect: WebGLUniformLocation; private uFromDepth: WebGLUniformLocation; private uPick: WebGLUniformLocation; private uAdd: WebGLUniformLocation;
    private pick = new Float32Array(16); private add = new Float32Array(4);

    /** scale: how many pixels a side for each of the game's */
    constructor(private gl: WebGL2RenderingContext, readonly scale: number) {
        this.w = EFB_W * scale; this.h = EFB_H * scale;
        const tex = (internal: number, format: number, type: number, filter: number) => {
            const t = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.w, this.h, 0, format, type, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
            return t;
        };
        this.color = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        this.depth = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
        this.fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
        this.copyFbo = gl.createFramebuffer()!;
        const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
        const p = this.prog = gl.createProgram()!;
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('[gx] the copy program: ' + gl.getProgramInfoLog(p));
        gl.useProgram(p);
        gl.uniform1i(gl.getUniformLocation(p, 'u_Color'), 0); gl.uniform1i(gl.getUniformLocation(p, 'u_Depth'), 1);
        this.uRect = gl.getUniformLocation(p, 'u_Rect')!; this.uFromDepth = gl.getUniformLocation(p, 'u_FromDepth')!;
        this.uPick = gl.getUniformLocation(p, 'u_Pick')!; this.uAdd = gl.getUniformLocation(p, 'u_Add')!;
        // (all of it starts as the console's does after a clear to black, alpha full)
        gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.depthMask(true);
        gl.clearColor(0, 0, 0, 1); gl.clearDepth(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    /** the bytes the image of a copy has in RAM */
    static copyBytes(format: number, w: number, h: number): number {
        const bits = COPY_BITS[format] ?? 32, bw = bits === 4 || bits === 8 ? 8 : 4, bh = bits === 4 ? 8 : 4;
        return (Math.ceil(w / bw) * bw) * (Math.ceil(h / bh) * bh) * bits / 8;
    }

    /**
     * The rectangle (x, y, w, h: the game's pixels) into `tex` (made w x h, or half that, times the scale).
     * format: the copy's; intensity: brightness instead of red (the formats that have it); fromDepth: the depth is copied.
     * Leaves the frame buffer, program, vertex array, units 0 and 1 and most pixel state changed: the caller sets its own again.
     */
    copyTo(tex: WebGLTexture, x: number, y: number, w: number, h: number, half: boolean, format: number, intensity: boolean, fromDepth: boolean): { w: number; h: number } {
        const gl = this.gl, s = this.scale;
        const dw = Math.max(1, half ? w >> 1 : w), dh = Math.max(1, half ? h >> 1 : h);
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, dw * s, dh * s, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindTexture(gl.TEXTURE_2D, this.color);
        gl.activeTexture(gl.TEXTURE1); gl.bindSampler(1, null); gl.bindTexture(gl.TEXTURE_2D, this.depth);
        gl.useProgram(this.prog);
        gl.viewport(0, 0, dw * s, dh * s);
        gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
        gl.colorMask(true, true, true, true);
        gl.uniform4f(this.uRect, x / EFB_W, y / EFB_H, w / EFB_W, h / EFB_H);
        gl.uniform1i(this.uFromDepth, fromDepth ? 1 : 0);
        const pick = fromDepth ? DEPTH_PICK[format] : intensity && format < 4 ? INTENSITY[format] : intensity && format === 8 ? INTENSITY[0] : COLOR_PICK[format];
        const P = this.pick, A = this.add;
        P.fill(0); A.fill(0);
        for (let out = 0; out < 4; out++) {
            const from = (pick ?? [0, 1, 2, 3])[out];
            // (the matrix is by columns: element [column * 4 + row] is how much of source channel `column` goes to `out`)
            if (from < 4) P[from * 4 + out] = 1;
            else if (from === 4) A[out] = 1;
            else { P[out] = 0.257; P[4 + out] = 0.504; P[8 + out] = 0.098; A[out] = 16 / 255; }
        }
        gl.uniformMatrix4fv(this.uPick, false, P); gl.uniform4fv(this.uAdd, A);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
        return { w: dw, h: dh };
    }

    /** the rectangle onto the canvas (all of it), right way up */
    present(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
        const gl = this.gl, s = this.scale;
        if (canvas.width !== w * s || canvas.height !== h * s) { canvas.width = w * s; canvas.height = h * s; }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
        gl.blitFramebuffer(x * s, y * s, (x + w) * s, (y + h) * s, 0, h * s, w * s, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }

    /** the rectangle to a colour and a depth (the game's: 24 bits, 0 nearest), each only where asked */
    clear(x: number, y: number, w: number, h: number, rgba: number[], color: boolean, alpha: boolean, z: number | null) {
        const gl = this.gl, s = this.scale;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(x * s, y * s, w * s, h * s);
        gl.colorMask(color, color, color, alpha); gl.depthMask(z !== null);
        gl.clearColor(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3] / 255);
        if (z !== null) gl.clearDepth(1 - z / 0xFFFFFF);
        const bits = (color || alpha ? gl.COLOR_BUFFER_BIT : 0) | (z !== null ? gl.DEPTH_BUFFER_BIT : 0);
        if (bits) gl.clear(bits);
    }

    destroy() {
        const gl = this.gl;
        gl.deleteFramebuffer(this.fbo); gl.deleteFramebuffer(this.copyFbo);
        gl.deleteTexture(this.color); gl.deleteTexture(this.depth); gl.deleteProgram(this.prog);
    }
}
