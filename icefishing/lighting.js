// lighting.js — WebGL GPU-accelerated raycasting + visibility dilation
// Pass 1: Ray trace visibility from player + light sources → FBO texture
// Pass 2: Dilate visibility (expand visible area into solid terrain by R pixels)
const Lighting = {
    canvas: null,
    gl: null,
    // Four programs: raycast, dilate, accumulate, smooth
    raycastProgram: null,
    dilateProgram: null,
    accumulateProgram: null,
    smoothProgram: null,
    voxelTexture: null,
    quadBuffer: null,
    // FBO for passes
    fbo1: null,
    fboTexture1: null,
    fbo2: null,
    fboTexture2: null,
    fbo3: null,
    fboTexture3: null,

    lights: [],
    MAX_LIGHTS: 8,
    EXPAND_RADIUS: 3.0, // voxels of expansion (= pixels * voxelSize)

    // Sun state (set by game.js each frame)
    sunDirX: 0,
    sunDirY: 1,
    sunIntensity: 0.8,
    sunColorR: 1.0,
    sunColorG: 0.98,
    sunColorB: 0.92,

    _chunkStartVx: 0,
    _chunkStartVy: 0,
    _chunkW: 0,
    _chunkH: 0,
    _margin: 80,
    _uniforms1: {},
    _uniforms2: {},
    _uniforms3: {},
    _uniforms4: {},
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
        
        uniform int u_renderMode; // 0 = normal, 1 = full bright

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
                if (u_renderMode == 1) {
                    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); // full bright
                } else {
                    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                }
            }
        }

    `,

    // Pass 2: Dilate visibility
    // Pass 2: Dilate visibility (proper radius-based)
    _fragPass2: `
        precision mediump float;
        uniform sampler2D u_pass1;
        uniform vec2 u_screenSize;
        uniform float u_expandPixels;

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            
            vec4 c = texture2D(u_pass1, uv);
            if (c.r > 0.5) {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                return;
            }

            // Radius in pixels
            float radius = u_expandPixels;
            vec2 texelSize = 1.0 / u_screenSize;
            
            // Loop bounding box
            int r = int(radius);
            for (int y = -30; y <= 30; y++) {
                if (y < -r || y > r) continue;
                for (int x = -30; x <= 30; x++) {
                    if (x < -r || x > r) continue;
                    
                    // Circular check
                    if (length(vec2(float(x), float(y))) <= radius) {
                        vec2 offsetUV = uv + vec2(float(x), float(y)) * texelSize;
                        if (texture2D(u_pass1, offsetUV).r > 0.5) {
                            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                            return;
                        }
                    }
                }
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
        uniform vec3 u_sunColor;
        
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

        // Traces ray from light source to target pixel and returns remaining light intensity
        float traceRayLossy(vec2 targetPixel, vec2 lightPos, float baseIntensity) {
            vec2 dir = targetPixel - lightPos;
            float dist = length(dir);
            if (dist < 1.0) return baseIntensity;
            
            float stepSize = 0.25; // Smaller step size to reduce jagged shadows
            vec2 step = (dir / dist) * stepSize;
            int numSteps = int(dist / stepSize);
            
            vec2 cur = lightPos;
            float intensity = baseIntensity;
            float lossPerSolid = 1.2 * stepSize; // Continuous falloff inside solid blocks
            
            float is_ignore_original = 4.0;
            float is_ignore = is_ignore_original;
            
            for (int i = 0; i < 800; i++) {
                if (i >= numSteps) break;
                
                if (isSolid(cur)) {
                    if (is_ignore <= 0.0) {
                        intensity -= lossPerSolid;
                    }
                    if (intensity <= 0.0) return 0.0;
                    is_ignore -= stepSize;
                } else {
                    if (is_ignore <= is_ignore_original - 1.0) {
                        intensity -= lossPerSolid; 
                        is_ignore_original = is_ignore;
                        if (intensity <= 0.0) return 0.0;
                    } else {
                        is_ignore = is_ignore_original;
                    }
                }
                
                cur += step;
            }
            
            return intensity;
        }
        
        uniform int u_renderMode; // 0 = normal, 1 = full bright

        void main() {
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            vec4 vis = texture2D(u_pass2, uv);
            
            // If pixel is entirely outside expanded visibility, it's black.
            if (vis.r < 0.5 && u_renderMode == 0) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            vec2 sp = gl_FragCoord.xy;
            sp.y = u_screenSize.y - sp.y;
            vec2 tv = s2v(sp);

            vec3 light;
            if (u_renderMode == 1) {
                light = vec3(1.0, 1.0, 1.0); // full bright
            } else {
                light = vec3(SHADOW_BRIGHTNESS);
            }

            // Sun
            if (u_sunIntensity > 0.01) {
                vec2 sunEnd = tv + u_sunDir * 200.0; 
                
                // sunHeight: how high the sun is. u_sunDir.y < 0 means above horizon.
                // -1.0 = directly overhead, 0.0 = at horizon, >0 = below horizon
                float sunHeight = -u_sunDir.y; // positive = above horizon
                
                // Scale sun brightness based on height:
                // Above horizon (sunHeight > 0): stays near max most of the day
                // Near horizon (sunHeight ~0): dims gradually
                // Below horizon (sunHeight < 0): fades to 0 (dark)
                float heightFactor = clamp(sunHeight * 4.0 + 0.5, 0.0, 1.0);
                
                float sunBase = u_sunIntensity * 1.35 * heightFactor;
                float trans = traceRayLossy(tv, sunEnd, sunBase);
                
                if (trans > 0.0) {
                    light += u_sunColor * (trans / 1.35); 
                }
            }

            // Other lights (index 0 is player, index 1+ are items)
            for (int i = 0; i < MAX_LIGHTS; i++) {
                if (i >= u_numLights) break;
                float d = length(sp - u_lightScreenPos[i]);
                float r = u_lightRadius[i];
                if (d > r) continue;
                
                vec2 lv = s2v(u_lightScreenPos[i]);
                
                // Distance attenuation (quadratic falloff)
                float atten = 1.0 - (d / r);
                atten *= atten;
                
                float baseStrength = u_lightIntensity[i] * 1.0;

                // Trace from target pixel TO the light
                float trans = traceRayLossy(tv, lv, baseStrength);
                
                if (trans > 0.0) {
                    light += u_lightColor[i] * (trans / baseStrength) * u_lightIntensity[i] * atten * 2.5; 
                }
            }

            gl_FragColor = vec4(light, 1.0);
        }
    `,

    // Pass 4: Box-blur smoothing
    _fragPass4: `
        precision mediump float;
        uniform sampler2D u_pass3;
        uniform vec2 u_screenSize;
        uniform float u_blurRadius;

        void main() {
            vec2 texelSize = 1.0 / u_screenSize;
            vec2 uv = gl_FragCoord.xy / u_screenSize;
            int r = int(u_blurRadius);
            vec3 sum = vec3(0.0);
            float count = 0.0;
            for (int y = -7; y <= 7; y++) {
                if (y < -r || y > r) continue;
                for (int x = -7; x <= 7; x++) {
                    if (x < -r || x > r) continue;
                    vec2 offset = vec2(float(x), float(y)) * texelSize;
                    sum += texture2D(u_pass3, uv + offset).rgb;
                    count += 1.0;
                }
            }
            gl_FragColor = vec4(sum / count, 1.0);
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
            'u_playerScreenPos', 'u_playerVisionRadius', 'u_renderMode'
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
            'u_numLights', 'u_sunDir', 'u_sunIntensity', 'u_sunColor', 'u_renderMode'
        ];
        for (const n of names3) this._uniforms3[n] = gl.getUniformLocation(this.accumulateProgram, n);
        for (let i = 0; i < this.MAX_LIGHTS; i++) {
            this._uniforms3[`lp${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightScreenPos[${i}]`);
            this._uniforms3[`lc${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightColor[${i}]`);
            this._uniforms3[`lr${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightRadius[${i}]`);
            this._uniforms3[`li${i}`] = gl.getUniformLocation(this.accumulateProgram, `u_lightIntensity[${i}]`);
        }

        // Pass 4 program (Smooth)
        this.smoothProgram = this._linkProgram(this._vertSrc, this._fragPass4);
        gl.useProgram(this.smoothProgram);
        this._uniforms4['u_pass3'] = gl.getUniformLocation(this.smoothProgram, 'u_pass3');
        this._uniforms4['u_screenSize'] = gl.getUniformLocation(this.smoothProgram, 'u_screenSize');
        this._uniforms4['u_blurRadius'] = gl.getUniformLocation(this.smoothProgram, 'u_blurRadius');
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
        if (this.fbo3) { gl.deleteFramebuffer(this.fbo3); gl.deleteTexture(this.fboTexture3); }

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

        this.fboTexture3 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture3);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.fbo3 = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo3);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture3, 0);

        // WebGL canvas backbuffer acts as Pass 4
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    // ========== RUNTIME ==========

    clearLights() { this.lights = []; },

    setSunDir(dx, dy, intensity, r = 1.0, g = 0.98, b = 0.92) {
        this.sunDirX = dx;
        this.sunDirY = dy;
        this.sunIntensity = intensity;
        this.sunColorR = r;
        this.sunColorG = g;
        this.sunColorB = b;
    },

    setPlayerVision(screenX, screenY, radius) {
        this.playerVisionX = screenX;
        this.playerVisionY = screenY;
        this.playerVisionRadius = radius;
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
        gl.uniform2f(this._uniforms1['u_chunkStartVx'], 0, this._chunkStartVy);
        gl.uniform2f(this._uniforms1['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms1['u_voxelSize'], Voxels.SIZE);
        gl.uniform1f(this._uniforms1['u_baseY'], baseY + camera.y);
        gl.uniform1f(this._uniforms1['u_topY'], Voxels.TOP_Y);
        gl.uniform1f(this._uniforms1['u_cameraX'], alignedCamX - this._chunkStartVx * Voxels.SIZE);

        // Player vision is distinct from actual emitted lights now
        if (this.playerVisionRadius > 0) {
            const ox = this.playerVisionX + (camera.x - alignedCamX);
            gl.uniform2f(this._uniforms1['u_playerScreenPos'], ox, this.playerVisionY);
            gl.uniform1f(this._uniforms1['u_playerVisionRadius'], this.playerVisionRadius);
        } else {
            gl.uniform2f(this._uniforms1['u_playerScreenPos'], canvasW / 2, canvasH / 2);
            gl.uniform1f(this._uniforms1['u_playerVisionRadius'], 600.0);
        }

        gl.uniform1i(this._uniforms1['u_renderMode'], typeof Game !== 'undefined' ? Game.renderMode : 0);

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

        // ---- Pass 3: Accumulate Lights to FBO3 ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo3);
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
        gl.uniform2f(this._uniforms3['u_chunkStartVx'], 0, this._chunkStartVy);
        gl.uniform2f(this._uniforms3['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms3['u_voxelSize'], Voxels.SIZE);
        gl.uniform1f(this._uniforms3['u_baseY'], baseY + camera.y);
        gl.uniform1f(this._uniforms3['u_topY'], Voxels.TOP_Y);
        gl.uniform1f(this._uniforms3['u_cameraX'], alignedCamX - this._chunkStartVx * Voxels.SIZE);

        // Sun uniforms
        gl.uniform2f(this._uniforms3['u_sunDir'], this.sunDirX, this.sunDirY);
        gl.uniform1f(this._uniforms3['u_sunIntensity'], this.sunIntensity);
        gl.uniform3f(this._uniforms3['u_sunColor'], this.sunColorR, this.sunColorG, this.sunColorB);

        gl.uniform1i(this._uniforms3['u_renderMode'], typeof Game !== 'undefined' ? Game.renderMode : 0);

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

        // ---- Pass 4: Smooth (box blur) to Screen backbuffer ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvasW, canvasH);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.smoothProgram);
        this._bindQuad(this.smoothProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture3);
        gl.uniform1i(this._uniforms4['u_pass3'], 0);
        gl.uniform2f(this._uniforms4['u_screenSize'], canvasW, canvasH);
        gl.uniform1f(this._uniforms4['u_blurRadius'], 2.0); // 5x5 box blur (radius=2)

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    _uploadVoxelChunk(camera, canvasW, canvasH, alignedCamX) {
        const gl = this.gl;
        const baseY = canvasH * 0.6;
        const m = this._margin;
        const camOffX = alignedCamX - canvasW / 2;
        const camOffY = camera.y;
        const startVx = Math.max(0, Math.floor(camOffX / Voxels.SIZE) - m);
        const endVx = Math.min(Voxels.GRID_W, Math.ceil((camOffX + canvasW) / Voxels.SIZE) + m);
        const topWorldY = baseY + camOffY;
        const botWorldY = baseY + camOffY - canvasH;
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
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
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
