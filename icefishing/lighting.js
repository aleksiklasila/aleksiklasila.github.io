// lighting.js — WebGL GPU-accelerated raycasting + visibility dilation
// Pass 1: Ray trace visibility from player + light sources → FBO texture
// Pass 2: Dilate visibility (expand visible area into solid terrain by R pixels)
const Lighting = {
    canvas: null,
    gl: null,
    // Two programs: raycast and dilate
    raycastProgram: null,
    dilateProgram: null,
    voxelTexture: null,
    quadBuffer: null,
    // FBO for pass 1 output
    fbo: null,
    fboTexture: null,

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

    // Pass 1: Raycast visibility → writes light value to FBO
    // Dual-condition: pixel must be (1) visible to player AND (2) lit by sun or any light
    // Shadow: player-visible but unlit → dim
    _fragPass1: `
        precision mediump float;
        uniform sampler2D u_voxels;
        uniform vec2 u_chunkSize, u_chunkStartVx, u_screenSize;
        uniform float u_voxelSize, u_baseY, u_topY, u_cameraX;
        #define MAX_LIGHTS 8
        uniform vec2 u_lightScreenPos[MAX_LIGHTS];
        uniform vec3 u_lightColor[MAX_LIGHTS];
        uniform float u_lightRadius[MAX_LIGHTS];
        uniform float u_lightIntensity[MAX_LIGHTS];
        uniform int u_numLights;
        // Sun: directional light
        uniform vec2 u_sunDir;
        uniform float u_sunIntensity;
        // Shadow brightness for player-visible but unlit pixels
        const float SHADOW_BRIGHTNESS = 0.04;

        bool isSolid(vec2 vc) {
            vec2 local = floor(vc) - u_chunkStartVx;
            if (local.y < 0.0) return false; // Sky is open air
            if (local.y >= u_chunkSize.y) return true; // Deep below world is solid
            if (local.x < 0.0 || local.x >= u_chunkSize.x) return false; // Sides are open (prevents edge shadows)
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

            // --- Step 1: Player visibility check (constant radius) ---
            vec2 pv = s2v(u_lightScreenPos[0]);
            float pd = length(sp - u_lightScreenPos[0]);
            bool playerCanSee = pd < u_lightRadius[0] && !traceRay(pv, tv);

            if (!playerCanSee) {
                // Fully invisible — black
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            // --- Step 2: Accumulate light from all sources ---
            vec3 light = vec3(0.0);

            // Sun: directional light — trace ray from pixel in sun direction
            if (u_sunIntensity > 0.01) {
                vec2 sunEnd = tv + u_sunDir * 200.0;
                if (!traceRay(tv, sunEnd)) {
                    light += vec3(1.0, 0.98, 0.92) * u_sunIntensity;
                }
            }

            // Other lights (campfires, torches, carried torch)
            for (int i = 1; i < MAX_LIGHTS; i++) {
                if (i >= u_numLights) break;
                float d = length(sp - u_lightScreenPos[i]);
                float r = u_lightRadius[i];
                if (d > r) continue;
                vec2 lv = s2v(u_lightScreenPos[i]);
                if (!traceRay(lv, tv)) {
                    float a = 1.0 - d / r; a *= a;
                    light += u_lightColor[i] * u_lightIntensity[i] * a;
                }
            }

            // --- Step 3: Shadow distinction ---
            float lum = max(light.r, max(light.g, light.b));
            if (lum < 0.01) {
                // Player can see but no light reaches → dim shadow
                gl_FragColor = vec4(SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, SHADOW_BRIGHTNESS, 1.0);
            } else {
                light = clamp(light, 0.0, 1.0);
                // Ensure shadow minimum even for very faint lights
                light = max(light, vec3(SHADOW_BRIGHTNESS));
                gl_FragColor = vec4(light, 1.0);
            }
        }
    `,

    // Pass 2: Dilate — read pass 1 texture, expand visible area
    _fragPass2: `
        precision mediump float;
        uniform sampler2D u_pass1;
        uniform vec2 u_screenSize;
        uniform float u_expandRadius; // in pixels

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            vec4 center = texture2D(u_pass1, uv);

            // If already visible (any light > 0.01), keep as-is
            if (center.r > 0.01 || center.g > 0.01 || center.b > 0.01) {
                gl_FragColor = center;
                return;
            }

            // This pixel is dark — check if any neighbor within radius is visible
            float R = u_expandRadius;
            float bestLight = 0.0;
            vec4 bestColor = vec4(0.0, 0.0, 0.0, 1.0);

            // Sample 12 points around: 4 cardinal + 4 diagonal + 4 at half radius
            for (int i = 0; i < 12; i++) {
                float angle;
                float dist;
                if (i < 32) {
                    angle = float(i) * 0.7854; // PI/4
                    dist = R;
                } else {
                    angle = float(i - 8) * 1.5708 + 0.3927; // PI/2, offset
                    dist = R * 0.5;
                }
                vec2 offset = vec2(cos(angle), sin(angle)) * dist / u_screenSize;
                vec4 sample1 = texture2D(u_pass1, uv + offset);
                float lum = max(sample1.r, max(sample1.g, sample1.b));
                if (lum > bestLight) {
                    bestLight = lum;
                    bestColor = sample1;
                }
            }

            if (bestLight > 0.01) {
                // Neighbor is visible — show this pixel with reduced brightness
                // Ensure alpha is 1.0 so background doesn't bleed through
                gl_FragColor = vec4(bestColor.rgb * 0.6, 1.0);
            } else {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            }
        }
    `,

    // ========== SETUP ==========

    _compilePrograms() {
        const gl = this.gl;

        // Pass 1 program
        this.raycastProgram = this._linkProgram(this._vertSrc, this._fragPass1);
        gl.useProgram(this.raycastProgram);
        const names1 = [
            'u_voxels', 'u_chunkSize', 'u_chunkStartVx', 'u_screenSize',
            'u_voxelSize', 'u_baseY', 'u_topY', 'u_cameraX',
            'u_numLights', 'u_sunDir', 'u_sunIntensity'
        ];
        for (const n of names1) this._uniforms1[n] = gl.getUniformLocation(this.raycastProgram, n);
        for (let i = 0; i < this.MAX_LIGHTS; i++) {
            this._uniforms1[`lp${i}`] = gl.getUniformLocation(this.raycastProgram, `u_lightScreenPos[${i}]`);
            this._uniforms1[`lc${i}`] = gl.getUniformLocation(this.raycastProgram, `u_lightColor[${i}]`);
            this._uniforms1[`lr${i}`] = gl.getUniformLocation(this.raycastProgram, `u_lightRadius[${i}]`);
            this._uniforms1[`li${i}`] = gl.getUniformLocation(this.raycastProgram, `u_lightIntensity[${i}]`);
        }

        // Pass 2 program
        this.dilateProgram = this._linkProgram(this._vertSrc, this._fragPass2);
        gl.useProgram(this.dilateProgram);
        this._uniforms2['u_pass1'] = gl.getUniformLocation(this.dilateProgram, 'u_pass1');
        this._uniforms2['u_screenSize'] = gl.getUniformLocation(this.dilateProgram, 'u_screenSize');
        this._uniforms2['u_expandRadius'] = gl.getUniformLocation(this.dilateProgram, 'u_expandRadius');
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

        // Clean up old
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        if (this.fboTexture) gl.deleteTexture(this.fboTexture);

        this.fboTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);
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

        // ---- Pass 1: Raycast to FBO ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, canvasW, canvasH);
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

        // Sun uniforms (direction)
        gl.uniform2f(this._uniforms1['u_sunDir'], this.sunDirX, this.sunDirY);
        gl.uniform1f(this._uniforms1['u_sunIntensity'], this.sunIntensity);

        gl.uniform1i(this._uniforms1['u_numLights'], this.lights.length);
        for (let i = 0; i < this.MAX_LIGHTS; i++) {
            if (i < this.lights.length) {
                const l = this.lights[i];
                const ox = l.screenX + (camera.x - alignedCamX);
                gl.uniform2f(this._uniforms1[`lp${i}`], ox, l.screenY);
                gl.uniform3f(this._uniforms1[`lc${i}`], l.r, l.g, l.b);
                gl.uniform1f(this._uniforms1[`lr${i}`], l.radius);
                gl.uniform1f(this._uniforms1[`li${i}`], l.intensity);
            }
        }

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // ---- Pass 2: Dilate to screen ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvasW, canvasH);
        gl.useProgram(this.dilateProgram);
        this._bindQuad(this.dilateProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
        gl.uniform1i(this._uniforms2['u_pass1'], 0);
        gl.uniform2f(this._uniforms2['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms2['u_expandRadius'], this.EXPAND_RADIUS * Voxels.SIZE);

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
