// The game's EFB-to-XFB copy filter, as a pass after the frame is drawn.
//
// Sunshine draws each frame into a 640x448 EFB (SMSGetGameRenderHeight) and copies it to the
// frame buffer through GX's vertical copy filter (SMSSetupGameRenderingInfo, RenderModeObj.cpp).
// On an interlaced TV that filter is SMSVFilter_flicker = {8, 8, 10, 12, 10, 8, 8} / 64. With no
// antialiasing every sample sits at the pixel centre, so the seven weights add up per line: the
// line above gets (8+8)/64, the line itself (10+12+10)/64 and the line below (8+8)/64, i.e. a
// 1-2-1 blur over neighbouring EFB lines. (In progressive mode, SMSVFilter_non = {0, 0, 21, 22,
// 21, 0, 0}, the line itself gets all 64/64: no blur.) This is what makes the game's picture
// soft vertically. The viewer draws at the canvas's own resolution, so one EFB line here is
// 1/448 of the picture's height, whatever its size in pixels.

import { fullscreenMegaState } from '../noclip/gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import { GfxShaderLibrary } from '../noclip/gfx/helpers/GfxShaderLibrary.js';
import { GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxWrapMode } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../noclip/gfx/render/GfxRenderCache.js';
import { GfxrAttachmentSlot, GfxrGraphBuilder, GfxrRenderTargetID } from '../noclip/gfx/render/GfxRenderGraph.js';
import type { GfxRenderHelper } from '../noclip/gfx/render/GfxRenderHelper.js';
import { preprocessProgram_GLSL } from '../noclip/gfx/shaderc/GfxShaderCompiler.js';

/** The game's EFB height in lines (SMSGetGameRenderHeight, NTSC). */
const EFB_LINES = 448;

const frag = `
uniform sampler2D u_Texture;
in vec2 v_TexCoord;

void main() {
    vec2 t_Line = vec2(0.0, 1.0 / ${EFB_LINES}.0);
    vec4 c = texture(SAMPLER_2D(u_Texture), v_TexCoord) * 0.5;
    c += texture(SAMPLER_2D(u_Texture), v_TexCoord - t_Line) * 0.25;
    c += texture(SAMPLER_2D(u_Texture), v_TexCoord + t_Line) * 0.25;
    gl_FragColor = vec4(c.rgb, 1.0);
}
`;

export class CopyFilter {
    private program: GfxProgram;
    private sampler: GfxSampler;
    /** Off: the progressive-scan picture (no vertical filter). */
    public enabled = true;

    constructor(cache: GfxRenderCache) {
        this.program = cache.createProgramSimple(preprocessProgram_GLSL(cache.device.queryVendorInfo(), GfxShaderLibrary.fullscreenVS, frag));
        this.sampler = cache.createSampler({
            wrapS: GfxWrapMode.Clamp, wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear, mipFilter: GfxMipFilterMode.Nearest,
        });
    }

    public pushPasses(builder: GfxrGraphBuilder, renderHelper: GfxRenderHelper, mainColorTargetID: GfxrRenderTargetID): void {
        if (!this.enabled) return;
        builder.pushPass((pass) => {
            pass.setDebugName('Copy filter');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            const resolveID = builder.resolveRenderTarget(mainColorTargetID);
            pass.attachResolveTexture(resolveID);
            const renderInst = renderHelper.renderInstManager.newRenderInst();
            renderInst.setUniformBuffer(renderHelper.uniformBuffer);
            renderInst.setAllowSkippingIfPipelineNotReady(false);
            renderInst.setMegaStateFlags(fullscreenMegaState);
            renderInst.setBindingLayouts([{ numUniformBuffers: 0, numSamplers: 1 }]);
            renderInst.setDrawCount(3);
            renderInst.setGfxProgram(this.program);
            pass.exec((passRenderer, scope) => {
                renderInst.setSamplerBindingsFromTextureMappings([{ gfxTexture: scope.getResolveTextureForID(resolveID), gfxSampler: this.sampler }]);
                renderInst.drawOnPass(renderHelper.renderCache, passRenderer);
            });
        });
    }
}
