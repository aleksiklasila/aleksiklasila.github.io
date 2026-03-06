// lighting.js — WebGL GPU-accelerated raycasting + visibility dilation
// Pass 1: Ray trace visibility from player + light sources → FBO texture
// Pass 2: Dilate visibility (expand visible area into solid terrain by R pixels)
const Lighting = {
    canvas: null,
    gl: null,
    // Three programs: raycast, dilate, accumulate
    raycastProgram: null,
    dilateProgram: null,
    accumulateProgram: null,
    voxelTexture: null,
    quadBuffer: null,
    // FBO for passes
    fbo1: null,
    fboTexture1: null,
    fbo2: null,
    fboTexture2: null,

    lights: [],
    MAX_LIGHTS: 8,
    EXPAND_RADIUS: 3.0, // voxels of expansion (= pixels * voxelSize)

    // Sun state (set by game.js each frame)
    sunDirX: 0,
    sunDirY: 1,
    sunIntensity: 0.8,

    _chunkStartVx: 0,
    _chunkStartVy: 0,
    _chunkW: 0,
    _chunkH: 0,
    _margin: 80,
    _uniforms1: {},
    _uniforms2: {},
    _uniforms3: {},
    _fallback: false,

    init() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;

        this.gl = this.canvas.getContext('webgl', {
            alpha: true, premultipliedAlpha: false, antialias: false
        });

        if (!this.gl) {
            console.warn('WebGL not available');
            this._fallback = true;
            return;
        }

        this._fallback = false;
        this._compilePrograms();
        this._setupGeometry();
        this._createTextures();
        this._createFBO();

        window.addEventListener('resize', () => {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
            this._createFBO(); // recreate FBO at new size
        });
    },

    // ========== SHADERS ==========

    _vertSrc: `
        attribute vec2 a_position;
        void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
    `,

    // --- 3-Pass Architecture ---
    // Pass 1: Player visibility (Raycast player -> pixel). Outputs 1.0 (visible) or 0.0 (invisible).
    // Pass 2: Dilate visibility. Reads Pass 1. Expands 1.0 values outwards.
    // Pass 3: Light Accumulation. Reads Pass 2. If Pass 2 > 0, trace light sources -> pixel.

    _fragPass1: `
        precision mediump float;
        uniform sampler2D u_voxels;
        uniform vec2 u_chunkSize, u_chunkStartVx, u_screenSize;
        uniform float u_voxelSize, u_baseY, u_topY, u_cameraX;
        uniform vec2 u_playerScreenPos;
        uniform float u_playerVisionRadius;

        bool isSolid(vec2 vc) {
            vec2 local = floor(vc) - u_chunkStartVx;
            if (local.y < 0.0) return false;
            if (local.y >= u_chunkSize.y) return true;
            if (local.x < 0.0 || local.x >= u_chunkSize.x) return false;
            return texture2D(u_voxels, (local + 0.5) / u_chunkSize).r > 0.5;
        }

        vec2 s2v(vec2 sp) {
            return vec2(
                (sp.x + u_cameraX - u_screenSize.x * 0.5) / u_voxelSize,
                (u_topY - (u_baseY - sp.y)) / u_voxelSize
            );
        }

        bool traceRay(vec2 sv, vec2 ev) {
            vec2 dir = ev - sv;
            float dist = length(dir);
            if (dist < 1.0) return false;
            dir /= dist;
            vec2 sd = sign(dir);
            vec2 td = abs(vec2(1.0) / max(abs(dir), vec2(0.0001)));
            vec2 cur = floor(sv);
            vec2 ec = floor(ev);
            vec2 tm;
            tm.x = (sd.x > 0.0 ? cur.x + 1.0 - sv.x : sv.x - cur.x) * td.x;
            tm.y = (sd.y > 0.0 ? cur.y + 1.0 - sv.y : sv.y - cur.y) * td.y;
            for (int i = 0; i < 400; i++) {
                if (cur.x == ec.x && cur.y == ec.y) break;
                if (isSolid(cur)) return true;
                if (tm.x < tm.y) { cur.x += sd.x; tm.x += td.x; }
                else { cur.y += sd.y; tm.y += td.y; }
            }
            return false;
        }

        void main() {
            vec2 sp = gl_FragCoord.xy;
            sp.y = u_screenSize.y - sp.y;
            vec2 tv = s2v(sp);

            vec2 pv = s2v(u_playerScreenPos);
            float pd = length(sp - u_playerScreenPos);
            bool playerCanSee = pd < u_playerVisionRadius && !traceRay(pv, tv);

            if (playerCanSee) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            } else {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            }
        }
    `,

    // Pass 2: Dilate visibility
    _fragPass2: `
        precision mediump float;
        uniform sampler2D u_pass1;
        uniform vec2 u_screenSize;
        uniform float u_expandPixels;

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            float dist = u_expandPixels / u_screenSize.x;
            
            vec4 c = texture2D(u_pass1, uv);
            if (c.r > 0.5) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                return;
            }

            float v = 0.0;
            // Simple 5-sample cross for expansion (could use a loop for better radius)
            v = max(v, texture2D(u_pass1, uv + vec2(dist, 0.0)).r);
            v = max(v, texture2D(u_pass1, uv + vec2(-dist, 0.0)).r);
            v = max(v, texture2D(u_pass1, uv + vec2(0.0, dist * (u_screenSize.x/u_screenSize.y))).r);
            v = max(v, texture2D(u_pass1, uv + vec2(0.0, -dist * (u_screenSize.x/u_screenSize.y))).r);

            if (v > 0.5) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            } else {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            }
        }
    `,

    // Pass 3: Light Accumulation
    _fragPass3: `
        precision mediump float;
        uniform sampler2D u_pass2;
        uniform sampler2D u_voxels;
        uniform vec2 u_chunkSize, u_chunkStartVx, u_screenSize;
        uniform float u_voxelSize, u_baseY, u_topY, u_cameraX;
        
        #define MAX_LIGHTS 8
        uniform vec2 u_lightScreenPos[MAX_LIGHTS];
        uniform vec3 u_lightColor[MAX_LIGHTS];
        uniform float u_lightRadius[MAX_LIGHTS];
        uniform float u_lightIntensity[MAX_LIGHTS];
        uniform int u_numLights;
        
        uniform vec2 u_sunDir;
        uniform float u_sunIntensity;
        
        const float SHADOW_BRIGHTNESS = 0.05;

        bool isSolid(vec2 vc) {
            vec2 local = floor(vc) - u_chunkStartVx;
            if (local.y < 0.0) return false;
            if (local.y >= u_chunkSize.y) return true;
            if (local.x < 0.0 || local.x >= u_chunkSize.x) return false;
            return texture2D(u_voxels, (local + 0.5) / u_chunkSize).r > 0.5;
        }

        vec2 s2v(vec2 sp) {
            return vec2(
                (sp.x + u_cameraX - u_screenSize.x * 0.5) / u_voxelSize,
                (u_topY - (u_baseY - sp.y)) / u_voxelSize
            );
        }

        bool traceRay(vec2 sv, vec2 ev) {
            vec2 dir = ev - sv;
            float dist = length(dir);
            if (dist < 1.0) return false;
            dir /= dist;
            vec2 sd = sign(dir);
            vec2 td = abs(vec2(1.0) / max(abs(dir), vec2(0.0001)));
            vec2 cur = floor(sv);
            vec2 ec = floor(ev);
            vec2 tm;
            tm.x = (sd.x > 0.0 ? cur.x + 1.0 - sv.x : sv.x - cur.x) * td.x;
            tm.y = (sd.y > 0.0 ? cur.y + 1.0 - sv.y : sv.y - cur.y) * td.y;
            for (int i = 0; i < 400; i++) {
                if (cur.x == ec.x && cur.y == ec.y) break;
                if (isSolid(cur)) return true;
                if (tm.x < tm.y) { cur.x += sd.x; tm.x += td.x; }
                else { cur.y += sd.y; tm.y += td.y; }
            }
            return false;
        }

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            vec4 vis = texture2D(u_pass2, uv);
            
            // If pixel is entirely outside expanded visibility, it's black.
            if (vis.r < 0.5) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            vec2 sp = gl_FragCoord.xy;
            sp.y = u_screenSize.y - sp.y;
            vec2 tv = s2v(sp);

            vec3 light = vec3(0.0);

            // Sun
            if (u_sunIntensity > 0.01) {
                vec2 sunEnd = tv + u_sunDir * 200.0;
                if (!traceRay(tv, sunEnd)) {
                    light += vec3(1.0, 0.98, 0.92) * u_sunIntensity;
                }
            }

            // Other lights
            for (int i = 0; i < MAX_LIGHTS; i++) {
                if (i >= u_numLights) break;
                float d = length(sp - u_lightScreenPos[i]);
                float r = u_lightRadius[i];
                if (d > r) continue;
                vec2 lv = s2v(u_lightScreenPos[i]);
                // Trace from light to pixel
                if (!traceRay(lv, tv)) {
                    float a = 1.0 - d / r; a *= a;
                    // Lights are very bright near center
                    light += u_lightColor[i] * u_lightIntensity[i] * a * a * 2.5; 
                }
            }

            float lum = max(light.r, max(light.g, light.b));
            if (lum < 0.01) {
                // Expanded visibility but unlit -> shadow
                gl_FragColor = vec4(SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, 1.0);
            } else {
                light = clamp(light, 0.0, 1.0);
                light = max(light, vec3(SHADOW_BRIGHTNESS));
                // To keep the edge slightly dimmer, we could multiply by vis.r if it had a gradient,
                // but for now it's binary, so just return light with full alpha.
                gl_FragColor = vec4(light, 1.0);
            }
        }
    `,

    // Pass 2: Dilate visibility
    _fragPass2: `
        precision mediump float;
        uniform sampler2D u_pass1;
        uniform vec2 u_screenSize;
        uniform float u_expandPixels;

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            float dist = u_expandPixels / u_screenSize.x;
            
            vec4 c = texture2D(u_pass1, uv);
            if (c.r > 0.5) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                return;
            }

            float v = 0.0;
            // Simple 5-sample cross for expansion (could use a loop for better radius)
            v = max(v, texture2D(u_pass1, uv + vec2(dist, 0.0)).r);
            v = max(v, texture2D(u_pass1, uv + vec2(-dist, 0.0)).r);
            v = max(v, texture2D(u_pass1, uv + vec2(0.0, dist * (u_screenSize.x/u_screenSize.y))).r);
            v = max(v, texture2D(u_pass1, uv + vec2(0.0, -dist * (u_screenSize.x/u_screenSize.y))).r);

            if (v > 0.5) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            } else {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            }
        }
    `,

    // Pass 3: Light Accumulation
    _fragPass3: `
        precision mediump float;
        uniform sampler2D u_pass2;
        uniform sampler2D u_voxels;
        uniform vec2 u_chunkSize, u_chunkStartVx, u_screenSize;
        uniform float u_voxelSize, u_baseY, u_topY, u_cameraX;
        
        #define MAX_LIGHTS 8
        uniform vec2 u_lightScreenPos[MAX_LIGHTS];
        uniform vec3 u_lightColor[MAX_LIGHTS];
        uniform float u_lightRadius[MAX_LIGHTS];
        uniform float u_lightIntensity[MAX_LIGHTS];
        uniform int u_numLights;
        
        uniform vec2 u_sunDir;
        uniform float u_sunIntensity;
        
        const float SHADOW_BRIGHTNESS = 0.04;

        bool isSolid(vec2 vc) {
            vec2 local = floor(vc) - u_chunkStartVx;
            if (local.y < 0.0) return false;
            if (local.y >= u_chunkSize.y) return true;
            if (local.x < 0.0 || local.x >= u_chunkSize.x) return false;
            return texture2D(u_voxels, (local + 0.5) / u_chunkSize).r > 0.5;
        }

        vec2 s2v(vec2 sp) {
            return vec2(
                (sp.x + u_cameraX - u_screenSize.x * 0.5) / u_voxelSize,
                (u_topY - (u_baseY - sp.y)) / u_voxelSize
            );
        }

        bool traceRay(vec2 sv, vec2 ev) {
            vec2 dir = ev - sv;
            float dist = length(dir);
            if (dist < 1.0) return false;
            dir /= dist;
            vec2 sd = sign(dir);
            vec2 td = abs(vec2(1.0) / max(abs(dir), vec2(0.0001)));
            vec2 cur = floor(sv);
            vec2 ec = floor(ev);
            vec2 tm;
            tm.x = (sd.x > 0.0 ? cur.x + 1.0 - sv.x : sv.x - cur.x) * td.x;
            tm.y = (sd.y > 0.0 ? cur.y + 1.0 - sv.y : sv.y - cur.y) * td.y;
            for (int i = 0; i < 400; i++) {
                if (cur.x == ec.x && cur.y == ec.y) break;
                if (isSolid(cur)) return true;
                if (tm.x < tm.y) { cur.x += sd.x; tm.x += td.x; }
                else { cur.y += sd.y; tm.y += td.y; }
            }
            return false;
        }

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            vec4 vis = texture2D(u_pass2, uv);
            
            // If pixel is entirely outside expanded visibility, it's black.
            if (vis.r < 0.5) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            vec2 sp = gl_FragCoord.xy;
            sp.y = u_screenSize.y - sp.y;
            vec2 tv = s2v(sp);

            vec3 light = vec3(0.0);

            // Sun
            if (u_sunIntensity > 0.01) {
                vec2 sunEnd = tv + u_sunDir * 200.0;
                if (!traceRay(tv, sunEnd)) {
                    light += vec3(1.0, 0.98, 0.92) * u_sunIntensity;
                }
            }

            // Other lights (index 0 is player, index 1+ are items)
            for (int i = 0; i < MAX_LIGHTS; i++) {
                if (i >= u_numLights) break;
                float d = length(sp - u_lightScreenPos[i]);
                float r = u_lightRadius[i];
                if (d > r) continue;
                vec2 lv = s2v(u_lightScreenPos[i]);
                // Trace from light to pixel
                if (!traceRay(lv, tv)) {
                    float a = 1.0 - d / r; a *= a;
                    // Lights are very bright near center
                    light += u_lightColor[i] * u_lightIntensity[i] * a * a * 2.5; 
                }
            }

            float lum = max(light.r, max(light.g, light.b));
            if (lum < 0.01) {
                // Expanded visibility but unlit -> shadow
                gl_FragColor = vec4(SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, 1.0);
            } else {
                light = clamp(light, 0.0, 1.0);
                light = max(light, vec3(SHADOW_BRIGHTNESS));
                // Multiply shadow back in edges
                gl_FragColor = vec4(light, 1.0);
            }
        }
    `,

    // ========== SETUP ==========

    _compilePrograms() {
        const gl = this.gl;

        // Pass 1 program (Raycast)
        this.raycastProgram = this._linkProgram(this._vertSrc, this._fragPass1);
        gl.useProgram(this.raycastProgram);
        const names1 = [
            'u_voxels', 'u_chunkSize', 'u_chunkStartVx', 'u_screenSize',
            'u_voxelSize', 'u_baseY', 'u_topY', 'u_cameraX',
            'u_playerScreenPos', 'u_playerVisionRadius'
        ];
        for (const n of names1) this._uniforms1[n] = gl.getUniformLocation(this.raycastProgram, n);

        // Pass 2 program (Dilate)
        this.dilateProgram = this._linkProgram(this._vertSrc, this._fragPass2);
        gl.useProgram(this.dilateProgram);
        this._uniforms2['u_pass1'] = gl.getUniformLocation(this.dilateProgram, 'u_pass1');
        this._uniforms2['u_screenSize'] = gl.getUniformLocation(this.dilateProgram, 'u_screenSize');
        this._uniforms2['u_expandPixels'] = gl.getUniformLocation(this.dilateProgram, 'u_expandPixels');

        // Pass 3 program (Accumulate)
        this.accumulateProgram = this._linkProgram(this._vertSrc, this._fragPass3);
        gl.useProgram(this.accumulateProgram);
        const names3 = [
            'u_pass2', 'u_voxels', 'u_chunkSize', 'u_chunkStartVx', 'u_screenSize',
            'u_voxelSize', 'u_baseY', 'u_topY', 'u_cameraX',
            'u_numLights', 'u_sunDir', 'u_sunIntensity'
        ];
        for (const n of names3) this._uniforms3[n] = gl.getUniformLocation(this.accumulateProgram, n);
        for (let i = 0; i < this.MAX_LIGHTS; i++) {
            this._uniforms3[`lp${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightScreenPos[${i}]`);
            this._uniforms3[`lc${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightColor[${i}]`);
            this._uniforms3[`lr${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightRadius[${i}]`);
            this._uniforms3[`li${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightIntensity[${i}]`);
        }
    },

    _linkProgram(vSrc, fSrc) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vSrc); gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fSrc); gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
            console.error('Shader error:', gl.getShaderInfoLog(fs));
        const prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            console.error('Link error:', gl.getProgramInfoLog(prog));
        return prog;
    },

    _setupGeometry() {
        const gl = this.gl;
        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);
    },

    _bindQuad(program) {
        const gl = this.gl;
        const pos = gl.getAttribLocation(program, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    },

    _createTextures() {
        const gl = this.gl;
        this.voxelTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.voxelTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },

    _createFBO() {
        const gl = this.gl;
        const w = this.canvas.width, h = this.canvas.height;
        if (w === 0 || h === 0) return;

        if (this.fbo1) { gl.deleteFramebuffer(this.fbo1); gl.deleteTexture(this.fboTexture1); }
        if (this.fbo2) { gl.deleteFramebuffer(this.fbo2); gl.deleteTexture(this.fboTexture2); }

        this.fboTexture1 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.fbo1 = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo1);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture1, 0);

        this.fboTexture2 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture2);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.fbo2 = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo2);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture2, 0);

        // WebGL canvas backbuffer acts as Pass 3
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    // ========== RUNTIME ==========

    clearLights() { this.lights = []; },

    setSunDir(dx, dy, intensity) {
        this.sunDirX = dx;
        this.sunDirY = dy;
        this.sunIntensity = intensity;
    },

    addLight(screenX, screenY, radius, r, g, b, intensity) {
        if (this.lights.length >= this.MAX_LIGHTS) return;
        this.lights.push({ screenX, screenY, radius, r, g, b, intensity });
    },

    render(camera, canvasW, canvasH) {
        if (this._fallback) return;
        const gl = this.gl;
        if (!gl) return;

        if (this.canvas.width !== canvasW || this.canvas.height !== canvasH) {
            this.canvas.width = canvasW;
            this.canvas.height = canvasH;
            this._createFBO();
        }

        const alignedCamX = Math.round(camera.x / Voxels.SIZE) * Voxels.SIZE;
        this._uploadVoxelChunk(camera, canvasW, canvasH, alignedCamX);
        const baseY = canvasH * 0.6;

        // ---- Pass 1: Player Raycast to FBO1 ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo1);
        gl.viewport(0, 0, canvasW, canvasH);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.raycastProgram);
        this._bindQuad(this.raycastProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.voxelTexture);
        gl.uniform1i(this._uniforms1['u_voxels'], 0);

        gl.uniform2f(this._uniforms1['u_chunkSize'], this._chunkW, this._chunkH);
        gl.uniform2f(this._uniforms1['u_chunkStartVx'], this._chunkStartVx, this._chunkStartVy);
        gl.uniform2f(this._uniforms1['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms1['u_voxelSize'], Voxels.SIZE);
        gl.uniform1f(this._uniforms1['u_baseY'], baseY);
        gl.uniform1f(this._uniforms1['u_topY'], Voxels.TOP_Y);
        gl.uniform1f(this._uniforms1['u_cameraX'], alignedCamX);

        // Player vision is always lights[0] in game.js
        if (this.lights.length > 0) {
            const pLight = this.lights[0];
            const ox = pLight.screenX + (camera.x - alignedCamX);
            gl.uniform2f(this._uniforms1['u_playerScreenPos'], ox, pLight.screenY);
            gl.uniform1f(this._uniforms1['u_playerVisionRadius'], pLight.radius);
        } else {
            gl.uniform2f(this._uniforms1['u_playerScreenPos'], canvasW / 2, canvasH / 2);
            gl.uniform1f(this._uniforms1['u_playerVisionRadius'], 600.0);
        }

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // ---- Pass 2: Dilate Player Visibility to FBO2 ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo2);
        gl.viewport(0, 0, canvasW, canvasH);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.dilateProgram);
        this._bindQuad(this.dilateProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture1);
        gl.uniform1i(this._uniforms2['u_pass1'], 0);
        gl.uniform2f(this._uniforms2['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms2['u_expandPixels'], this.EXPAND_RADIUS * Voxels.SIZE);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // ---- Pass 3: Accumulate Lights to Screen backbuffer ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvasW, canvasH);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.accumulateProgram);
        this._bindQuad(this.accumulateProgram);

        // Pass 2 Dilated Visibility on texture unit 1
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture2);
        gl.uniform1i(this._uniforms3['u_pass2'], 1);

        // Voxels still on texture unit 0
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.voxelTexture);
        gl.uniform1i(this._uniforms3['u_voxels'], 0);

        gl.uniform2f(this._uniforms3['u_chunkSize'], this._chunkW, this._chunkH);
        gl.uniform2f(this._uniforms3['u_chunkStartVx'], this._chunkStartVx, this._chunkStartVy);
        gl.uniform2f(this._uniforms3['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms3['u_voxelSize'], Voxels.SIZE);
        gl.uniform1f(this._uniforms3['u_baseY'], baseY);
        gl.uniform1f(this._uniforms3['u_topY'], Voxels.TOP_Y);
        gl.uniform1f(this._uniforms3['u_cameraX'], alignedCamX);

        // Sun uniforms
        gl.uniform2f(this._uniforms3['u_sunDir'], this.sunDirX, this.sunDirY);
        gl.uniform1f(this._uniforms3['u_sunIntensity'], this.sunIntensity);

        // Lights
        const passedLights = Math.min(this.MAX_LIGHTS, this.lights.length);
        gl.uniform1i(this._uniforms3['u_numLights'], passedLights);

        for (let i = 0; i < passedLights; i++) {
            const l = this.lights[i];
            const ox = l.screenX + (camera.x - alignedCamX);
            gl.uniform2f(this._uniforms3[`lp${i}`], ox, l.screenY);
            gl.uniform3f(this._uniforms3[`lc${i}`], l.r, l.g, l.b);
            gl.uniform1f(this._uniforms3[`lr${i}`], l.radius);
            gl.uniform1f(this._uniforms3[`li${i}`], l.intensity);
        }

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    _uploadVoxelChunk(camera, canvasW, canvasH, alignedCamX) {
        const gl = this.gl;
        const baseY = canvasH * 0.6;
        const m = this._margin;
        const camOffX = alignedCamX - canvasW / 2;
        const startVx = Math.max(0, Math.floor(camOffX / Voxels.SIZE) - m);
        const endVx = Math.min(Voxels.GRID_W, Math.ceil((camOffX + canvasW) / Voxels.SIZE) + m);
        const topWorldY = baseY;
        const botWorldY = baseY - canvasH;
        const startVy = Math.max(0, Math.floor((Voxels.TOP_Y - topWorldY) / Voxels.SIZE) - m);
        const endVy = Math.min(Voxels.GRID_H, Math.ceil((Voxels.TOP_Y - botWorldY) / Voxels.SIZE) + m);

        this._chunkStartVx = startVx;
        this._chunkStartVy = startVy;
        this._chunkW = endVx - startVx;
        this._chunkH = endVy - startVy;
        if (this._chunkW <= 0 || this._chunkH <= 0) return;

        const solidityData = Voxels.getSolidityChunk(startVx, startVy, this._chunkW, this._chunkH);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.voxelTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE,
            this._chunkW, this._chunkH, 0,
            gl.LUMINANCE, gl.UNSIGNED_BYTE, solidityData);
    },

    composite(gameCtx) {
        if (this._fallback) return;
        gameCtx.save();
        gameCtx.globalCompositeOperation = 'multiply';
        gameCtx.drawImage(this.canvas, 0, 0);
        gameCtx.restore();
    }
};
