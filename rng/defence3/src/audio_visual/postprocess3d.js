"use strict";

// ============================================================
// 3D POST PROCESSING
// ============================================================
// Screen-space passes run after the scene is resolved from its off-screen
// target. Every effect is a compile-time variant of one composite shader, so a
// disabled effect costs nothing; only AO and bloom need their own (reduced
// resolution) passes. With nothing enabled the renderer keeps its plain blit.
(function () {
    // Presets and option normalization live in data_state.js (GRAPHICS_*).

    function compile(gl, vs, fs) {
        let make = (type, src) => {
            let s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                let msg = gl.getShaderInfoLog(s) || 'post shader compile error';
                gl.deleteShader(s);
                throw new Error(msg);
            }
            return s;
        };
        let p = gl.createProgram();
        let v = make(gl.VERTEX_SHADER, vs), f = make(gl.FRAGMENT_SHADER, fs);
        gl.attachShader(p, v); gl.attachShader(p, f);
        gl.linkProgram(p);
        gl.deleteShader(v); gl.deleteShader(f);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            let msg = gl.getProgramInfoLog(p) || 'post program link error';
            gl.deleteProgram(p);
            throw new Error(msg);
        }
        return p;
    }

    const FULLSCREEN_VS = `#version 300 es
        layout(location = 0) in vec2 aPosition;
        out vec2 vUv;
        void main() { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }`;

    // Inverse view depth is affine in screen space on any plane, so its
    // Laplacian/extrapolation errors isolate real geometric discontinuities
    // (and the ground plane never self-occludes or outlines).
    const DEPTH_GLSL = `
        uniform sampler2D uDepth;
        uniform vec2 uNearFar;
        float invDepth(vec2 uv) {
            float d = texture(uDepth, uv).r;
            return (uNearFar.y - d * (uNearFar.y - uNearFar.x)) / (uNearFar.x * uNearFar.y);
        }`;

    const AO_FS = (taps) => `#version 300 es
        precision highp float;
        in vec2 vUv;
        uniform vec2 uTexel;      // depth texel size
        uniform float uProjScale; // depth pixels per world unit at view depth 1
        uniform float uWorldRadius;
        ${DEPTH_GLSL}
        out vec4 outAo;
        void main() {
            float d0 = texture(uDepth, vUv).r;
            if (d0 >= 1.0) { outAo = vec4(1.0); return; }
            float w0 = invDepth(vUv);
            // Plane through the centre from the smaller one-sided gradient, so
            // silhouettes do not tilt it.
            float wl = invDepth(vUv - vec2(uTexel.x, 0.0)), wr = invDepth(vUv + vec2(uTexel.x, 0.0));
            float wd = invDepth(vUv - vec2(0.0, uTexel.y)), wu = invDepth(vUv + vec2(0.0, uTexel.y));
            vec2 grad = vec2(abs(wr - w0) < abs(w0 - wl) ? wr - w0 : w0 - wl,
                             abs(wu - w0) < abs(w0 - wd) ? wu - w0 : w0 - wd);
            // Interleaved gradient noise rotates the kernel per pixel; the
            // composite's bilinear taps average the pattern out.
            float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            float angle = noise * 6.2831853;
            float occ = 0.0;
            float z0 = 1.0 / w0;
            // Sample radius: a fixed world size, so near and far ground
            // (tilted views) occlude alike, clamped for the cost of far taps.
            float uRadiusPx = clamp(uWorldRadius * .75 * uProjScale / z0, 2.0, 48.0);
            for (int i = 0; i < ${taps}; i++) {
                float fi = float(i);
                float r = (fi + 0.5 + noise) / float(${taps});
                float a = angle + fi * 2.39996323;
                vec2 off = vec2(cos(a), sin(a)) * r * uRadiusPx;
                vec2 uv = vUv + off * uTexel;
                float ws = invDepth(uv);
                float expected = w0 + dot(off, grad);
                float zs = 1.0 / ws;
                // Closer than the local plane by a margin, within a world radius.
                float closer = (ws - expected) * z0 * z0;
                float range = 1.0 - smoothstep(0.0, uWorldRadius, z0 - zs);
                occ += smoothstep(0.004, 0.05, closer) * range;
            }
            float ao = 1.0 - occ / float(${taps});
            outAo = vec4(ao, ao, ao, 1.0);
        }`;

    const BRIGHT_FS = `#version 300 es
        precision mediump float;
        in vec2 vUv;
        uniform sampler2D uColor;
        uniform vec2 uTexel; // source texel
        out vec4 outColor;
        vec3 bright(vec3 c) {
            // Luminance, so saturated team colours do not glow; lasers,
            // fire and explosions (near white) do.
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            return c * smoothstep(0.66, 0.92, l);
        }
        void main() {
            // 4 bilinear taps = 16 source texels for the quarter-size target.
            vec3 c = bright(texture(uColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb)
                   + bright(texture(uColor, vUv + uTexel * vec2( 1.0, -1.0)).rgb)
                   + bright(texture(uColor, vUv + uTexel * vec2(-1.0,  1.0)).rgb)
                   + bright(texture(uColor, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
            outColor = vec4(c * 0.25, 1.0);
        }`;

    // 9-tap Gaussian from 5 bilinear fetches.
    const BLUR_FS = `#version 300 es
        precision mediump float;
        in vec2 vUv;
        uniform sampler2D uColor;
        uniform vec2 uDir; // texel step along the blur axis
        out vec4 outColor;
        void main() {
            vec3 c = texture(uColor, vUv).rgb * 0.2270270270;
            c += texture(uColor, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
            c += texture(uColor, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
            c += texture(uColor, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
            c += texture(uColor, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
            outColor = vec4(c, 1.0);
        }`;

    function compositeSource(f) {
        let defs = Object.keys(f).filter(k => f[k]).map(k => '#define ' + k.toUpperCase() + ' ' + (f[k] === true ? 1 : f[k])).join('\n');
        if (f.shadowmap) defs += '\n#define SHADOW_TAPS ' + f.shadowmap;
        return `#version 300 es
        precision highp float;
        ${defs}
        in vec2 vUv;
        uniform sampler2D uColor;
        uniform vec2 uTexel;
        uniform sampler2D uAo;
        uniform vec2 uAoTexel;
        uniform sampler2D uBloom;
        uniform float uOutlineScale;
        uniform float uSharpen;   // sharpening amount
        uniform highp sampler2DShadow uShadowMap;
        uniform mat4 uInvViewProj;
        uniform mat4 uLightViewProj;
        uniform float uShadowTexel;
        uniform float uShadowWorldTexel;
        uniform vec3 uLightDir;
        ${DEPTH_GLSL}
        out vec4 outColor;
        float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
        #ifdef FXAA
        vec3 fxaa(vec2 uv, vec3 rgbM) {
            vec3 rgbNW = texture(uColor, uv + vec2(-1.0, -1.0) * uTexel).rgb;
            vec3 rgbNE = texture(uColor, uv + vec2( 1.0, -1.0) * uTexel).rgb;
            vec3 rgbSW = texture(uColor, uv + vec2(-1.0,  1.0) * uTexel).rgb;
            vec3 rgbSE = texture(uColor, uv + vec2( 1.0,  1.0) * uTexel).rgb;
            float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
            float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
            float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
            if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;
            vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
            float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
            float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
            dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;
            vec3 a = 0.5 * (texture(uColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
            vec3 b = a * 0.5 + 0.25 * (texture(uColor, uv - dir * 0.5).rgb + texture(uColor, uv + dir * 0.5).rgb);
            float lB = luma(b);
            return (lB < lMin || lB > lMax) ? a : b;
        }
        #endif
        void main() {
            vec3 base = texture(uColor, vUv).rgb;
            vec3 c = base;
        #ifdef FXAA
            c = fxaa(vUv, base);
        #endif
        #ifdef SHADOWMAP
            {
                float d = texture(uDepth, vUv).r;
                if (d < 1.0) {
                    vec2 ndc = vUv * 2.0 - 1.0;
                    vec4 wh = uInvViewProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
                    vec3 world = wh.xyz / wh.w;
                    // Surface normal from depth, facing the camera.
                    vec3 n = normalize(cross(dFdx(world), dFdy(world)));
                    vec4 nearH = uInvViewProj * vec4(ndc, -1.0, 1.0);
                    if (dot(n, world - nearH.xyz / nearH.w) > 0.0) n = -n;
                    // Faces turned from the light are already in cel shade;
                    // only lit faces receive cast shadows (no double darkening
                    // and no acne at grazing angles).
                    float facing = smoothstep(0.08, 0.28, dot(n, uLightDir));
                    // Normal offset of ~1.5 shadow texels.
                    world += n * uShadowWorldTexel * 1.5;
                    vec4 lp = uLightViewProj * vec4(world, 1.0);
                    vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
                    if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0))) && sc.z < 1.0) {
                        float z = sc.z - 0.0008;
                        float lit = 0.0;
                        // Each comparison tap is already bilinear-filtered PCF.
            #if SHADOW_TAPS == 16
                        for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
                            lit += texture(uShadowMap, vec3(sc.xy + (vec2(x, y) - 1.5) * uShadowTexel, z));
                        lit *= 1.0 / 16.0;
            #else
                        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
                            lit += texture(uShadowMap, vec3(sc.xy + vec2(x, y) * uShadowTexel, z));
                        lit *= 1.0 / 9.0;
            #endif
                        c *= mix(1.0, mix(0.5, 1.0, lit), facing);
                    }
                }
            }
        #endif
        #ifdef SHARPEN
            {
                vec3 n = texture(uColor, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uColor, vUv - vec2(uTexel.x, 0.0)).rgb
                       + texture(uColor, vUv + vec2(0.0, uTexel.y)).rgb + texture(uColor, vUv - vec2(0.0, uTexel.y)).rgb;
                c = clamp(c + (base * 4.0 - n) * uSharpen, 0.0, 1.0);
            }
        #endif
        #ifdef AO
            {
                // 4 bilinear taps over the reduced-size AO smooth its noise.
                float ao = texture(uAo, vUv + uAoTexel * vec2(-0.75, -0.75)).r + texture(uAo, vUv + uAoTexel * vec2(0.75, -0.75)).r
                         + texture(uAo, vUv + uAoTexel * vec2(-0.75, 0.75)).r + texture(uAo, vUv + uAoTexel * vec2(0.75, 0.75)).r;
                c *= mix(0.45, 1.0, ao * 0.25);
            }
        #endif
        #ifdef OUTLINE
            {
                float d0 = texture(uDepth, vUv).r;
                if (d0 < 1.0) {
                    vec2 s = uTexel * uOutlineScale;
                    float w0 = invDepth(vUv);
                    float lap = invDepth(vUv + vec2(s.x, 0.0)) + invDepth(vUv - vec2(s.x, 0.0))
                              + invDepth(vUv + vec2(0.0, s.y)) + invDepth(vUv - vec2(0.0, s.y)) - 4.0 * w0;
                    // Only the far side of a silhouette inks, keeping lines one
                    // pixel wide and on the ground rather than on the object.
                    float edge = smoothstep(0.035, 0.12, lap / w0);
                    c *= 1.0 - 0.62 * edge;
                }
            }
        #endif
        #ifdef BLOOM
            c += texture(uBloom, vUv).rgb * 0.7;
        #endif
        #ifdef GRADE
            {
                // Gentle S-curve, a little saturation and a soft vignette.
                c = clamp(c, 0.0, 1.0);
                c = mix(c, c * c * (3.0 - 2.0 * c), 0.35);
                float l = luma(c);
                c = mix(vec3(l), c, 1.14) * vec3(1.02, 1.0, 0.97);
                vec2 v = vUv - 0.5;
                c *= 1.0 - 0.32 * smoothstep(0.18, 0.62, dot(v, v));
            }
        #endif
            outColor = vec4(c, 1.0);
        }`;
    }

    function makeTarget(gl, internal, format, type) {
        let tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        let fb = gl.createFramebuffer();
        return { tex, fb, width: 0, height: 0, internal, format, type };
    }

    function sizeTarget(gl, t, width, height) {
        if (t.width === width && t.height === height) return;
        t.width = width; t.height = height;
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, t.internal, width, height, 0, t.format, t.type, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }

    class Defence3PostProcess {
        constructor(gl) {
            this.gl = gl;
            this.programs = new Map();
            this.targets = null;
            this.stats = { passes: 0 };
        }

        // Features the composite pass needs for these options and this frame.
        features(options, flat) {
            return {
                fxaa: options.aa === 'fxaa' || options.aa === 'msaa_fxaa',
                sharpen: !!options.sharpen,
                ao: !flat && options.ao !== 'off',
                outline: !flat && !!options.outline,
                bloom: !!options.bloom,
                grade: !!options.grade,
                // Shadow-mapped modes: the tap count (0 = none).
                shadowmap: !flat && (options.shadows === 'detailed' || options.shadows === 'high') ? (options.shadows === 'high' ? 16 : 9) : 0
            };
        }

        isActive(options, flat) {
            let f = this.features(options, flat);
            for (let k in f) if (f[k]) return true;
            return false;
        }

        needsDepth(options, flat) {
            let f = this.features(options, flat);
            return !!(f.ao || f.outline || f.shadowmap);
        }

        program(key, build) {
            let entry = this.programs.get(key);
            if (entry) return entry;
            let gl = this.gl;
            let program = compile(gl, FULLSCREEN_VS, build());
            let uniforms = {};
            let count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
            for (let i = 0; i < count; i++) {
                let info = gl.getActiveUniform(program, i);
                if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name);
            }
            entry = { program, uniforms };
            this.programs.set(key, entry);
            return entry;
        }

        ensureTargets() {
            if (this.targets) return this.targets;
            let gl = this.gl;
            this.targets = {
                ao: makeTarget(gl, gl.R8, gl.RED, gl.UNSIGNED_BYTE),
                bloomA: makeTarget(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
                bloomB: makeTarget(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE)
            };
            return this.targets;
        }

        drawQuad(vao) {
            let gl = this.gl;
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            this.stats.passes++;
        }

        // frame: { colorTex, depthTex, width, height, near, far, flat,
        //          quadVao, pixelsPerWorld, pixelRatio }
        render(options, frame) {
            let gl = this.gl;
            let f = this.features(options, frame.flat);
            // Shadow-mapped modes resolve only once the map exists this frame.
            if (f.shadowmap && !frame.shadow) f.shadowmap = 0;
            this.stats.passes = 0;
            let { width, height } = frame;
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.activeTexture(gl.TEXTURE0);
            let targets = (f.ao || f.bloom) ? this.ensureTargets() : null;

            if (f.ao) {
                let high = options.ao === 'high';
                let div = high ? 1 : 2;
                let t = targets.ao;
                sizeTarget(gl, t, Math.max(1, Math.ceil(width / div)), Math.max(1, Math.ceil(height / div)));
                let taps = high ? 16 : 8;
                let p = this.program('ao' + taps, () => AO_FS(taps));
                gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
                gl.viewport(0, 0, t.width, t.height);
                gl.useProgram(p.program);
                gl.bindTexture(gl.TEXTURE_2D, frame.depthTex);
                gl.uniform1i(p.uniforms.uDepth, 0);
                gl.uniform2f(p.uniforms.uNearFar, frame.near, frame.far);
                gl.uniform2f(p.uniforms.uTexel, 1 / width, 1 / height);
                gl.uniform1f(p.uniforms.uProjScale, frame.projectionScale || (frame.pixelsPerWorld || 40) * 20);
                gl.uniform1f(p.uniforms.uWorldRadius, 0.6);
                this.drawQuad(frame.quadVao);
            }

            if (f.bloom) {
                let bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
                sizeTarget(gl, targets.bloomA, bw, bh);
                sizeTarget(gl, targets.bloomB, bw, bh);
                let bright = this.program('bright', () => BRIGHT_FS);
                gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomA.fb);
                gl.viewport(0, 0, bw, bh);
                gl.useProgram(bright.program);
                gl.bindTexture(gl.TEXTURE_2D, frame.colorTex);
                gl.uniform1i(bright.uniforms.uColor, 0);
                gl.uniform2f(bright.uniforms.uTexel, 1 / width, 1 / height);
                this.drawQuad(frame.quadVao);
                let blur = this.program('blur', () => BLUR_FS);
                gl.useProgram(blur.program);
                gl.uniform1i(blur.uniforms.uColor, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomB.fb);
                gl.bindTexture(gl.TEXTURE_2D, targets.bloomA.tex);
                gl.uniform2f(blur.uniforms.uDir, 1 / bw, 0);
                this.drawQuad(frame.quadVao);
                gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomA.fb);
                gl.bindTexture(gl.TEXTURE_2D, targets.bloomB.tex);
                gl.uniform2f(blur.uniforms.uDir, 0, 1 / bh);
                this.drawQuad(frame.quadVao);
            }

            let key = 'c:' + Object.keys(f).filter(k => f[k]).map(k => k + '=' + f[k]).join(',');
            let p = this.program(key, () => compositeSource(f));
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            gl.useProgram(p.program);
            let u = p.uniforms;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, frame.colorTex);
            gl.uniform1i(u.uColor, 0);
            if (u.uTexel) gl.uniform2f(u.uTexel, 1 / width, 1 / height);
            if (u.uDepth) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, frame.depthTex);
                gl.uniform1i(u.uDepth, 1);
                gl.uniform2f(u.uNearFar, frame.near, frame.far);
            }
            if (u.uOutlineScale) gl.uniform1f(u.uOutlineScale, Math.max(1, Math.round(frame.pixelRatio || 1)));
            if (u.uSharpen) gl.uniform1f(u.uSharpen, GRAPHICS_SHARPEN_AMOUNT[String(options.sharpen)] || GRAPHICS_SHARPEN_AMOUNT.true);
            if (u.uShadowMap && frame.shadow) {
                gl.activeTexture(gl.TEXTURE4);
                gl.bindTexture(gl.TEXTURE_2D, frame.shadow.tex);
                gl.uniform1i(u.uShadowMap, 4);
                gl.uniformMatrix4fv(u.uInvViewProj, false, frame.shadow.inverseViewProjection);
                gl.uniformMatrix4fv(u.uLightViewProj, false, frame.shadow.lightViewProjection);
                gl.uniform1f(u.uShadowTexel, 1 / frame.shadow.size);
                gl.uniform1f(u.uShadowWorldTexel, frame.shadow.worldTexel);
                gl.uniform3fv(u.uLightDir, frame.shadow.lightDirection);
            }
            if (u.uAo) {
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, targets.ao.tex);
                gl.uniform1i(u.uAo, 2);
                gl.uniform2f(u.uAoTexel, 1 / targets.ao.width, 1 / targets.ao.height);
            }
            if (u.uBloom) {
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, targets.bloomA.tex);
                gl.uniform1i(u.uBloom, 3);
            }
            this.drawQuad(frame.quadVao);
            for (let unit = 4; unit >= 0; unit--) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, null);
            }
            gl.bindVertexArray(null);
            gl.enable(gl.DEPTH_TEST);
        }
    }

    Defence3PostProcess.compositeSource = compositeSource;
    Defence3PostProcess.AO_FS = AO_FS;
    Defence3PostProcess.BRIGHT_FS = BRIGHT_FS;
    Defence3PostProcess.BLUR_FS = BLUR_FS;
    Defence3PostProcess.FULLSCREEN_VS = FULLSCREEN_VS;
    window.Defence3PostProcess = Defence3PostProcess;
})();
