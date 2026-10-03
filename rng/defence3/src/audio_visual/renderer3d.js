(function () {
    function createShader(gl, type, source) {
        let shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            let message = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
            gl.deleteShader(shader);
            throw new Error(message);
        }
        return shader;
    }

    function createProgram(gl, vertexSource, fragmentSource) {
        let program = gl.createProgram();
        let vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
        let fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            let message = gl.getProgramInfoLog(program) || 'Unknown program link error';
            gl.deleteProgram(program);
            throw new Error(message);
        }
        return program;
    }

    function createTexture(gl) {
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    function decodePackedDepth(bytes, offset = 0) {
        if (!bytes || bytes.length < offset + 4) return NaN;
        let r = bytes[offset] / 255;
        let g = bytes[offset + 1] / 255;
        let b = bytes[offset + 2] / 255;
        let a = bytes[offset + 3] / 255;
        return r / (256 * 256 * 256) + g / (256 * 256) + b / 256 + a;
    }

    const sanitizedModelKeys = new Map();
    function sanitizeModelKey(key) {
        let source = String(key || 'cube');
        let cached = sanitizedModelKeys.get(source);
        if (cached) return cached;
        let normalized = source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cube';
        if (sanitizedModelKeys.size >= 256) sanitizedModelKeys.clear();
        sanitizedModelKeys.set(source, normalized);
        return normalized;
    }

    // Whether objects with a model key cast shadows (by unsanitized key).
    const shadowCasterByModelKey = new Map();

    const rgbColorCache = new Map();
    function hexToRgb(color) {
        let cached = rgbColorCache.get(color);
        if (cached) return cached;
        let normalized = String(color || '#c8ced8').trim();
        let match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return [0.78, 0.81, 0.85];
        let hex = match[1];
        if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
        let rgb = [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255
        ];
        if (rgbColorCache.size >= 2048) rgbColorCache.clear();
        rgbColorCache.set(color, rgb);
        return rgb;
    }

    // Flat (2D view) sprite instances, FLAT_STRIDE floats each: center x/z,
    // width, height, r, g, b, alpha, angle and the texture layer. The frame
    // builder writes them directly; layers are resolved when drawn.
    const FLAT_STRIDE = 10;
    const FLAT_LAYER = 9;
    const FLAT_SINGLE = -1;      // textured, but not in the texture array
    const FLAT_UNTEXTURED = -2;
    const FLAT_ATLAS_SIZE = 96;  // RENDERER3D_TOP_TEXTURE_SIZE panels
    const FLAT_ATLAS_LEVELS = 7; // 96 48 24 12 6 3 1

    // Persistent instance storage. Compare/upload pages only when a published
    // presentation changes; camera and interpolation frames do no buffer work.
    class PersistentInstances {
        constructor(stride) {
            this.stride = stride;
            this.data = new Float32Array(0);
            this.uploaded = new Float32Array(0);
            this.count = 0;
            this.version = 0;
            this.gpuVersion = -1;
            this.uploadBytes = 0;
        }
        reserve(count) {
            if (count * this.stride <= this.data.length) return;
            const next = new Float32Array(Math.max(1024 * this.stride, count * this.stride, this.data.length * 2));
            next.set(this.data);
            this.data = next;
        }
        upload(gl) {
            this.uploadBytes = 0;
            if (this.gpuVersion === this.version) return this.buffer;
            if (!this.buffer) this.buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            let fresh = this.uploaded.length !== this.data.length;
            if (fresh) {
                gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
                this.uploaded = new Float32Array(this.data.length);
            }
            const size = this.count * this.stride, page = 256 * this.stride;
            let start = -1;
            const flush = end => {
                if (start < 0) return;
                gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, this.data, start, end - start);
                this.uploaded.set(this.data.subarray(start, end), start);
                this.uploadBytes += (end - start) * 4;
                start = -1;
            };
            for (let base = 0; base < size; base += page) {
                const end = Math.min(size, base + page);
                let dirty = fresh;
                for (let i = base; !dirty && i < end; i++) dirty = this.data[i] !== this.uploaded[i];
                if (dirty) { if (start < 0) start = base; }
                else flush(base);
            }
            flush(size);
            this.gpuVersion = this.version;
            return this.buffer;
        }
        dispose(gl) {
            if (this.buffer) gl.deleteBuffer(this.buffer);
            this.buffer = null; this.gpuVersion = -1;
            this.uploaded = new Float32Array(0);
        }
    }

    class FlatSpriteBatch {
        constructor(capacity = 1024) {
            this.data = new Float32Array(capacity * FLAT_STRIDE);
            this.textures = new Array(capacity).fill(null);
            this.count = 0;
        }

        reset() {
            this.count = 0;
        }

        push(x, z, width, height, r, g, b, alpha, angle, texture) {
            const i = this.count;
            if (i >= this.textures.length) {
                const data = new Float32Array(this.data.length * 2);
                data.set(this.data);
                this.data = data;
                this.textures.length = i * 2;
                this.textures.fill(null, i);
            }
            const d = this.data, o = i * FLAT_STRIDE;
            d[o] = x; d[o + 1] = z; d[o + 2] = width; d[o + 3] = height;
            d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = alpha;
            d[o + 8] = angle; d[o + 9] = 0;
            this.textures[i] = texture || null;
            this.count = i + 1;
        }

        // A 3D scene object: exact 2D panels carry their own footprint and
        // label offset, structures fill their tile, the rest use the model
        // scale and turn with it. Textures are lit; plain sprites use the
        // (already lit) tint.
        pushObject(o) {
            const source = o.topTextureCanvas || null;
            const exact = source && source._flatWorldSize;
            const key = o.modelKey || '';
            const tile = !key.startsWith('unit_') && !key.startsWith('projectile_')
                && !key.startsWith('particle') && !key.startsWith('dropped_');
            const size = exact || (tile ? 1 : 0);
            const light = o.historyGhost ? o.lightLevel * .65 : o.lightLevel;
            const color = source ? null : hexToRgb(o.tint);
            this.push(o.x, o.z + (exact ? source._flatOffsetZ || 0 : 0), size || o.scaleX, size || o.scaleZ,
                source ? light : color[0], source ? light : color[1], source ? light : color[2], o.alpha,
                exact || tile ? 0 : -(o.rotationY || 0), source);
        }
    }

    // An exact 2D panel (pooled 96px canvas) that the sprite atlas can hold.
    // Pooled panels keep their size: it is read (DOM calls) once per canvas;
    // the key test is kept on the object while its key is the same.
    function isAtlasPanel(object) {
        let canvas = object.topTextureCanvas;
        if (!canvas || !canvas._renderer3DExactKey) return false;
        let sized = canvas._atlasSized;
        if (sized === undefined) sized = canvas._atlasSized = canvas.width === FLAT_ATLAS_SIZE && canvas.height === FLAT_ATLAS_SIZE;
        if (!sized) return false;
        let key = object.topTextureKey;
        if (object._iAtlasKey !== key) { object._iAtlasKey = key; object._iAtlasOk = String(key || '').startsWith('2d:'); }
        return object._iAtlasOk;
    }

    let flatTextureSerial = 0;
    function flatTextureKey(source) {
        return source._renderer3DExactKey || source._flatTextureKey || (source._flatTextureKey = `flat:${++flatTextureSerial}`);
    }

    // Every 96px sprite in one texture array, so a frame's sprites share a
    // draw. A layer stays bound to its source until that source goes unused
    // for a few frames (clock eviction); the array doubles when the visible
    // set outgrows it. Uploads stay on the GPU: the source goes into a small
    // staging texture, is mipmapped there (generateMipmap on the array would
    // rebuild every layer) and each level is copied into the layer. Reading
    // canvas pixels back instead stalls on the GPU process.
    class FlatSpriteAtlas {
        constructor(gl) {
            this.gl = gl;
            const maxLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
            this.maxLayers = Math.max(64, Math.min(2048, Number.isFinite(maxLayers) ? maxLayers : 256));
            this.capacity = 0;
            this.texture = null;
            this.sources = [];
            this.versions = new Float64Array(0);
            this.lastUsed = new Int32Array(0);
            this.free = [];
            this.hand = 0;
            this.frame = 0;
            this.exhaustedFrame = -1;
            this.staging = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.staging);
            gl.texStorage2D(gl.TEXTURE_2D, FLAT_ATLAS_LEVELS, gl.RGBA8, FLAT_ATLAS_SIZE, FLAT_ATLAS_SIZE);
            this.copyFramebuffer = gl.createFramebuffer();
            this.savedReadFramebuffer = undefined;
            this.allocate(Math.min(256, this.maxLayers));
        }

        beginFrame(frame) {
            this.frame = frame;
        }

        // Uploads borrow the read framebuffer; give it back.
        endFrame() {
            if (this.savedReadFramebuffer === undefined) return;
            this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, this.savedReadFramebuffer);
            this.savedReadFramebuffer = undefined;
        }

        allocate(capacity) {
            const gl = this.gl, previous = this.sources, previousUsed = this.lastUsed;
            if (this.texture) gl.deleteTexture(this.texture);
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texStorage3D(gl.TEXTURE_2D_ARRAY, FLAT_ATLAS_LEVELS, gl.RGBA8, FLAT_ATLAS_SIZE, FLAT_ATLAS_SIZE, capacity);
            this.capacity = capacity;
            this.sources = new Array(capacity).fill(null);
            this.versions = new Float64Array(capacity).fill(NaN);
            this.lastUsed = new Int32Array(capacity).fill(-1e9);
            this.free = [];
            // Keep recently used layers at their index (this frame's batch
            // already refers to them); release the rest.
            for (let slot = capacity - 1; slot >= 0; slot--) {
                const source = slot < previous.length ? previous[slot] : null;
                if (source && previousUsed[slot] >= this.frame - 2 && this.upload(slot, source)) {
                    this.sources[slot] = source;
                    this.versions[slot] = Number(source._textureVersion) || 0;
                    this.lastUsed[slot] = previousUsed[slot];
                } else {
                    this.free.push(slot);
                }
            }
            this.hand = 0;
        }

        acquire() {
            if (this.free.length) return this.free.pop();
            if (this.exhaustedFrame === this.frame) return -1;
            for (let n = 0; n < this.capacity; n++) {
                const slot = this.hand;
                this.hand = (slot + 1) % this.capacity;
                if (this.lastUsed[slot] < this.frame - 2) return slot;
            }
            if (this.capacity < this.maxLayers) {
                this.allocate(Math.min(this.maxLayers, this.capacity * 2));
                if (this.free.length) return this.free.pop();
            }
            this.exhaustedFrame = this.frame;
            return -1;
        }

        layerFor(source) {
            let slot = source._flatAtlasSlot;
            // The common case: already in its layer and unchanged. (Reading
            // a canvas size is a DOM call; skipped here.)
            if (slot !== undefined && this.sources[slot] === source && this.versions[slot] === (Number(source._textureVersion) || 0)) {
                this.lastUsed[slot] = this.frame;
                return slot;
            }
            if (source.width !== FLAT_ATLAS_SIZE || source.height !== FLAT_ATLAS_SIZE) return FLAT_SINGLE;
            if (slot === undefined || this.sources[slot] !== source) {
                slot = this.acquire();
                if (slot < 0) return FLAT_SINGLE;
                const evicted = this.sources[slot];
                if (evicted && evicted._flatAtlasSlot === slot) evicted._flatAtlasSlot = undefined;
                this.sources[slot] = source;
                this.versions[slot] = NaN;
                source._flatAtlasSlot = slot;
            }
            const version = Number(source._textureVersion) || 0;
            if (this.versions[slot] !== version) {
                if (!this.upload(slot, source)) {
                    this.sources[slot] = null;
                    this.free.push(slot);
                    source._flatAtlasSlot = undefined;
                    return FLAT_SINGLE;
                }
                this.versions[slot] = version;
            }
            this.lastUsed[slot] = this.frame;
            return slot;
        }

        upload(slot, source) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, this.staging);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.generateMipmap(gl.TEXTURE_2D);
            if (this.savedReadFramebuffer === undefined) this.savedReadFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.copyFramebuffer);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
            for (let level = 0, size = FLAT_ATLAS_SIZE; level < FLAT_ATLAS_LEVELS; level++, size = Math.max(1, size >> 1)) {
                gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.staging, level);
                gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, slot, 0, 0, size, size);
            }
            return true;
        }
    }

    // ---- Combat and activity effects ------------------------------------
    // Short-lived shapes (shots, slashes, runes, debris, smoke) written by the
    // frame builder straight into one typed batch per mesh: FX_STRIDE floats
    // each, drawn with one instanced call per mesh and never sorted.
    //   x, y, z, yaw | sx, sy, sz, pitch | r, g, b, alpha | pattern, param, roll, additive
    // Patterns: 0 lit solid, 1 emissive solid, 2+ ground/plane decals.
    const FX_STRIDE = 16;
    const FX_MESH_BOX = 0, FX_MESH_ORB = 1, FX_MESH_SPIKE = 2, FX_MESH_DECAL = 3, FX_MESH_COUNT = 4;
    const FX_PATTERN = { LIT: 0, GLOW_SOLID: 1, GLOW: 2, RING: 3, RUNE: 4, CRESCENT: 5, CLAWS: 6, CROSS: 7, SHADOW: 8, SPLAT: 9 };

    class FxBatch {
        constructor() {
            this.data = [];
            this.count = new Int32Array(FX_MESH_COUNT);
            for (let i = 0; i < FX_MESH_COUNT; i++) this.data.push(new Float32Array(256 * FX_STRIDE));
            this.total = 0;
        }

        reset() {
            this.count.fill(0);
            this.total = 0;
        }

        push(mesh, x, y, z, yaw, sx, sy, sz, pitch, r, g, b, alpha, pattern, param, roll, additive) {
            let i = this.count[mesh], d = this.data[mesh];
            if ((i + 1) * FX_STRIDE > d.length) {
                let grown = new Float32Array(d.length * 2);
                grown.set(d);
                this.data[mesh] = d = grown;
            }
            let o = i * FX_STRIDE;
            d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = yaw;
            d[o + 4] = sx; d[o + 5] = sy; d[o + 6] = sz; d[o + 7] = pitch;
            d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = alpha;
            d[o + 12] = pattern; d[o + 13] = param; d[o + 14] = roll; d[o + 15] = additive;
            this.count[mesh] = i + 1;
            this.total++;
        }
    }

    function createCenteredCubeData() {
        let cube = createCubeData();
        let positions = new Float32Array(cube.positions);
        for (let i = 1; i < positions.length; i += 3) positions[i] -= .5;
        return { positions, normals: cube.normals, indices: cube.indices, uvs: cube.uvs };
    }

    // Flat-shaded icosahedron: reads as a ball under cel lighting.
    function createOrbData() {
        let t = (1 + Math.sqrt(5)) / 2;
        let v = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]]
            .map(p => { let l = Math.hypot(p[0], p[1], p[2]) * 2; return [p[0] / l, p[1] / l, p[2] / l]; });
        let faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
            [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
        let positions = [], indices = [];
        for (let f of faces) for (let k of f) { indices.push(positions.length / 3); positions.push(...v[k]); }
        positions = new Float32Array(positions);
        indices = new Uint32Array(indices);
        return { positions, normals: computeNormals(positions, indices), indices, uvs: new Float32Array(positions.length / 3 * 2) };
    }

    // Four-sided spike: square base on y = 0, apex at y = 1. Flames, ice,
    // shards, arrowheads and javelins (pitched along their flight).
    function createSpikeData() {
        let base = [[-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5]], apex = [0,1,0];
        let positions = [], indices = [];
        for (let i = 0; i < 4; i++) {
            let a = base[i], b = base[(i + 1) % 4];
            indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2);
            positions.push(...a, ...apex, ...b);
        }
        indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2,
            positions.length / 3, positions.length / 3 + 2, positions.length / 3 + 3);
        positions.push(...base[0], ...base[1], ...base[2], ...base[3]);
        positions = new Float32Array(positions);
        indices = new Uint32Array(indices);
        return { positions, normals: computeNormals(positions, indices), indices, uvs: new Float32Array(positions.length / 3 * 2) };
    }

    const FX_VERTEX_GLSL = `#version 300 es
        precision highp float;
        layout(location=0) in vec3 aPosition;
        layout(location=1) in vec3 aNormal;
        layout(location=3) in vec4 iA;
        layout(location=4) in vec4 iB;
        layout(location=5) in vec4 iC;
        layout(location=6) in vec4 iD;
        uniform mat4 uViewProjection;
        uniform float uFlat;
        out vec3 vNormal;
        out vec4 vColor;
        out vec2 vUv;
        flat out vec3 vStyle;
        vec3 orient(vec3 p) {
            float cr = cos(iD.z), sr = sin(iD.z);
            p.xy = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);
            float cp = cos(iB.w), sp = sin(iB.w);
            p.yz = vec2(cp * p.y - sp * p.z, sp * p.y + cp * p.z);
            float cy = cos(iA.w), sy = sin(iA.w);
            return vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
        }
        void main() {
            vec3 world = iA.xyz + orient(aPosition * iB.xyz);
            vNormal = orient(aNormal / max(iB.xyz, vec3(.0001)));
            // The 2D view is an oblique projection: height lifts a shape up
            // the screen, so arcs and debris read without a 3D camera.
            if (uFlat > .5) { world.z -= world.y * .6; world.y = .1; }
            gl_Position = uViewProjection * vec4(world, 1.);
            vColor = iC;
            vUv = aPosition.xz + .5;
            vStyle = vec3(iD.x, iD.y, iD.w);
        }`;

    // A function: the shared lighting GLSL is declared further down.
    const fxFragmentGlsl = () => `#version 300 es
        precision highp float;
        in vec3 vNormal;
        in vec4 vColor;
        in vec2 vUv;
        flat in vec3 vStyle;
        uniform float uFlat;
        ${CEL_LIGHTING_GLSL}
        layout(location=0) out vec4 outColor;
        const float PI = 3.14159265;
        float band(float v, float center, float width) { return 1. - smoothstep(width * .5, width, abs(v - center)); }
        void main() {
            float pattern = floor(vStyle.x + .5), param = vStyle.y;
            vec3 color = vColor.rgb;
            float mask = 1.;
            if (pattern < 1.5) {
                float diffuse = max(dot(normalize(vNormal), normalize(vec3(-.42, .86, .31))), 0.);
                float shade = uFlat > .5 ? mix(.8, 1., diffuse) : celShade(diffuse);
                color *= pattern < .5 ? shade : mix(.82, 1.12, diffuse);
            } else {
                vec2 q = vUv * 2. - 1.;
                float r = length(q);
                float ang = atan(q.x, q.y);
                if (pattern == 2.) mask = pow(max(0., 1. - r), 2.);
                else if (pattern == 3.) mask = band(r, param, .16) * step(r, 1.);
                else if (pattern == 4.) {
                    // Rune circle: two rings, ticks and a turning hexagram.
                    float a = ang + param;
                    float ticks = step(fract(a * 12. / (2. * PI)), .18) * step(.72, r) * step(r, .9);
                    float sector = 2. * PI / 3.;
                    float tri1 = r * cos(mod(a, sector) - sector * .5) - .3;
                    float tri2 = r * cos(mod(a + sector * .5, sector) - sector * .5) - .3;
                    mask = max(max(band(r, .94, .07), band(r, .72, .05)), max(ticks, max(band(tri1, 0., .05), band(tri2, 0., .05))));
                    mask *= step(r, 1.);
                } else if (pattern == 5.) {
                    // Crescent swept by param from one tip to the other.
                    float span = 1.35, t = clamp(ang / span, -1., 1.);
                    float width = .2 * (1. - t * t);
                    mask = band(r, .72, width) * step(abs(ang), span) * step(ang, -span + 2. * span * param);
                } else if (pattern == 6.) {
                    // Three raking claw strokes.
                    vec2 c = mat2(.87, .5, -.5, .87) * q;
                    float along = clamp(c.y / .8, -1., 1.);
                    float reach = step(c.y, -.8 + 1.6 * param);
                    float w = .09 * (1. - along * along);
                    mask = max(band(c.x, -.34, w), max(band(c.x, 0., w), band(c.x, .34, w))) * step(abs(c.y), .8) * reach;
                } else if (pattern == 7.) {
                    // Crossed slashes.
                    vec2 a = normalize(vec2(1., 1.)), b = normalize(vec2(-1., 1.));
                    float la = abs(dot(q, a)), lb = abs(dot(q, b));
                    float ta = dot(q, vec2(-a.y, a.x)), tb = dot(q, vec2(-b.y, b.x));
                    mask = max(band(ta, 0., .14 * (1. - la * la)) * step(la, .95) * step(dot(q, a), -.95 + 1.9 * param),
                               band(tb, 0., .14 * (1. - lb * lb)) * step(lb, .95) * step(dot(q, b), -.95 + 1.9 * clamp(param * 1.6 - .6, 0., 1.)));
                } else if (pattern == 8.) {
                    mask = 1. - smoothstep(.35, 1., r);
                    color = vec3(0.);
                } else if (pattern == 9.) {
                    float edge = .62 + .14 * sin(ang * 7. + param * 3.) + .06 * sin(ang * 13.);
                    mask = 1. - smoothstep(edge - .1, edge, r);
                }
                if (mask <= .003) discard;
            }
            float alpha = vColor.a * mask;
            // Premultiplied: additive shapes add light, others cover.
            outColor = vec4(color * alpha, alpha * (1. - vStyle.z));
        }`;

    const SHADOW_LIGHT_DIRECTION = (() => {
        let x = -0.42;
        let y = 0.86;
        let z = 0.31;
        let length = Math.hypot(x, y, z) || 1;
        return [x / length, y / length, z / length];
    })();
    const SHADOW_GROUND_Y = 0.004;
    const SHADOW_FLAT_HEIGHT = 0.024;

    // Shared 3D lighting and face borders, with no extra passes or textures.
    const CEL_LIGHTING_GLSL = `
        float celShade(float diffuse) {
            float aa = max(fwidth(diffuse), 0.025);
            return 0.42
                + 0.26 * smoothstep(0.22 - aa, 0.22 + aa, diffuse)
                + 0.32 * smoothstep(0.66 - aa, 0.66 + aa, diffuse);
        }
        float faceInk(vec2 uv, float width) {
            vec2 pixelSize = max(fwidth(uv), vec2(0.00001));
            vec2 edgePixels = min(uv, 1.0 - uv) / pixelSize;
            float edge = min(edgePixels.x, edgePixels.y);
            // Fade on tiny parts so distant units keep their player color.
            float coverage = 1.0 - smoothstep(0.12, 0.40, max(pixelSize.x, pixelSize.y));
            return (1.0 - smoothstep(width - 0.5, width + 0.5, edge)) * coverage;
        }
    `;

    function perspective(out, fovY, aspect, near, far) {
        let f = 1 / Math.tan(fovY * 0.5);
        let nf = 1 / (near - far);
        out[0] = f / aspect;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        out[5] = f;
        out[6] = 0;
        out[7] = 0;
        out[8] = 0;
        out[9] = 0;
        out[10] = (far + near) * nf;
        out[11] = -1;
        out[12] = 0;
        out[13] = 0;
        out[14] = (2 * far * near) * nf;
        out[15] = 0;
        return out;
    }

    function lookAt(out, eye, target, up) {
        let zx = eye[0] - target[0];
        let zy = eye[1] - target[1];
        let zz = eye[2] - target[2];
        let zLen = Math.hypot(zx, zy, zz) || 1;
        zx /= zLen;
        zy /= zLen;
        zz /= zLen;

        let xx = up[1] * zz - up[2] * zy;
        let xy = up[2] * zx - up[0] * zz;
        let xz = up[0] * zy - up[1] * zx;
        let xLen = Math.hypot(xx, xy, xz) || 1;
        xx /= xLen;
        xy /= xLen;
        xz /= xLen;

        let yx = zy * xz - zz * xy;
        let yy = zz * xx - zx * xz;
        let yz = zx * xy - zy * xx;

        out[0] = xx;
        out[1] = yx;
        out[2] = zx;
        out[3] = 0;
        out[4] = xy;
        out[5] = yy;
        out[6] = zy;
        out[7] = 0;
        out[8] = xz;
        out[9] = yz;
        out[10] = zz;
        out[11] = 0;
        out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
        out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
        out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
        out[15] = 1;
        return out;
    }

    function multiplyMatrices(out, a, b) {
        let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        let a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        let a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        let a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        let b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3];
        let b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7];
        let b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11];
        let b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];
        out[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
        out[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
        out[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
        out[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
        out[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
        out[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
        out[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
        out[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
        out[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
        out[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
        out[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
        out[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
        out[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
        out[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
        out[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
        out[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
        return out;
    }

    function invertMatrix4(out, m) {
        let a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
        let a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
        let a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
        let a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

        let b00 = a00 * a11 - a01 * a10;
        let b01 = a00 * a12 - a02 * a10;
        let b02 = a00 * a13 - a03 * a10;
        let b03 = a01 * a12 - a02 * a11;
        let b04 = a01 * a13 - a03 * a11;
        let b05 = a02 * a13 - a03 * a12;
        let b06 = a20 * a31 - a21 * a30;
        let b07 = a20 * a32 - a22 * a30;
        let b08 = a20 * a33 - a23 * a30;
        let b09 = a21 * a32 - a22 * a31;
        let b10 = a21 * a33 - a23 * a31;
        let b11 = a22 * a33 - a23 * a32;

        let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!determinant) return null;
        let invDet = 1 / determinant;

        out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
        out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
        out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
        out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
        out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
        out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
        out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
        out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
        out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
        out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
        out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
        out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
        out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
        out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
        out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
        out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
        return out;
    }

    function transformClipToWorld(matrix, x, y, z) {
        let wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        let wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        let wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        let ww = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        if (!ww) return null;
        let invW = 1 / ww;
        return [wx * invW, wy * invW, wz * invW];
    }

    // Shadow-map camera: an orthographic view along SHADOW_LIGHT_DIRECTION
    // that covers the part of the camera frustum between the ground and
    // SHADOW_CASTER_HEIGHT, clamped to the map. Bounds are snapped to whole
    // shadow texels so the map does not shimmer while panning.
    const SHADOW_CASTER_HEIGHT = 3;
    function buildShadowViewProjection(out, view, inverseViewProjection, worldWidth, worldHeight, size) {
        let corners = [];
        for (let z of [-1, 1]) for (let y of [-1, 1]) for (let x of [-1, 1]) corners.push(transformClipToWorld(inverseViewProjection, x, y, z));
        let points = [];
        let clampPoint = (x, y, z) => {
            if (!Number.isFinite(x) || !Number.isFinite(z)) return;
            points.push([Math.max(-2, Math.min(worldWidth + 2, x)), y, Math.max(-2, Math.min(worldHeight + 2, z))]);
        };
        for (let i = 0; i < 8; i++) {
            let a = corners[i];
            if (!a) continue;
            if (a[1] >= 0 && a[1] <= SHADOW_CASTER_HEIGHT) clampPoint(a[0], a[1], a[2]);
            for (let bit of [1, 2, 4]) {
                let j = i ^ bit;
                if (j <= i || !corners[j]) continue;
                let b = corners[j];
                for (let h of [0, SHADOW_CASTER_HEIGHT]) {
                    if ((a[1] - h) * (b[1] - h) > 0 || a[1] === b[1]) continue;
                    let t = (h - a[1]) / (b[1] - a[1]);
                    clampPoint(a[0] + (b[0] - a[0]) * t, h, a[2] + (b[2] - a[2]) * t);
                }
            }
        }
        if (points.length < 3) return 0;
        let d = SHADOW_LIGHT_DIRECTION;
        lookAt(view, [d[0], d[1], d[2]], [0, 0, 0], [0, 1, 0]);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let p of points) {
            let lx = view[0] * p[0] + view[4] * p[1] + view[8] * p[2] + view[12];
            let ly = view[1] * p[0] + view[5] * p[1] + view[9] * p[2] + view[13];
            let lz = view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14];
            minX = Math.min(minX, lx); maxX = Math.max(maxX, lx);
            minY = Math.min(minY, ly); maxY = Math.max(maxY, ly);
            minZ = Math.min(minZ, lz); maxZ = Math.max(maxZ, lz);
        }
        // Square extent rounded up to a whole tile keeps the texel size stable.
        let extent = Math.ceil(Math.max(maxX - minX, maxY - minY, 1) + 1);
        let texel = extent / size;
        minX = Math.floor((minX + maxX - extent) * 0.5 / texel) * texel;
        minY = Math.floor((minY + maxY - extent) * 0.5 / texel) * texel;
        maxX = minX + extent; maxY = minY + extent;
        // View space looks down -z; casters above the covered ground sit
        // toward the light (larger z), so extend the near side for them.
        let near = -(maxZ + SHADOW_CASTER_HEIGHT / Math.max(0.2, d[1]) + 1), far = -(minZ - 1);
        let proj = new Float32Array(16);
        proj[0] = 2 / (maxX - minX); proj[5] = 2 / (maxY - minY); proj[10] = -2 / (far - near);
        proj[12] = -(maxX + minX) / (maxX - minX); proj[13] = -(maxY + minY) / (maxY - minY);
        proj[14] = -(far + near) / (far - near); proj[15] = 1;
        multiplyMatrices(out, proj, view);
        return extent;
    }

    // composeModelMatrix written in place into instance data at `base`.
    // An object's instance matrix; the rotation's cosine and sine are kept
    // on the object (most objects keep their rotation between frames).
    function writeObjectMatrix(out, base, o) {
        let r = o.rotationY || 0;
        let c, s;
        if (o._iRot === r) { c = o._iCos; s = o._iSin; }
        else { c = Math.cos(r); s = Math.sin(r); o._iRot = r; o._iCos = c; o._iSin = s; }
        let sx = o.scaleX, sy = o.scaleY, sz = o.scaleZ;
        out[base] = c * sx; out[base + 1] = 0; out[base + 2] = -s * sx; out[base + 3] = 0;
        out[base + 4] = 0; out[base + 5] = sy; out[base + 6] = 0; out[base + 7] = 0;
        out[base + 8] = s * sz; out[base + 9] = 0; out[base + 10] = c * sz; out[base + 11] = 0;
        out[base + 12] = o.x; out[base + 13] = o.y; out[base + 14] = o.z; out[base + 15] = 1;
    }

    // Parsed tint colours, kept on the object while its tint string is the same.
    function objectRgb(o) {
        let t = o.tint;
        if (o._iTint !== t) { o._iTint = t; o._iRgb = hexToRgb(t); }
        return o._iRgb;
    }
    function objectSideRgb(o) {
        let t = o.sideTint || o.tint;
        if (o._iSide !== t) { o._iSide = t; o._iSideRgb = hexToRgb(t); }
        return o._iSideRgb;
    }

    function writeModelMatrix(out, base, tx, ty, tz, rotationY, sx, sy, sz) {
        let c = Math.cos(rotationY);
        let s = Math.sin(rotationY);
        out[base] = c * sx;
        out[base + 1] = 0;
        out[base + 2] = -s * sx;
        out[base + 3] = 0;
        out[base + 4] = 0;
        out[base + 5] = sy;
        out[base + 6] = 0;
        out[base + 7] = 0;
        out[base + 8] = s * sz;
        out[base + 9] = 0;
        out[base + 10] = c * sz;
        out[base + 11] = 0;
        out[base + 12] = tx;
        out[base + 13] = ty;
        out[base + 14] = tz;
        out[base + 15] = 1;
    }

    function composeModelMatrix(out, tx, ty, tz, rotationY, sx, sy, sz) {
        let c = Math.cos(rotationY);
        let s = Math.sin(rotationY);
        out[0] = c * sx;
        out[1] = 0;
        out[2] = -s * sx;
        out[3] = 0;
        out[4] = 0;
        out[5] = sy;
        out[6] = 0;
        out[7] = 0;
        out[8] = s * sz;
        out[9] = 0;
        out[10] = c * sz;
        out[11] = 0;
        out[12] = tx;
        out[13] = ty;
        out[14] = tz;
        out[15] = 1;
        return out;
    }

    function extractNormalMatrix(out, modelMatrix) {
        out[0] = modelMatrix[0];
        out[1] = modelMatrix[1];
        out[2] = modelMatrix[2];
        out[3] = modelMatrix[4];
        out[4] = modelMatrix[5];
        out[5] = modelMatrix[6];
        out[6] = modelMatrix[8];
        out[7] = modelMatrix[9];
        out[8] = modelMatrix[10];
        return out;
    }

    function accessorComponentCount(type) {
        switch (type) {
            case 'SCALAR': return 1;
            case 'VEC2': return 2;
            case 'VEC3': return 3;
            case 'VEC4': return 4;
            default: return 1;
        }
    }

    function accessorComponentSize(componentType) {
        switch (componentType) {
            case 5120:
            case 5121: return 1;
            case 5122:
            case 5123: return 2;
            case 5125:
            case 5126: return 4;
            default: return 4;
        }
    }

    function readComponent(dataView, offset, componentType) {
        switch (componentType) {
            case 5120: return dataView.getInt8(offset);
            case 5121: return dataView.getUint8(offset);
            case 5122: return dataView.getInt16(offset, true);
            case 5123: return dataView.getUint16(offset, true);
            case 5125: return dataView.getUint32(offset, true);
            case 5126: return dataView.getFloat32(offset, true);
            default: return 0;
        }
    }

    function readAccessor(doc, buffers, accessorIndex) {
        let accessor = doc.accessors[accessorIndex];
        let bufferView = doc.bufferViews[accessor.bufferView];
        let arrayBuffer = buffers[bufferView.buffer];
        let componentCount = accessorComponentCount(accessor.type);
        let componentSize = accessorComponentSize(accessor.componentType);
        let stride = bufferView.byteStride || componentCount * componentSize;
        let baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        let dataView = new DataView(arrayBuffer, baseOffset, stride * accessor.count);
        let output = new Float32Array(accessor.count * componentCount);
        for (let i = 0; i < accessor.count; i++) {
            let rowOffset = i * stride;
            for (let c = 0; c < componentCount; c++) {
                output[i * componentCount + c] = readComponent(dataView, rowOffset + c * componentSize, accessor.componentType);
            }
        }
        return output;
    }

    function readIndicesAccessor(doc, buffers, accessorIndex) {
        if (accessorIndex == null) return null;
        let accessor = doc.accessors[accessorIndex];
        let bufferView = doc.bufferViews[accessor.bufferView];
        let arrayBuffer = buffers[bufferView.buffer];
        let componentSize = accessorComponentSize(accessor.componentType);
        let stride = bufferView.byteStride || componentSize;
        let baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        let dataView = new DataView(arrayBuffer, baseOffset, stride * accessor.count);
        let output = new Uint32Array(accessor.count);
        for (let i = 0; i < accessor.count; i++) {
            output[i] = readComponent(dataView, i * stride, accessor.componentType);
        }
        return output;
    }

    function computeNormals(positions, indices) {
        let normals = new Float32Array(positions.length);
        let triangleCount = indices ? indices.length / 3 : positions.length / 9;
        for (let i = 0; i < triangleCount; i++) {
            let ia = indices ? indices[i * 3] : i * 3;
            let ib = indices ? indices[i * 3 + 1] : i * 3 + 1;
            let ic = indices ? indices[i * 3 + 2] : i * 3 + 2;
            let ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
            let bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
            let cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
            let abx = bx - ax, aby = by - ay, abz = bz - az;
            let acx = cx - ax, acy = cy - ay, acz = cz - az;
            let nx = aby * acz - abz * acy;
            let ny = abz * acx - abx * acz;
            let nz = abx * acy - aby * acx;
            normals[ia * 3] += nx; normals[ia * 3 + 1] += ny; normals[ia * 3 + 2] += nz;
            normals[ib * 3] += nx; normals[ib * 3 + 1] += ny; normals[ib * 3 + 2] += nz;
            normals[ic * 3] += nx; normals[ic * 3 + 1] += ny; normals[ic * 3 + 2] += nz;
        }
        for (let i = 0; i < normals.length; i += 3) {
            let len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
            normals[i] /= len;
            normals[i + 1] /= len;
            normals[i + 2] /= len;
        }
        return normals;
    }

    function normalizeMeshPositions(positions) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            let x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        let cx = (minX + maxX) * 0.5;
        let cz = (minZ + maxZ) * 0.5;
        let sy = minY;
        let extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
        let scale = 1 / extent;
        let output = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
            output[i] = (positions[i] - cx) * scale;
            output[i + 1] = (positions[i + 1] - sy) * scale;
            output[i + 2] = (positions[i + 2] - cz) * scale;
        }
        return output;
    }

    function parseGlb(arrayBuffer) {
        let view = new DataView(arrayBuffer);
        if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB header');
        let offset = 12;
        let json = null;
        let binChunk = null;
        while (offset < arrayBuffer.byteLength) {
            let chunkLength = view.getUint32(offset, true); offset += 4;
            let chunkType = view.getUint32(offset, true); offset += 4;
            let chunkData = arrayBuffer.slice(offset, offset + chunkLength);
            offset += chunkLength;
            if (chunkType === 0x4e4f534a) {
                json = JSON.parse(new TextDecoder().decode(chunkData));
            } else if (chunkType === 0x004e4942) {
                binChunk = chunkData;
            }
        }
        return { json, buffers: [binChunk] };
    }

    async function parseGltfUrl(url) {
        if (url.toLowerCase().endsWith('.glb')) {
            let response = await fetch(url);
            if (!response.ok) throw new Error('GLB fetch failed');
            return parseGlb(await response.arrayBuffer());
        }
        let response = await fetch(url);
        if (!response.ok) throw new Error('GLTF fetch failed');
        let json = await response.json();
        let baseUrl = new URL(url, window.location.href);
        let buffers = await Promise.all((json.buffers || []).map(async (bufferDef) => {
            let bufferUrl = new URL(bufferDef.uri, baseUrl).href;
            let bufferResponse = await fetch(bufferUrl);
            if (!bufferResponse.ok) throw new Error('GLTF buffer fetch failed');
            return bufferResponse.arrayBuffer();
        }));
        return { json, buffers };
    }

    function buildMeshDataFromGltf(doc, buffers) {
        if (!doc || !doc.meshes || doc.meshes.length <= 0) return null;
        let primitive = null;
        for (let mesh of doc.meshes) {
            if (mesh.primitives && mesh.primitives.length > 0) {
                primitive = mesh.primitives[0];
                break;
            }
        }
        if (!primitive || !primitive.attributes || primitive.attributes.POSITION == null) return null;
        let positions = normalizeMeshPositions(readAccessor(doc, buffers, primitive.attributes.POSITION));
        let normals = primitive.attributes.NORMAL != null ? readAccessor(doc, buffers, primitive.attributes.NORMAL) : computeNormals(positions, readIndicesAccessor(doc, buffers, primitive.indices));
        let indices = readIndicesAccessor(doc, buffers, primitive.indices);
        if (!indices) {
            indices = new Uint32Array(positions.length / 3);
            for (let i = 0; i < indices.length; i++) indices[i] = i;
        }
        return { positions, normals, indices };
    }

    // Merged procedural parts: one mesh and one draw per material batch, never
    // one object/draw per limb. Surface IDs: 0 type-colored cloth, 1 neutral
    // armor, 2 player trim, 3 eye glow, 4 the complete 2D status render (on
    // dedicated rectangular quads), 5 leather/wood/fur, 6 ivory/bone/feathers,
    // 7 type-colored glow (staff orbs), 8 brass/gold, 9 medic red, 15 the
    // front status display (owner color behind the unit's status icon).
    // Joints: +-1 limbs, 2 capes/tails, +-3 wings (root at the pivot), +-4
    // quadruped legs (diagonal pairs), 5 neck/head (pivot y, pivot z), +-6
    // parts spinning about the model's vertical axis.
    // Every role has its own silhouette; roles that share a purpose share a
    // body plan (all casters are robed mages, all ground workers are blocky).
    function createFigureData(kind, simplified = false) {
        let variant = kind;
        kind = kind.split(':')[0];
        let weapon = variant.includes(':') ? variant.slice(variant.indexOf(':') + 1) : '';
        let positions = [], normals = [], indices = [], uvs = [], details = [];
        function part(x, y, z, sx, sy, sz, surface = 0, joint = 0, pivot = 0, taper = 1, yaw = 0, pivotZ = 0) {
            // At strategic zoom, subpixel ornaments turn into noisy gray specks.
            // Keep broad plates (even thin ones), bodies, limbs and sprite panels.
            if (simplified) {
                let middleSize = sx + sy + sz - Math.min(sx, sy, sz) - Math.max(sx, sy, sz);
                let mainLimb = Math.abs(joint) === 1 && sy >= .25 && sx >= .13;
                let readableEquipment = !!weapon && (sy >= .20 || sx >= .20 || sz >= .20);
                if (surface === 3 || (middleSize < .18 && !mainLimb && !readableEquipment)) return;
                // Far level (a unit a few pixels across): only the bulk of
                // the figure, its limbs and large equipment.
                if (simplified === 2 && middleSize < .26 && !mainLimb && !(weapon && Math.max(sx, sy, sz) >= .35)) return;
            }
            let cube = createCubeData(), base = positions.length / 3;
            let yawCos = Math.cos(yaw), yawSin = Math.sin(yaw);
            // The far level drops bottom faces (the last face): the camera and
            // the light are always above.
            let cubeVerts = simplified === 2 ? 20 : cube.positions.length / 3;
            for (let i = 0; i < cubeVerts; i++) {
                let px = cube.positions[i * 3], py = cube.positions[i * 3 + 1], pz = cube.positions[i * 3 + 2];
                let width = 1 + (taper - 1) * py;
                let localX = px * sx * width, localZ = pz * sz * width;
                positions.push(x + localX * yawCos + localZ * yawSin, y + py * sy, z - localX * yawSin + localZ * yawCos);
                uvs.push(cube.uvs[i * 2], 1 - cube.uvs[i * 2 + 1]);
                details.push(surface, joint, pivot, pivotZ);
            }
            for (let k = 0; k < cubeVerts / 4 * 6; k++) indices.push(base + cube.indices[k]);
        }
        function panel(x, y, z, width, height, horizontal = false, joint = 0, pivot = 0, worldAligned = false) {
            let base = positions.length / 3;
            let corners = horizontal
                ? [[-.5,0,.5],[.5,0,.5],[.5,0,-.5],[-.5,0,-.5]]
                : [[.5,0,0],[-.5,0,0],[-.5,1,0],[.5,1,0]];
            for (let p of corners) {
                positions.push(x + p[0] * width, y + p[1] * height, z + p[2] * height);
                details.push(4, joint, pivot, worldAligned ? 1 : 0);
            }
            uvs.push(0,0,1,0,1,1,0,1);
            indices.push(base,base+1,base+2,base,base+2,base+3);
        }
        // Rear display: the canonical 2D render on a rigid backing plate.
        function backPanel(y, z, size) {
            part(0, y - .02, z, size + .04, size + .04, .04, 2);
            panel(0, y, z - .024, size, size);
        }
        // Front status display (surface 15), facing forward (+z): a square
        // quad on the front face `z` of whatever plate, book or shield carries it.
        function statusPanel(y, z, size, joint = 0, pivot = 0) {
            if (simplified === 2) return;   // about a pixel at that distance
            let base = positions.length / 3;
            for (let p of [[-.5,0],[.5,0],[.5,1],[-.5,1]]) {
                positions.push(p[0] * size, y + p[1] * size, z + .003);
                details.push(15, joint, pivot, 0);
            }
            uvs.push(0,0,1,0,1,1,0,1);
            indices.push(base,base+1,base+2,base,base+2,base+3);
        }
        // A plate (surface, centered at z with depth d) framing the display.
        function statusPlate(y, z, size, surface, d = .04, frame = .03, joint = 0, pivot = 0) {
            part(0, y - frame, z, size + frame * 2, size + frame * 2, d, surface, joint, pivot);
            statusPanel(y, z + d / 2, size, joint, pivot);
        }
        // A small seated rider (hands at the pivot height) for mounts. A
        // helmed rider wears a closed helm with an owner-colored plume. A
        // small shield strapped to the chest, above the horse's head, carries
        // the status display.
        function rider(y, z, helmed = false) {
            statusPlate(y + .05, z + .11, .17, 1, .04, .025);
            for (let side of [-1, 1]) part(side * .17, y - .12, z + .02, .07, .17, .11, 0);
            part(0, y, z, .25, .24, .18, 0, 0, 0, .8);
            part(0, y + .03, z, .27, .05, .20, 2);
            if (helmed) {
                part(0, y + .22, z, .20, .17, .19, 1); // helm
                part(0, y + .38, z - .02, .04, .09, .17, 2); // plume
                for (let side of [-1, 1]) part(side * .15, y + .18, z, .08, .06, .16, 1); // pauldrons
            } else {
                part(0, y + .23, z, .21, .19, .19, 0, 0, 0, .3); // hood
            }
            part(0, y + .25, z + .085, .14, .08, .03, 1);
            for (let side of [-1, 1]) {
                part(side * .035, y + .285, z + .10, .03, .015, .01, 3);
                part(side * .17, y + .03, z + .02, .07, .18, .08, 0, -side, y + .2);
            }
        }
        let humanoid = kind === 'figure' || kind === 'heavy' || kind === 'knight' || kind === 'ogre' || kind === 'mage' || kind === 'worker'
            || kind === 'wingworker';
        if (kind === 'figure' || kind === 'heavy') {
            let bulk = kind === 'heavy' ? 1.2 : 1;
            part(0, .29, 0, .52 * bulk, .39, .34, 0, 0, 0, .76);
            part(0, .66, 0, .47, .34, .43, 0, 0, 0, .16); // pointed hood
            part(0, .69, .174, .30, .17, .07, 1);
            for (let side of [-1, 1]) {
                part(side * .083, .755, .214, .057, .022, .015, 3);
                part(side * .16, .04, 0, .15, .28, .17, 1, side, .32);
                part(side * .16, .015, .055, .18, .09, .28, 1, side, .32);
                part(side * .32 * bulk, .33, 0, .135, .32, .16, 0, -side, .65);
                part(side * .32 * bulk, .60, 0, .19, .095, .23, 2, -side, .65);
            }
            part(0, .33, 0, .53 * bulk, .055, .36, 2);
            statusPlate(.40, .165, .22, 1, .08, .025); // breastplate display
            part(0, .19, -.205, .61, .47, .065, 0, 2, .66, .72); // cape
            part(0, .18, -.253, .53, .53, .04, 2); // rigid, readable back display
            panel(0, .20, -.277, .49, .49);
            if (kind === 'figure' && !weapon) {
                part(.36, .22, .12, .05, .40, .06, 2, -1, .65); // blade
            }
            if (kind === 'figure') {
                // Footman's round shield on the off hand.
                part(-.40, .22, .11, .06, .30, .30, 2, 1, .65);
                part(-.44, .31, .11, .03, .12, .12, 8, 1, .65);
            }
            if (kind === 'heavy') part(-.43, .26, .12, .24, .32, .10, 2, 1, .65);
            if (weapon === 'king_sword') {
                for (let x of [-.18,0,.18]) part(x,.88,0,.07,.14,.12,8);
                part(0,.83,0,.46,.06,.40,8); // crown band
            }
        } else if (kind === 'knight') {
            // Tank: plate armor, a closed helm with a glowing slit and a
            // tower shield. Broad and square from every angle.
            for (let side of [-1, 1]) {
                part(side * .17, .03, 0, .18, .29, .20, 1, side, .32);
                part(side * .17, .0, .05, .21, .08, .30, 1, side, .32);
                part(side * .40, .30, 0, .16, .32, .18, 1, -side, .64);
                part(side * .40, .56, 0, .28, .14, .32, 2, -side, .64); // pauldrons
            }
            part(0, .30, 0, .64, .37, .42, 1, 0, 0, .86);
            part(0, .28, .205, .40, .34, .03, 0); // tabard, framing the display
            statusPanel(.31, .22, .28);
            part(0, .305, 0, .67, .06, .47, 2);
            part(0, .66, 0, .34, .30, .34, 1); // helm
            part(0, .76, .171, .25, .035, .01, 3);
            part(0, .95, -.02, .07, .15, .24, 2); // crest
            part(-.49, .16, .10, .08, .56, .44, 2, 1, .64); // tower shield
            part(-.53, .36, .10, .03, .16, .16, 8, 1, .64);
            backPanel(.20, -.235, .49);
        } else if (kind === 'ogre') {
            // Boss: a hunched, horned brute, visibly the largest thing walking.
            for (let side of [-1, 1]) {
                part(side * .20, .02, 0, .22, .26, .24, 1, side, .28);
                part(side * .45, .14, .05, .19, .46, .21, 0, -side, .62); // long arms
                part(side * .45, .10, .05, .21, .08, .23, 5, -side, .62);
                part(side * .17, .80, .15, .06, .20, .06, 6, 0, 0, .25); // horns
                part(side * .07, .745, .30, .05, .03, .02, 3);
                part(side * .08, .60, .31, .04, .09, .04, 6, 0, 0, .4); // tusks
            }
            part(0, .24, .02, .74, .42, .54, 0, 0, 0, .82);
            part(0, .30, 0, .76, .06, .56, 2);
            part(0, .58, -.05, .68, .17, .46, 0, 0, 0, .72); // hunched shoulders
            part(0, .60, .16, .30, .23, .28, 0);
            statusPlate(.33, .27, .22, 5, .08, .03); // crude wooden war plate
            for (let side of [-1, 1]) part(side * .13, .56, .27, .03, .03, .085, 6); // bone pegs
            backPanel(.22, -.27, .49);
        } else if (kind === 'mage') {
            // Every caster: long robe, wide-brimmed pointed hat and a staff whose
            // head names the element. The robe and orb carry the element color.
            part(0, 0, 0, .56, .62, .46, 0, 2, .62, .55);
            part(0, 0, 0, .60, .06, .50, 2, 2, .62);
            part(0, .33, 0, .46, .05, .40, 2, 2, .62); // sash
            part(0, .58, 0, .25, .20, .25, 1); // shadowed face
            for (let side of [-1, 1]) {
                part(side * .06, .67, .126, .045, .025, .015, 3);
                part(side * .29, .32, 0, .14, .28, .16, 0, -side, .62, .7); // sleeves
                part(side * .29, .30, 0, .09, .05, .10, 6, -side, .62); // hands
            }
            part(0, .76, .03, .42, .04, .40, 2); // hat brim (clear of the back display)
            part(0, .78, .03, .30, .32, .30, 0, 0, 0, .06); // hat cone
            // Spellbook held before the chest: leather covers, a block of
            // pages, a gold clasp; its front cover is the display.
            part(0, .22, .225, .34, .32, .02, 5);
            part(.01, .23, .25, .31, .30, .03, 6);
            part(0, .22, .272, .34, .32, .015, 5);
            part(-.17, .22, .25, .03, .32, .07, 5); // spine
            part(.17, .34, .25, .02, .08, .075, 8); // clasp
            statusPanel(.245, .28, .27);
            backPanel(.16, -.215, .46);
        } else if (kind === 'worker' || kind === 'wingworker') {
            // Workers are blocky: cube head, hard hat, square body and a
            // backpack carrying their 2D display. Flying workers (healers,
            // researchers) wear their own headgear and have wings on the pack.
            let winged = kind === 'wingworker';
            for (let side of [-1, 1]) {
                part(side * .15, .02, 0, .16, .24, .18, 1, side, .28);
                part(side * .15, 0, .04, .18, .07, .25, 5, side, .28);
                part(side * .34, .30, 0, .13, .27, .14, 0, -side, .62);
                part(side * .34, .26, 0, .135, .06, .145, 6, -side, .62);
                part(side * .07, .69, .131, .04, .04, .01, 1);
            }
            part(0, .24, 0, .52, .36, .36, 0);
            part(0, .29, .181, .32, .26, .02, 1); // bib, framing the display
            statusPanel(.30, .191, .24);
            for (let side of [-1, 1]) part(side * .20, .40, -.01, .06, .21, .40, 2); // owner-colored straps
            part(0, .24, 0, .54, .05, .38, 5); // tool belt
            part(0, .58, 0, .28, .24, .26, 6); // cube head
            if (!winged) {
                part(0, .82, 0, .32, .10, .30, 0); // hard hat
                part(0, .82, .05, .37, .03, .38, 0);
                part(0, .92, 0, .06, .02, .30, 2); // hat ridge
            } else if (weapon === 'healer_staff') {
                part(0, .82, 0, .31, .11, .29, 9); // red medic cap
                part(0, .825, 0, .33, .03, .31, 9);
            } else {
                part(0, .82, 0, .30, .08, .28, 1); // cap, goggles and a lamp
                part(0, .90, .02, .05, .06, .05, 7);
                part(0, .655, 0, .30, .035, .28, 1);
                for (let side of [-1, 1]) part(side * .07, .64, .135, .08, .07, .025, 3);
            }
            part(0, .18, -.25, .48, .48, .14, 5); // backpack
            part(0, .645, -.25, .49, .04, .15, 2); // owner stripe along its top
            panel(0, .20, -.322, .44, .44);
            if (winged) {
                // Wings root on top of the pack and flap about its center.
                for (let side of [-1, 1]) {
                    part(side * .12, .64, -.26, .16, .06, .14, 5);
                    part(side * .34, .64, -.27, .34, .05, .22, 6, side * 3, .66);
                    part(side * .58, .655, -.30, .22, .04, .18, 6, side * 3, .66, .35);
                    part(side * .44, .61, -.34, .30, .03, .10, weapon === 'healer_staff' ? 9 : 3, side * 3, .66);
                }
            }
        } else if (kind === 'rider') {
            // Fast raiders ride a pony (player-colored mane and blanket).
            part(0, .28, -.02, .34, .24, .62, 5);
            part(0, .30, .26, .30, .22, .14, 5);
            part(0, .46, .30, .16, .24, .17, 5, 5, .46, 1, 0, .30); // neck
            part(0, .62, .42, .15, .14, .28, 5, 5, .46, .85, 0, .30); // head
            part(0, .60, .56, .12, .10, .08, 1, 5, .46, 1, 0, .30); // muzzle
            part(0, .57, .27, .05, .14, .14, 2, 5, .46, 1, 0, .30); // mane (low: clear of the rider's shield)
            for (let side of [-1, 1]) {
                part(side * .05, .76, .36, .03, .07, .03, 5, 5, .46, 1, 0, .30); // ears
                part(side * .05, .69, .52, .03, .03, .01, 3, 5, .46, 1, 0, .30);
                for (let end of [-1, 1]) {
                    let z = end > 0 ? .20 : -.24, joint = side * end > 0 ? 4 : -4;
                    part(side * .11, .02, z, .08, .42, .09, 5, joint, .36);
                    part(side * .11, 0, z + .01, .09, .05, .10, 1, joint, .36);
                }
            }
            part(0, .36, -.36, .07, .20, .06, 2, 2, .52); // tail
            part(0, .52, -.04, .38, .03, .32, 2); // blanket
            rider(.55, -.02);
            // Banner behind the rider carries the 2D display.
            part(0, .54, -.20, .41, .41, .03, 2);
            panel(0, .56, -.218, .37, .37);
            for (let side of [-1, 1]) {
                part(side * .20, .57, .06, .03, .05, .30, 1, -side, .75);
                part(side * .20, .55, -.08, .04, .08, .05, 8, -side, .75);
            }
        } else if (kind === 'pegasus') {
            // Scouts and flying units ride winged horses built like the
            // pony: the display lies flat on the rump (they hover) and
            // feathered wings rise from the withers. Scouts ride a white
            // horse with a bow; flying lancers a dark horse with yellow
            // (type color) mane, tail and wing tips and owner-colored cloth.
            let lancer = weapon === 'lance';
            let coat = lancer ? 1 : 6, accent = lancer ? 0 : 2, hoof = lancer ? 0 : 1;
            part(0, .28, -.02, .34, .24, .62, coat);
            part(0, .30, .26, .30, .22, .14, coat);
            part(0, .46, .30, .16, .24, .17, coat, 5, .46, 1, 0, .30); // neck
            part(0, .62, .42, .15, .14, .28, coat, 5, .46, .85, 0, .30); // head
            part(0, .60, .56, .12, .10, .08, lancer ? 0 : 1, 5, .46, 1, 0, .30); // muzzle
            part(0, .57, .27, .05, .14, .14, accent, 5, .46, 1, 0, .30); // mane (low: clear of the rider's shield)
            for (let side of [-1, 1]) {
                part(side * .05, .76, .36, .03, .07, .03, coat, 5, .46, 1, 0, .30); // ears
                part(side * .05, .69, .52, .03, .03, .01, 3, 5, .46, 1, 0, .30);
                for (let end of [-1, 1]) {
                    let z = end > 0 ? .20 : -.24, joint = side * end > 0 ? 4 : -4;
                    part(side * .11, .02, z, .08, .42, .09, coat, joint, .36);
                    part(side * .11, 0, z + .01, .09, .05, .10, hoof, joint, .36);
                }
                // Wings (joint 3 flaps them about the withers).
                part(side * .28, .47, .08, .26, .05, .28, coat, side * 3, .48);
                part(side * .50, .48, .04, .24, .04, .24, lancer ? 2 : 6, side * 3, .48, .6);
                part(side * .66, .49, -.02, .14, .03, .16, lancer ? 0 : 6, side * 3, .48, .3);
            }
            part(0, .36, -.36, .07, .20, .06, accent, 2, .52); // tail
            part(0, .52, -.02, .38, .03, .32, 2); // blanket (owner color)
            if (lancer) part(0, .515, -.02, .40, .02, .34, 0); // its yellow trim
            rider(.55, -.02, lancer);
            panel(0, .555, -.26, .30, .30, true);
            if (lancer) {
                // Lance couched forward and a round shield.
                part(.20, .57, .30, .04, .04, .62, 5, -1, .75);
                part(.20, .57, .64, .065, .065, .08, 0, -1, .75, .2);
                part(.20, .555, .06, .09, .09, .05, 2, -1, .75);
                part(-.21, .55, .02, .05, .20, .20, 2, 1, .75);
                part(-.24, .60, .02, .02, .07, .07, 0, 1, .75);
            } else {
                // Short bow in the off hand and a quiver on the back.
                for (let k = -2; k <= 2; k++) part(-.22, .64 + k * .055, .06 - Math.abs(k) * .025, .035, .06, .035, 5, 1, .75);
                part(-.22, .64, .02, .012, .28, .012, 6, 1, .75); // string
                part(.10, .64, -.14, .07, .18, .07, 5);
                for (let k of [-1, 1]) part(.10 + k * .02, .76, -.14, .015, .06, .015, 6);
            }
        } else if (kind === 'bird') {
            part(0,.30,0,.30,.25,.64,1,0,0,.65);
            part(0,.49,.25,.25,.21,.26,0,0,0,.55);
            part(0,.51,.43,.11,.06,.22,8,0,0,.1); // beak
            for (let side of [-1,1]) {
                part(side*.10,.60,.37,.045,.025,.035,3);
                part(side*.35,.43,-.04,.48,.065,.40,1,side*3);
                for (let feather=0;feather<3;feather++) {
                    part(side*(.55+feather*.085),.42,-.12-feather*.10,.30,.045,.19,feather===0?0:2,side*3,0,.15);
                }
            }
            part(0,.30,-.39,.33,.06,.35,2,0,0,.15);
            statusPlate(.29,.30,.16,1,.04,.02); // breastplate display
            panel(0,.58,-.10,.43,.42,true);
        } else if (kind === 'mole') {
            part(0,.07,0,.67,.39,.73,0,0,0,.55);
            part(0,.14,.39,.27,.17,.28,1,5,.20,.12,0,.34); // snout sniffs
            for (let side of [-1,1]) part(side*.34,.025,.19,.19,.09,.40,2,side,.20);
            statusPlate(.33,.30,.15,1,.05,.02); // digging visor above the snout
            panel(0,.465,-.03,.48,.46,true);
        } else if (kind === 'serpent') {
            // The snake head reads as a fantasy train engine: low chassis,
            // wheels and a boiler/cab. Its 2D panel is part of the model: square
            // (the head is scaled uniformly), turning with it, and every part
            // stays below it so no trim covers the canonical 2D render.
            part(0,.10,0,.82,.24,1.10,0);
            for (let side of [-1,1]) for (let end of [-1,1]) part(side*.42,.04,end*.33,.16,.20,.30,1);
            part(0,.34,-.06,.68,.46,.80,0,0,0,.75);
            part(0,.52,-.28,.52,.30,.40,2,0,0,.55); // cab
            part(0,.50,.45,.34,.30,.34,0,0,0,.42); // boiler nose
            part(0,.64,.50,.14,.20,.14,2); // chimney
            part(0,.25,.64,.76,.10,.26,2); // cowcatcher
            statusPlate(.52,.64,.18,1,.04,.02); // headlamp plate on the boiler
            panel(0,.88,-.06,.66,.66,true);
        } else if (kind === 'portal') {
            // Cloud endpoints: a stone gateway at the back of the tile whose
            // opening swirls (joint 7 turns rings in the gate's plane over
            // time) in the cloud's color around a dark core. The 2D display
            // lies on the flagstones in front, clear of the gate. Lower than
            // a tower, so the gate hides little of the tile behind it.
            part(0, 0, 0, .98, .08, .98, 10);
            part(0, .08, .48, .96, .02, .02, 2);
            panel(0, .085, .15, .66, .66, true, 0, 0, true);
            for (let side of [-1, 1]) {
                part(side * .37, .08, -.34, .17, .60, .22, 10);
                part(side * .37, .08, -.34, .21, .08, .26, 1);
                part(side * .37, .38, -.225, .05, .05, .02, 7); // glowing runes
                part(side * .37, .52, -.225, .05, .05, .02, 7);
            }
            part(0, .66, -.34, .94, .10, .26, 10); // lintel
            part(0, .76, -.34, .34, .06, .18, 10);
            part(0, .68, -.205, .10, .06, .02, 7); // keystone rune
            part(0, .08, -.37, .58, .60, .04, 12); // the dark hole
            // The swirl fills the opening on both faces, so the portal's
            // color reads from behind too. `face` is +1 in front of the hole
            // (toward the display) and -1 behind it.
            let swirl = (face) => {
                let z0 = face > 0 ? -.335 : -.405;
                if (simplified) {
                    // Far away: three nested turning plates instead of thin
                    // rings, which would drop out and leave a black hole.
                    [[.44, 7, 1, 0], [.30, 12, -1, .5], [.20, 7, 1, 1.1]].forEach(([w, surface, dir, speed], k) => {
                        part(0, .38 - w / 2, z0 + face * k * .012, w, w, .03, surface, dir * 7, .38, 1, 0, speed);
                    });
                    return;
                }
                // Square rings, outer to inner, alternately glowing and dark,
                // each turning at its own speed and direction.
                [[.22, 7, 1, 0], [.16, 12, -1, .5], [.11, 7, 1, 1.1], [.06, 7, -1, 1.9]].forEach(([h, surface, dir, speed], k) => {
                    let z = z0 + face * k * .008, t = .04, joint = dir * 7;
                    part(0, .38 + h - t, z, 2 * h, t, .03, surface, joint, .38, 1, 0, speed);
                    part(0, .38 - h, z, 2 * h, t, .03, surface, joint, .38, 1, 0, speed);
                    part(-h + t / 2, .38 - h, z, t, 2 * h, .03, surface, joint, .38, 1, 0, speed);
                    part(h - t / 2, .38 - h, z, t, 2 * h, .03, surface, joint, .38, 1, 0, speed);
                });
                part(0, .345, z0 + face * .035, .07, .07, .03, 7, -7, .38, 1, 0, 2.6); // bright core
            };
            swirl(1);
            swirl(-1);
            part(0, .08, -.205, .52, .012, .05, 7); // light spilling out, behind the display
            part(0, .08, -.475, .52, .012, .05, 7); // and out of the back
        } else if (kind === 'farm') {
            if (weapon === 'astar') {
                // A* farm: a mine entrance. A stepped rock mound with a
                // timbered tunnel, rails and a cart of ore; display on top.
                part(0, 0, 0, .98, .20, .98, 10);
                part(0, .20, -.06, .86, .22, .80, 10);
                part(-.30, .20, .30, .20, .10, .20, 10);
                part(0, .06, .40, .32, .26, .02, 12); // tunnel mouth
                for (let side of [-1, 1]) part(side * .19, .04, .415, .06, .32, .05, 5);
                part(0, .34, .415, .46, .06, .07, 5);
                for (let side of [-1, 1]) part(side * .07, .0, .45, .025, .02, .12, 1); // rails
                part(.30, .04, .36, .18, .12, .15, 1); // cart
                for (let side of [-1, 1]) part(.30 + side * .07, .0, .36, .04, .05, .17, 1);
                part(.30, .16, .36, .15, .06, .12, 6); // ore heap
                part(.27, .21, .34, .05, .05, .05, 7);
                part(.33, .20, .39, .04, .04, .04, 7);
                panel(0, .425, -.06, .80, .80, true, 0, 0, true);
            } else {
                // Energy farm: a blocky tree on a tilled plot, growing glowing
                // energy fruit around its flat crown (the display on top).
                part(0, 0, 0, .98, .07, .98, 5);
                for (let z of [-.30, 0, .30]) part(0, .07, z, .90, .02, .06, 1); // furrows
                part(0, .07, 0, .28, .05, .28, 5);
                part(0, .07, 0, .16, .36, .16, 5); // trunk
                part(0, .40, 0, .86, .30, .86, 11); // crown
                part(0, .43, 0, .92, .20, .70, 11);
                part(0, .43, 0, .70, .20, .92, 11);
                for (let side of [-1, 1]) for (let t of [-.24, .22]) {
                    part(side * .46, .44, t, .08, .10, .08, 7); // fruit
                    part(t, .47, side * .46, .08, .10, .08, 7);
                }
                for (let [x, z] of [[.24, .26], [-.20, .30], [.30, -.18], [-.26, -.24]]) part(x, .32, z, .07, .08, .07, 7);
                panel(0, .705, 0, .82, .82, true, 0, 0, true);
            }
        } else if (kind === 'barrack' || kind === 'workshop') {
            // Outdoor workshops: a flat deck carrying the 2D display, the
            // unit in production is assembled on it (a separate object), and
            // the style's features stand along the back edge so they never
            // cover the display. Barracks follow their unit's style; worker
            // buildings are blocky yards with the tools of their trade.
            let style = weapon;
            let deckSurface = kind === 'workshop' ? 5 : 14;
            part(0, 0, 0, .98, .06, .98, 1);
            part(0, .06, 0, .94, .05, .94, deckSurface);
            part(0, .06, .47, .94, .03, .02, 2);
            part(0, .06, -.47, .94, .03, .02, 0);
            panel(0, .112, .09, .78, .78, true, 0, 0, true);
            if (style === 'rural') {
                // Village smithy: a thatched lean-to over a bench and a rack.
                for (let side of [-1, 1]) part(side * .43, .11, -.42, .06, .56, .06, 5);
                part(0, .64, -.42, .98, .05, .16, 5);
                part(0, .69, -.43, 1.0, .08, .20, 13, 0, 0, .85);
                part(-.16, .11, -.42, .40, .18, .12, 5);
                part(-.24, .29, -.42, .12, .06, .09, 1); // anvil
                part(-.08, .29, -.42, .05, .09, .05, 6);
                for (let k = 0; k < 3; k++) {
                    part(.14 + k * .09, .11, -.445, .025, .40, .025, 5);
                    part(.14 + k * .09, .47, -.445, .05, .12, .02, 6, 0, 0, .2);
                }
                part(.43, .36, -.36, .02, .22, .12, 0); // banner
                for (let side of [-1, 1]) part(side * .44, .11, .44, .05, .12, .05, 5);
            } else if (style === 'castle') {
                // Keep yard: a crenellated curtain wall with a gate, corner
                // towers and owner flags.
                part(0, .11, -.43, .98, .42, .12, 10);
                for (let x of [-.30, -.10, .10, .30]) part(x, .53, -.43, .12, .10, .12, 10);
                part(0, .11, -.365, .22, .30, .02, 1); // gate
                part(0, .43, -.365, .16, .12, .02, 0); // heraldry
                for (let side of [-1, 1]) {
                    part(side * .40, .11, -.40, .20, .64, .20, 10);
                    part(side * .40, .75, -.40, .24, .06, .24, 1);
                    part(side * .40, .81, -.40, .025, .22, .025, 5);
                    part(side * .40 + side * .07, .93, -.40, .12, .08, .02, 2);
                    part(side * .44, .11, .44, .08, .10, .08, 10);
                }
            } else if (style === 'boss') {
                // War camp of the brutes: a dark spiked palisade, horned
                // pillars and fire braziers.
                part(0, .11, -.43, .98, .36, .12, 1);
                for (let x = -.42; x <= .43; x += .12) part(x, .47, -.43, .07, .20, .07, 6, 0, 0, .1);
                for (let side of [-1, 1]) {
                    part(side * .40, .11, -.40, .20, .56, .20, 1, 0, 0, .75);
                    part(side * .47, .60, -.40, .06, .24, .06, 6, 0, 0, .2);
                    part(side * .40, .67, -.40, .12, .06, .12, 8);
                    part(side * .44, .11, .44, .09, .16, .09, 6, 0, 0, .2);
                }
                part(0, .30, -.36, .18, .14, .02, 9); // war banner
            } else if (style === 'arcane') {
                // Elemental sanctum: a glowing rune border, crystal obelisks
                // and a glowing orb over an altar.
                part(0, .11, -.305, .80, .012, .025, 7);
                part(0, .11, .485, .80, .012, .025, 7);
                for (let side of [-1, 1]) {
                    part(side * .40, .11, .09, .025, .012, .80, 7);
                    part(side * .38, .11, -.40, .18, .10, .18, 10);
                    part(side * .38, .21, -.40, .12, .58, .12, 7, 0, 0, .25);
                }
                part(0, .11, -.42, .30, .16, .14, 10);
                part(0, .30, -.42, .14, .14, .14, 7);
                part(0, .64, -.42, .56, .06, .08, 10);
            } else if (style === 'aerie') {
                // Aerie: a perch, a straw nest and hay for the mounts.
                part(.34, .11, -.40, .07, .62, .07, 5);
                part(.34, .66, -.40, .36, .04, .05, 5);
                part(-.28, .11, -.40, .32, .12, .26, 13);
                for (let x of [-.34, -.22]) part(x, .23, -.40, .07, .08, .07, 6);
                part(.05, .11, -.445, .02, .52, .02, 5);
                part(.12, .44, -.445, .12, .16, .02, 0);
                for (let side of [-1, 1]) part(side * .43, .11, .43, .10, .08, .10, 13);
            } else if (style === 'builder_spawner') {
                // Builder yard: scaffolding, a crane with a hook, bricks.
                for (let side of [-1, 1]) part(side * .40, .11, -.40, .05, .70, .05, 5);
                part(0, .44, -.40, .86, .04, .06, 5);
                part(0, .78, -.40, .86, .04, .06, 5);
                part(.40, .81, -.40, .07, .16, .07, 1);
                part(.08, .95, -.40, .70, .045, .06, 1); // jib
                part(-.20, .64, -.40, .012, .31, .012, 1);
                part(-.20, .59, -.40, .07, .05, .04, 8); // hook
                part(-.28, .11, -.36, .24, .10, .14, 9); // bricks
                part(-.28, .21, -.36, .16, .08, .10, 9);
            } else if (style === 'salvager') {
                // Scrap yard: a heap of scrap and a grinder with a turning blade.
                part(-.26, .11, -.40, .34, .14, .22, 1);
                part(-.30, .25, -.41, .20, .10, .14, 10);
                part(-.18, .25, -.38, .08, .16, .06, 6);
                part(.26, .11, -.40, .24, .22, .18, 1); // grinder
                part(.26, .33, -.40, .16, .05, .12, 6);
            } else if (style === 'spawner') {
                // Woodcutter's yard (energy collectors): stacked logs, a
                // chopping block with an axe and a warm lantern.
                for (let row = 0; row < 3; row++) for (let k = 0; k < 3 - row; k++) {
                    part(-.26 + (k - (2 - row) / 2) * .10, .11 + row * .085, -.40, .09, .085, .26, 5);
                }
                part(.20, .11, -.38, .16, .12, .16, 5);
                part(.20, .23, -.38, .03, .18, .03, 5);
                part(.20, .34, -.34, .03, .07, .09, 6);
                part(.42, .11, -.42, .04, .52, .04, 1);
                part(.42, .60, -.42, .10, .10, .10, 8);
            } else if (style === 'astar_spawner') {
                // Miners' yard (A* collectors): a cart of ore on rails and
                // a rack of pickaxes.
                part(-.22, .11, -.38, .50, .015, .18, 5);
                part(-.22, .13, -.38, .30, .16, .18, 1);
                for (let side of [-1, 1]) part(-.22 + side * .10, .115, -.38, .05, .06, .20, 1);
                part(-.22, .29, -.38, .24, .07, .14, 6);
                part(-.26, .34, -.36, .05, .05, .05, 7);
                for (let k = 0; k < 3; k++) {
                    part(.20 + k * .09, .11, -.44, .02, .36, .02, 5);
                    part(.20 + k * .09, .45, -.44, .02, .04, .14, 6);
                }
            } else if (style === 'healer_spawner') {
                // Field hospital: a cot, a medicine shelf and a red cross sign.
                part(-.20, .11, -.38, .40, .10, .18, 5);
                part(-.20, .21, -.38, .38, .04, .16, 6);
                part(-.34, .25, -.38, .08, .05, .14, 6);
                part(.05, .11, -.44, .16, .32, .08, 5);
                part(.05, .20, -.40, .12, .04, .02, 9);
                part(.05, .30, -.40, .12, .04, .02, 3);
                part(.30, .11, -.44, .03, .40, .03, 5);
                part(.30, .40, -.43, .26, .24, .03, 6);
                part(.30, .49, -.41, .16, .05, .01, 9);
                part(.30, .435, -.41, .05, .16, .01, 9);
            } else if (style === 'research') {
                // Laboratory: a bookshelf and a telescope.
                part(-.28, .11, -.43, .34, .46, .10, 5);
                part(-.28, .20, -.375, .30, .10, .02, 0);
                part(-.28, .34, -.375, .30, .10, .02, 2);
                part(-.28, .48, -.375, .30, .06, .02, 9);
                part(.28, .11, -.40, .04, .36, .04, 1);
                part(.28, .46, -.36, .09, .09, .28, 1);
                part(.28, .47, -.215, .07, .07, .02, 3);
            }
        } else if (kind === 'mine') {
            // Resource tiles: the slab and 2D display as before, with ore at
            // the corners: glowing energy crystals, or A* rock with glints.
            part(0,.19,0,.91,.30,.91,0);
            panel(0,.50,0,.98,.98,true);
            let energy = weapon !== 'astar';
            for (let x of [-.40, .40]) for (let z of [-.40, .40]) {
                if (energy) {
                    part(x, .40, z, .10, .22, .10, 7, 0, 0, .25);
                    part(x - Math.sign(x) * .06, .40, z, .06, .14, .06, 7, 0, 0, .3);
                } else {
                    part(x, .40, z, .15, .12, .15, 10);
                    part(x, .52, z, .05, .05, .05, 6);
                }
            }
            for (let side of [-1, 1]) {
                if (energy) part(side * .46, .10, side * .12, .06, .26, .10, 7, 0, 0, .3);
                else part(side * .46, .10, side * .12, .08, .18, .14, 10);
            }
        } else {
            part(0, 0, 0, 1, .12, 1, 1);
            part(0, .12, 0, .84, .075, .84, 2);
            if (kind === 'tower') {
                let sub = variant.slice(6);
                part(0, .18, 0, .57, .49, .57, 0, 0, 0, .76);
                part(0, .67, 0, .80, .19, .70, 1);
                if (sub !== 'laser') {
                    part(0, .73, .31, .21, .14, .66, 2);
                    part(0, .745, .645, .12, .10, .015, 3);
                }
                panel(0, .88, 0, .94, .94, true, 0, 0, true);
                if (sub === 'twin') for (let side of [-1,1]) part(side*.22,.73,.34,.10,.12,.66,2);
                if (sub === 'sniper') part(0,.74,.56,.12,.10,.65,1);
                if (sub === 'energy') for (let side of [-1,1]) part(side*.27,.49,.10,.12,.21,.16,3);
                // Type details stay below the roof display.
                if (sub === 'fire') { part(0,.70,.30,.34,.16,.42,2,0,0,.7); part(0,.72,.52,.20,.08,.06,7); }
                if (sub === 'water') { part(0,.34,-.34,.46,.40,.20,0); for (let y of [.40,.62]) part(0,y,-.34,.50,.04,.24,2); }
                if (sub === 'ice') for (let side of [-1,1]) part(side*.36,.56,0,.14,.30,.14,7,0,0,.1);
                if (sub === 'poison') for (let side of [-1,1]) { part(side*.30,.30,-.22,.20,.34,.20,0); part(side*.30,.64,-.22,.22,.04,.22,2); }
                if (sub === 'sand') part(0,.46,-.30,.30,.30,.26,5,0,0,1.45);
                if (sub === 'elements') for (let x of [-.3,.3]) for (let z of [-.3,.3]) part(x,.60,z,.10,.10,.10,7);
                if (sub === 'watch') for (let side of [-1,1]) part(side*.34,.58,.18,.08,.22,.08,8);
                if (sub === 'laser') for (let x of [-.3,.3]) for (let z of [-.3,.3]) part(x,.56,z,.08,.30,.08,7,0,0,.3);
            } else if (kind === 'item') {
                if (weapon === 'house') {
                    // Walls and eaves stay below the roof panel, or they hide it.
                    part(0,.195,0,.78,.40,.72,0,0,0,.92); // walls
                    part(0,.52,0,.92,.10,.84,2); // eaves
                    part(0,.195,.375,.25,.30,.035,1); // front door
                    for (let side of [-1,1]) part(side*.25,.33,.37,.12,.10,.02,8); // lit windows
                    panel(0,.63,0,.86,.78,true,0,0,true);
                } else {
                    part(0, .20, 0, .69, .47, .69, 0, 0, 0, .8);
                    panel(0, .85, 0, .96, .96, true, 0, 0, true);
                    for (let side of [-1, 1]) part(side * .40, .22, 0, .09, .62, .72, 2);
                }
            }
        }

        // Large, low-poly equipment. Humanoid weapons share the dominant arm's
        // joint so the existing attack/work poses swing the complete silhouette.
        let handJoint = kind === 'bird' || kind === 'mole' ? 0 : -1;
        let handPivot = kind === 'bird' || kind === 'mole' ? 0 : .65;
        let equipmentYaw = humanoid ? Math.PI * .5 : 0;
        let wp = (x, y, z, sx, sy, sz, surface = 1, joint = handJoint, pivot = handPivot, taper = 1) =>
            part(x, y, z, sx, sy, sz, surface, joint, pivot, taper, equipmentYaw);
        if (kind === 'rider' || kind === 'pegasus') {
            // Mounted and floating roles carry their equipment in the body above.
        } else if (weapon === 'sword') {
            wp(.40,.25,.15,.07,.32,.07,1); wp(.40,.61,.15,.15,.58,.045,1,handJoint,handPivot,.25);
            wp(.40,.35,.15,.36,.07,.07,2);
        } else if (weapon === 'king_sword') {
            wp(.47,.32,.16,.10,.48,.08,2); wp(.47,.71,.16,.21,.66,.055,1,handJoint,handPivot,.18);
            wp(.47,.46,.16,.57,.09,.075,2); wp(.47,1.05,.16,.12,.12,.07,3,handJoint,handPivot,.05);
        } else if (weapon === 'dual_blades') {
            for (let side of [-1,1]) {
                let joint = -side;
                wp(side*.38,.29,.14,.055,.25,.055,2,joint,.65); wp(side*.38,.59,.14,.105,.46,.035,1,joint,.65,.18);
            }
        } else if (weapon === 'great_axe') {
            wp(.45,.37,.14,.09,.86,.075,5); wp(.45,.83,.14,.60,.25,.09,1); wp(.68,.83,.14,.20,.38,.055,1,handJoint,handPivot,.15);
        } else if (weapon === 'warhammer') {
            wp(.43,.34,.15,.11,.78,.08,5); wp(.43,.78,.15,.62,.25,.13,1); wp(.43,.78,.245,.30,.16,.055,2);
        } else if (/_staff$/.test(weapon) && kind === 'mage') {
            // Staff shaft, then an element-specific head (surface 7 glows).
            wp(.40,.06,.15,.06,1.02,.06,5);
            if (weapon === 'fire_staff') {
                wp(.40,1.06,.15,.17,.17,.17,7);
                for (let side of [-1,1]) wp(.40+side*.10,1.00,.15,.04,.20,.04,8,handJoint,handPivot,.2);
            } else if (weapon === 'water_staff') {
                wp(.40,1.04,.15,.14,.14,.14,7);
                for (let x of [.28,.40,.52]) wp(x,1.12,.15,.04,.16,.05,8,handJoint,handPivot,.15);
            } else if (weapon === 'ice_staff') {
                wp(.40,1.02,.15,.15,.34,.15,7,handJoint,handPivot,.05);
            } else if (weapon === 'poison_staff') {
                wp(.40,1.05,.15,.18,.15,.18,6);
                wp(.40,.99,.15,.11,.07,.11,7);
            } else {
                wp(.40,1.00,.15,.28,.28,.05,7,handJoint,handPivot,.2);
                wp(.40,1.10,.15,.08,.08,.08,3);
            }
        } else if (weapon === 'hammer') {
            wp(.40,.35,.13,.09,.70,.07,5); wp(.40,.73,.13,.55,.23,.11,1); wp(.40,.73,.21,.28,.13,.05,2);
        } else if (weapon === 'pickaxe' || weapon === 'axe') {
            // Tool heads are built along the hand's forward axis (z): the
            // yaw of `wp` turns a box, not its offset. Blades point away
            // from the shaft. A* collectors carry a pickaxe, energy an axe.
            let tool = (y, z, sy, sz, surface) => part(.40, y, z, .065, sy, sz, surface, handJoint, handPivot);
            wp(.40,.35,.13,.08,.75,.065,5);
            if (weapon === 'axe') {
                tool(.96, .13, .12, .10, 1); // eye around the top of the shaft
                tool(.945, .23, .15, .10, 1);
                tool(.925, .31, .19, .07, 1);
                tool(.905, .37, .23, .06, 6); // cutting edge, tallest and outermost
                tool(.98, .04, .08, .07, 1); // poll
            } else {
                tool(.97, .13, .10, .18, 1);
                for (let side of [-1, 1]) {
                    tool(.975, .13 + side * .16, .08, .14, 1);
                    tool(.965, .13 + side * .26, .06, .08, 6);
                    tool(.95, .13 + side * .32, .04, .05, 6); // points
                }
            }
        } else if (weapon === 'cutter') {
            wp(.40,.35,.14,.12,.47,.075,2); wp(.40,.65,.14,.44,.35,.075,1); wp(.40,.65,.19,.24,.23,.035,3);
        } else if (kind === 'wingworker' && weapon === 'healer_staff') {
            // A staff topped with a red cross and a medic bag on the hip.
            part(.34, .08, .12, .04, .80, .04, 5, -1, .62);
            part(.34, .84, .12, .058, .20, .058, 9, -1, .62);
            part(.34, .90, .12, .046, .062, .19, 9, -1, .62);
            part(-.31, .16, .06, .10, .14, .18, 6);
            part(-.31, .21, .152, .012, .06, .02, 9);
            part(-.31, .21, .152, .012, .02, .07, 9);
        } else if (kind === 'wingworker') {
            // A glowing sample flask and a notebook.
            part(.34, .24, .16, .13, .14, .13, 7, -1, .62);
            part(.34, .38, .16, .06, .06, .06, 6, -1, .62);
            part(.34, .44, .16, .08, .02, .08, 1, -1, .62);
            part(-.34, .22, .12, .05, .18, .15, 2, 1, .62);
            part(-.31, .225, .12, .02, .16, .13, 6, 1, .62);
        } else if (weapon === 'talons') {
            // Flying fighters carry slim forward blades on top of their wings.
            for (let side of [-1,1]) {
                let joint = side * 3;
                wp(side*.38,.51,.13,.12,.09,.66,2,joint,0); wp(side*.38,.51,.50,.08,.12,.28,1,joint,0,.08);
            }
        } else if (weapon === 'claws') {
            for (let side of [-1,1]) for (let claw of [-1,0,1]) wp(side*.38 + claw*.045,.05,.38,.035,.06,.38,6,0,0,.05);
        }
        // Separate face vertices keep the intentionally faceted silhouette.
        normals = computeNormals(positions, indices);
        return { positions, normals, indices: new Uint32Array(indices), uvs, details: new Float32Array(details) };
    }

    // Animation rig of a procedural kind (shader uniform).
    // Rigs 4-7 hover while idle: birds, winged horses (5), flying workers (6).
    const FIGURE_RIGS = { figure: 0, heavy: 0, knight: 0, ogre: 0, worker: 1, mage: 2, rider: 3, bird: 4, pegasus: 5,
        wingworker: 6, mole: 8, serpent: 9 };
    function figureRig(kind) {
        let rig = FIGURE_RIGS[kind.slice(0, kind.indexOf(':') < 0 ? kind.length : kind.indexOf(':'))];
        return rig === undefined ? 10 : rig;
    }

    // proceduralKind depends only on these four inputs; memoize it because it
    // runs (with several regex tests) for every object in every frame.
    const proceduralKindCache = new Map();
    const lodMeshKeys = new Map();
    // Figure detail level (0 full, 1 simplified, 2 far) from the on-screen
    // size in CSS pixels, with hysteresis around each threshold.
    function figureLodLevel(previous, pixels) {
        let level1 = previous >= 1 ? pixels < 27 : pixels < 24;
        if (!level1) return 0;
        return (previous >= 2 ? pixels < 13.5 : pixels < 12) ? 2 : 1;
    }
    if (typeof window !== 'undefined') window.figureLodLevel = figureLodLevel;
    function proceduralKind(object) {
        if (object.modelCandidates && object.modelCandidates.length) return null;
        let key = object.modelKey || '';
        let flags = (object.isFlying ? 1 : 0) | (object.isWorker ? 2 : 0);
        let byKey = proceduralKindCache.get(key);
        if (!byKey) {
            if (proceduralKindCache.size > 512) proceduralKindCache.clear();
            proceduralKindCache.set(key, byKey = new Map());
        }
        let weapon = String(object.weaponType || '');
        let slots = byKey.get(weapon);
        if (!slots) byKey.set(weapon, slots = [undefined, undefined, undefined, undefined]);
        let kind = slots[flags];
        if (kind === undefined) kind = slots[flags] = computeProceduralKind(key, weapon, !!object.isFlying, !!object.isWorker);
        return kind;
    }
    function computeProceduralKind(key, weaponType, isFlying, isWorker) {
        let object = { weaponType, isFlying, isWorker };
        if (key === 'unit_snake') return 'serpent:engine';
        if (key.startsWith('unit_')) {
            let weapon = String(object.weaponType || '');
            let type = key.slice(5);
            if (type === 'scout') return 'pegasus:bow';
            if (type === 'flying') return 'pegasus:lance';
            if (type === 'healer_unit') return 'wingworker:healer_staff';
            if (type === 'researcher_unit') return 'wingworker:research_orb';
            if (object.isFlying || /flying/.test(type)) return `bird:${weapon || 'talons'}`;
            if (type === 'mole') return `mole:${weapon || 'claws'}`;
            if (type === 'king') return `heavy:${weapon || 'king_sword'}`;
            if (/boss|giant/.test(type)) return `ogre:${weapon || 'great_axe'}`;
            if (/tank|heavy/.test(type)) return `knight:${weapon || 'warhammer'}`;
            if (type === 'fast') return 'rider:dual_blades';
            if (/_resistant$/.test(type)) return `mage:${/_staff$/.test(weapon) ? weapon : 'fire_staff'}`;
            if (object.isWorker || /builder|collect|salvag|heal|astar|research/.test(type)) return `worker:${weapon || 'hammer'}`;
            return `figure:${weapon || 'sword'}`;
        }
        if (key.startsWith('tower_cloud')) return 'portal';
        if (key.startsWith('tower_')) {
            let t = key.slice(6);
            return t === 'smg' ? 'tower:twin' : t === 'sniper' ? 'tower:sniper' : t === 'laser' ? 'tower:laser'
                : t === 'fire' ? 'tower:fire' : t === 'water' ? 'tower:water' : t === 'ice' ? 'tower:ice'
                : t === 'poison' ? 'tower:poison' : t === 'sand_gun' ? 'tower:sand' : t === 'elements' ? 'tower:elements'
                : t === 'watch_tower' ? 'tower:watch' : 'tower';
        }
        if (key.startsWith('barrack_')) {
            let unit = key.slice(8);
            if (unit === 'boss') return 'barrack:boss';
            if (unit === 'tank' || unit === 'king') return 'barrack:castle';
            if (/_resistant$/.test(unit)) return 'barrack:arcane';
            if (unit === 'flying' || unit === 'scout') return 'barrack:aerie';
            return 'barrack:rural';
        }
        if (key.startsWith('spawner_')) {
            let type = key.slice(8);
            return WORKSHOP_TYPES.has(type) ? `workshop:${type}` : 'workshop:builder_spawner';
        }
        if (key === 'item_house') return 'item:house';
        if (key === 'item_farm') return 'farm:energy';
        if (key === 'item_astar_farm') return 'farm:astar';
        if (key.startsWith('item_')) return /relay|cloud|energy/.test(key) ? 'item:relay' : 'item';
        if (key.includes('_mine_')) return key.startsWith('astar') ? 'mine:astar' : 'mine:energy';
        return null;
    }
    const WORKSHOP_TYPES = new Set(['spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research']);

    // Where barracks and worker yards show the unit in production: a small
    // miniature among the features along the back edge (model units of the
    // building model; y is the top of the furniture it stands on, or the
    // deck at .112), turned a little toward the yard's center.
    const WORKSHOP_MINIATURES = {
        rural: { x: -.01, y: .29, z: -.42, yaw: -.3 }, // on the smithy bench, by the anvil
        castle: { x: 0, y: .53, z: -.43, yaw: 0 }, // on the battlements above the gate
        boss: { x: -.17, y: .112, z: -.30, yaw: .3 }, // before the palisade
        arcane: { x: .22, y: .112, z: -.38, yaw: -.3 }, // beside the altar
        aerie: { x: .34, y: .70, z: -.40, yaw: -.3 }, // on the perch
        builder_spawner: { x: -.28, y: .29, z: -.36, yaw: .3 }, // on the brick stack
        salvager: { x: 0, y: .112, z: -.38, yaw: 0 }, // between the scrap and the grinder
        spawner: { x: -.26, y: .365, z: -.40, yaw: .3 }, // on the log pile
        astar_spawner: { x: .02, y: .112, z: -.38, yaw: 0 }, // between the cart and the rack
        healer_spawner: { x: .05, y: .43, z: -.44, yaw: 0 }, // on the medicine shelf
        research: { x: -.28, y: .57, z: -.43, yaw: .3 }, // on the bookshelf
        default: { x: 0, y: .112, z: -.30, yaw: 0 }
    };
    function workshopMiniature(modelKey) {
        let kind = proceduralKind({ modelKey });
        let style = kind && kind.includes(':') ? kind.split(':')[1] : '';
        return WORKSHOP_MINIATURES[style] || WORKSHOP_MINIATURES.default;
    }

    function createMesh(gl, positions, normals, indices, uvs) {
        let vertexCount = positions.length / 3;
        let vertexStride = uvs ? 8 : 6;
        let interleaved = new Float32Array(vertexCount * vertexStride);
        for (let i = 0; i < vertexCount; i++) {
            let dst = i * vertexStride;
            interleaved[dst] = positions[i * 3];
            interleaved[dst + 1] = positions[i * 3 + 1];
            interleaved[dst + 2] = positions[i * 3 + 2];
            interleaved[dst + 3] = normals[i * 3];
            interleaved[dst + 4] = normals[i * 3 + 1];
            interleaved[dst + 5] = normals[i * 3 + 2];
            if (uvs) {
                interleaved[dst + 6] = uvs[i * 2];
                interleaved[dst + 7] = uvs[i * 2 + 1];
            }
        }

        let vao = gl.createVertexArray();
        let vbo = gl.createBuffer();
        let ebo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        let strideBytes = vertexStride * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideBytes, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideBytes, 12);
        if (uvs) {
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, strideBytes, 24);
        }
        gl.bindVertexArray(null);
        let bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i++) {
            let axis = i % 3;
            bounds[axis] = Math.min(bounds[axis], positions[i]);
            bounds[axis + 3] = Math.max(bounds[axis + 3], positions[i]);
        }
        return { vao, indexCount: indices.length, hasUv: !!uvs, positions, indices, bounds, uvs };
    }

    function createCubeData() {
        let positions = new Float32Array([
            -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5,
            0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5,
            -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0.5, -0.5, 1, -0.5,
            0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5,
            -0.5, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5,
            -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5
        ]);
        let normals = new Float32Array([
            0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
            0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
            -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
            1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
            0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
            0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0
        ]);
        let indices = new Uint32Array([
            0, 1, 2, 0, 2, 3,
            4, 5, 6, 4, 6, 7,
            8, 9, 10, 8, 10, 11,
            12, 13, 14, 12, 14, 15,
            16, 17, 18, 16, 18, 19,
            20, 21, 22, 20, 22, 23
        ]);
        let uvs = new Float32Array([
            0, 1, 1, 1, 1, 0, 0, 0,
            0, 1, 1, 1, 1, 0, 0, 0,
            0, 1, 1, 1, 1, 0, 0, 0,
            0, 1, 1, 1, 1, 0, 0, 0,
            0, 1, 1, 1, 1, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0
        ]);
        return { positions, normals, indices, uvs };
    }

    function createPlaneData() {
        return {
            positions: new Float32Array([
                -0.5, 0, -0.5,
                0.5, 0, -0.5,
                0.5, 0, 0.5,
                -0.5, 0, 0.5
            ]),
            normals: new Float32Array([
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
                0, 1, 0
            ]),
            uvs: new Float32Array([
                0, 1,
                1, 1,
                1, 0,
                0, 0
            ]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3])
        };
    }

    function createCylinderData(segments = 20) {
        let ringSegments = Math.max(8, Math.floor(segments || 20));
        let positions = [];
        let normals = [];
        let uvs = [];
        let indices = [];

        for (let i = 0; i <= ringSegments; i++) {
            let t = i / ringSegments;
            let angle = t * Math.PI * 2;
            let cos = Math.cos(angle);
            let sin = Math.sin(angle);
            positions.push(cos * 0.5, 0, sin * 0.5);
            normals.push(cos, 0, sin);
            uvs.push(t, 1);
            positions.push(cos * 0.5, 1, sin * 0.5);
            normals.push(cos, 0, sin);
            uvs.push(t, 0);
        }

        for (let i = 0; i < ringSegments; i++) {
            let base = i * 2;
            indices.push(base, base + 1, base + 2);
            indices.push(base + 1, base + 3, base + 2);
        }

        let topCenterIndex = positions.length / 3;
        positions.push(0, 1, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 0.5);
        for (let i = 0; i <= ringSegments; i++) {
            let t = i / ringSegments;
            let angle = t * Math.PI * 2;
            let cos = Math.cos(angle);
            let sin = Math.sin(angle);
            positions.push(cos * 0.5, 1, sin * 0.5);
            normals.push(0, 1, 0);
            uvs.push(cos * 0.5 + 0.5, sin * 0.5 + 0.5);
        }
        for (let i = 0; i < ringSegments; i++) {
            let rimA = topCenterIndex + 1 + i;
            let rimB = topCenterIndex + 2 + i;
            indices.push(topCenterIndex, rimA, rimB);
        }

        let bottomCenterIndex = positions.length / 3;
        positions.push(0, 0, 0);
        normals.push(0, -1, 0);
        uvs.push(0, 0);
        for (let i = 0; i <= ringSegments; i++) {
            let t = i / ringSegments;
            let angle = t * Math.PI * 2;
            let cos = Math.cos(angle);
            let sin = Math.sin(angle);
            positions.push(cos * 0.5, 0, sin * 0.5);
            normals.push(0, -1, 0);
            uvs.push(0, 0);
        }
        for (let i = 0; i < ringSegments; i++) {
            let rimA = bottomCenterIndex + 1 + i;
            let rimB = bottomCenterIndex + 2 + i;
            indices.push(bottomCenterIndex, rimB, rimA);
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint32Array(indices)
        };
    }

    // The figure vertex shader's pose, for picking. Mirrors its joints,
    // rigs and animation modes (see the figure program).
    function poseFigureVertex(out, x, y, z, details, i, phase, move, mode, rig) {
        const surface = details[i * 4], joint = details[i * 4 + 1], pivot = details[i * 4 + 2];
        const pivotZ = surface === 4 ? 0 : details[i * 4 + 3];
        const aj = Math.abs(joint), sj = Math.sign(joint), ox = x, oy = y;
        let angle = 0;
        if (aj === 1) {
            angle = Math.sin(phase) * move * joint * .65;
            if (mode === 1) angle = Math.sin(phase) * 1.15;
            else if (mode === 2) angle = joint === -1 ? -.45 + Math.sin(phase) * 1.05 : Math.sin(phase + 1.4) * .18;
            else if (mode === 3) angle = Math.sin(phase + sj * 1.2) * .72;
            else if (mode === 4) angle = Math.sin(phase * 1.7) * (joint < 0 ? .72 : .22);
            else if (mode === 5) angle = (.28 + Math.sin(phase * .55) * .22) * sj;
            else if (mode === 6) angle = Math.sin(phase * .8 + (joint > 0 ? 0 : 1.8)) * .48;
            else if (mode === 7) angle = rig === 1 ? (pivot < .45 ? -1.35 * move : -.45 * move) : (pivot < .45 ? 0 : Math.sin(phase * .5 + sj) * .07 * move);
        } else if (joint === 2) {
            angle = Math.sin(phase + y * 3) * move * .10;
            if (mode === 1) angle = -Math.sin(phase) * .16;
            else if (mode >= 2 && mode <= 6) angle = 0;
            else if (mode === 7) angle = Math.sin(phase * .7 + y * 2) * .05 * move;
        } else if (aj === 4) {
            angle = mode === 1 ? Math.sin(phase) * .35 * sj : mode === 7 ? 0 : Math.sin(phase * 1.2) * move * sj * .75;
        } else if (joint === 5) {
            const t = Math.max(0, Math.min(1, (Math.sin(phase * .35) - .1) / .7));
            if (mode === 7) angle = (rig === 8 ? (.5 + .5 * Math.sin(phase * 3)) * .3 : t * t * (3 - 2 * t) * 1.05) * move;
            else if (mode === 1) angle = -Math.sin(phase) * .35;
            else angle = Math.sin(phase * 2) * .05 * move;
        }
        const py = y - pivot, pz = z - pivotZ;
        y = Math.cos(angle) * py - Math.sin(angle) * pz + pivot;
        z = Math.sin(angle) * py + Math.cos(angle) * pz + pivotZ;
        if (aj === 3) {
            const root = pivot > 0 ? pivot : .43;
            const scale = mode === 5 ? .72 : mode === 6 ? .34 : mode === 1 ? .8 : mode === 7 ? .3 : .48;
            const wing = Math.sin(phase) * sj * scale;
            x = Math.cos(wing) * ox - Math.sin(wing) * (oy - root);
            y = Math.sin(wing) * ox + Math.cos(wing) * (oy - root) + root;
        } else if (aj === 6) {
            const spin = phase * .8 * sj, px = x;
            x = Math.cos(spin) * px - Math.sin(spin) * z;
            z = Math.sin(spin) * px + Math.cos(spin) * z;
        }
        if (mode === 1) z += Math.sin(phase) * .16;
        if (mode === 2) y -= Math.max(0, Math.sin(phase)) * .035;
        if (mode === 5) y += (Math.sin(phase * .55) + 1) * .035;
        if (mode === 6) y += Math.sin(phase * .8 + ox * 2) * .018;
        if (mode === 7) {
            if (rig === 1) y -= .19 * move;
            else if (rig >= 4 && rig <= 7) y += Math.sin(phase) * .03;
            else y *= 1 + Math.sin(phase * .5) * .014 * move;
        } else y += Math.abs(Math.sin(phase)) * move * .018;
        out[0] = x; out[1] = y; out[2] = z;
    }

    // Floats per model instance: matrix (16), color, alpha, shape/move,
    // side angle/phase, side color, light and the panel's atlas layer.
    const INSTANCE_STRIDE = 28;

    // COLOR_ATTACHMENT0/1 and NONE; fixed WebGL2 enum values.
    const SCENE_DRAW_BUFFERS_COLOR = [0x8CE0, 0];
    const SCENE_DRAW_BUFFERS_WITH_DEPTH = [0x8CE0, 0x8CE1];
    const SHADOW_DRAW_BUFFERS = [0];

    class Defence3Renderer3D {
        constructor(options) {
            this.mount = options && options.mount;
            this.enabled = false;
            this.supported = true;
            this.pixelRatio = 1; // Updated with the viewport and display scale in resize().
            this.canvas = document.createElement('canvas');
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.display = 'none';
            this.canvas.setAttribute('aria-hidden', 'true');
            if (this.mount) this.mount.appendChild(this.canvas);

            this.gl = this.canvas.getContext('webgl2', {
                alpha: false,
                antialias: false, // The off-screen scene has its own MSAA target.
                depth: true,
                premultipliedAlpha: false,
                powerPreference: 'high-performance'
            });
            if (!this.gl) {
                this.supported = false;
                return;
            }

            let gl = this.gl;
            this.meshProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location = 0) in vec3 aPosition;
                layout(location = 1) in vec3 aNormal;
                uniform mat4 uViewProjection;
                uniform mat4 uModel;
                uniform mat3 uNormalMatrix;
                uniform float uAlpha;
                uniform float uLightLevel;
                out vec3 vNormal;
                out float vAlpha;
                out float vLightLevel;
                void main() {
                    gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
                    vNormal = normalize(uNormalMatrix * aNormal);
                    vAlpha = uAlpha;
                    vLightLevel = uLightLevel;
                }
            `, `#version 300 es
                precision highp float;
                in vec3 vNormal;
                in float vAlpha;
                in float vLightLevel;
                uniform vec3 uColor;
                ${CEL_LIGHTING_GLSL}
                layout(location = 0) out vec4 outColor;
                layout(location = 1) out vec4 outPackedDepth;
                vec4 packDepth(float depth) {
                    const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
                    const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
                    vec4 result = fract(depth * bitShift);
                    result -= result.xxyz * bitMask;
                    return result;
                }
                void main() {
                    vec3 lightDir = normalize(vec3(-0.42, 0.86, 0.31));
                    float diffuse = max(dot(normalize(vNormal), lightDir), 0.0);
                    float shade = celShade(diffuse);
                    float light = vLightLevel < 0.0 ? -vLightLevel - 1.0 : vLightLevel;
                    float memoryShade = vLightLevel < 0.0 ? mix(.55, 1.0, smoothstep(.14, .74, light)) : 1.0;
                    float fogAlpha = 1.0 - (1.0 - pow(1.0 - clamp(light, 0.0, 1.0), 1.3) * 0.42) * memoryShade;
                    outColor = vec4(uColor * shade * (1.0 - fogAlpha), vAlpha);
                    outPackedDepth = packDepth(gl_FragCoord.z);
                }
            `);
            this.instancedMeshProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location = 0) in vec3 aPosition;
                layout(location = 1) in vec3 aNormal;
                layout(location = 3) in vec4 iModelRow0;
                layout(location = 4) in vec4 iModelRow1;
                layout(location = 5) in vec4 iModelRow2;
                layout(location = 6) in vec4 iModelRow3;
                layout(location = 7) in vec3 iColor;
                layout(location = 8) in float iAlpha;
                layout(location = 9) in float iShape;
                layout(location = 10) in float iSideAngle;
                layout(location = 12) in float iLightLevel;
                uniform mat4 uViewProjection;
                // Unit layer drop shadows: offset back to the previous tick in
                // the matrix's constant slots (zero for other draws).
                uniform float uLayerAlpha;
                out vec3 vNormal;
                out vec3 vColor;
                out float vAlpha;
                out vec3 vLocalPosition;
                out float vShape;
                out float vLightLevel;
                void main() {
                    mat4 model = mat4(vec4(iModelRow0.x, 0.0, iModelRow0.z, 0.0), vec4(0.0, iModelRow1.y, 0.0, 0.0), vec4(iModelRow2.x, 0.0, iModelRow2.z, 0.0),
                        vec4(iModelRow3.xyz + vec3(iModelRow0.w, 0.0, iModelRow1.w) * (1.0 - uLayerAlpha), 1.0));
                    mat3 normalMatrix = mat3(model);
                    gl_Position = uViewProjection * model * vec4(aPosition, 1.0);
                    vNormal = normalize(normalMatrix * aNormal);
                    vColor = iColor;
                    vAlpha = iAlpha;
                    vLocalPosition = aPosition;
                    vShape = iShape;
                    vLightLevel = iLightLevel;
                }
            `, `#version 300 es
                precision highp float;
                in vec3 vNormal;
                in vec3 vColor;
                in float vAlpha;
                in vec3 vLocalPosition;
                in float vShape;
                in float vLightLevel;
                ${CEL_LIGHTING_GLSL}
                layout(location = 0) out vec4 outColor;
                layout(location = 1) out vec4 outPackedDepth;
                vec4 packDepth(float depth) {
                    const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
                    const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
                    vec4 result = fract(depth * bitShift);
                    result -= result.xxyz * bitMask;
                    return result;
                }
                void main() {
                    vec3 baseNormal = normalize(vNormal);
                    if (vShape > 0.5 && abs(baseNormal.y) > 0.5) {
                        vec2 radial = vLocalPosition.xz;
                        if (dot(radial, radial) > 0.25) discard;
                    }
                    vec3 surfaceNormal = baseNormal;
                    if (vShape > 0.5 && abs(surfaceNormal.y) < 0.5) {
                        vec2 radial = vLocalPosition.xz;
                        float radialLength = length(radial);
                        if (radialLength > 0.0001) {
                            surfaceNormal = normalize(vec3(radial.x / radialLength, 0.0, radial.y / radialLength));
                        }
                    }
                    vec3 lightDir = normalize(vec3(-0.42, 0.86, 0.31));
                    float diffuse = max(dot(surfaceNormal, lightDir), 0.0);
                    float shade = celShade(diffuse);
                    float light = vLightLevel < 0.0 ? -vLightLevel - 1.0 : vLightLevel;
                    float memoryShade = vLightLevel < 0.0 ? mix(.55, 1.0, smoothstep(.14, .74, light)) : 1.0;
                    float fogAlpha = 1.0 - (1.0 - pow(1.0 - clamp(light, 0.0, 1.0), 1.3) * 0.42) * memoryShade;
                    outColor = vec4(vColor * shade * (1.0 - fogAlpha), vAlpha);
                    outPackedDepth = packDepth(gl_FragCoord.z);
                }
            `);
            this.texturedCubeProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location = 0) in vec3 aPosition;
                layout(location = 1) in vec3 aNormal;
                layout(location = 2) in vec2 aUv;
                layout(location = 3) in vec4 iModelRow0;
                layout(location = 4) in vec4 iModelRow1;
                layout(location = 5) in vec4 iModelRow2;
                layout(location = 6) in vec4 iModelRow3;
                layout(location = 7) in vec3 iColor;
                layout(location = 8) in float iAlpha;
                layout(location = 9) in float iShape;
                layout(location = 10) in float iSideAngle;
                layout(location = 11) in vec3 iSideColor;
                layout(location = 12) in float iLightLevel;
                uniform mat4 uViewProjection;
                out vec3 vNormal;
                out vec3 vColor;
                out vec3 vSideColor;
                out vec2 vUv;
                out float vAlpha;
                out vec3 vLocalPosition;
                out float vShape;
                out float vSideAngle;
                out vec3 vLightingNormal;
                out float vLightLevel;
                const float TWO_PI = 6.28318530718;
                void main() {
                    mat4 model = mat4(iModelRow0, iModelRow1, iModelRow2, iModelRow3);
                    mat3 normalMatrix = mat3(model);
                    vec3 transformedNormal = normalize(normalMatrix * aNormal);
                    gl_Position = uViewProjection * model * vec4(aPosition, 1.0);
                    vNormal = transformedNormal;
                    vColor = iColor;
                    vSideColor = iSideColor;
                    vUv = aUv;
                    vAlpha = iAlpha;
                    vLocalPosition = aPosition;
                    vShape = iShape;
                    vSideAngle = iSideAngle;
                    vLightLevel = iLightLevel;
                    if (iShape > 0.5 && abs(aNormal.y) < 0.5) {
                        float phase = (aUv.x + (iSideAngle / TWO_PI)) * TWO_PI;
                        vLightingNormal = vec3(cos(phase), 0.0, sin(phase));
                    } else {
                        vLightingNormal = transformedNormal;
                    }
                }
            `, `#version 300 es
                precision highp float;
                in vec3 vNormal;
                in vec3 vColor;
                in vec3 vSideColor;
                in vec2 vUv;
                in float vAlpha;
                in vec3 vLocalPosition;
                in float vShape;
                in float vSideAngle;
                in vec3 vLightingNormal;
                in float vLightLevel;
                ${CEL_LIGHTING_GLSL}
                uniform sampler2D uTopTexture;
                uniform sampler2D uSideTexture;
                uniform float uHasSideTexture;
                layout(location = 0) out vec4 outColor;
                layout(location = 1) out vec4 outPackedDepth;
                const float TWO_PI = 6.28318530718;
                vec4 packDepth(float depth) {
                    const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
                    const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
                    vec4 result = fract(depth * bitShift);
                    result -= result.xxyz * bitMask;
                    return result;
                }
                void main() {
                    vec3 baseNormal = normalize(vNormal);
                    if (vShape > 0.5 && abs(baseNormal.y) > 0.5) {
                        vec2 radial = vLocalPosition.xz;
                        if (dot(radial, radial) > 0.25) discard;
                    }
                    vec3 surfaceNormal = normalize(vLightingNormal);
                    vec3 lightDir = normalize(vec3(-0.42, 0.86, 0.31));
                    float diffuse = max(dot(surfaceNormal, lightDir), 0.0);
                    float shade = celShade(diffuse);
                    vec3 playerSideColor = vColor * shade;
                    vec3 functionalSideColor = vSideColor * shade;
                    vec2 topUv = vec2(vUv.x, 1.0 - vUv.y);
                    vec4 topSample = texture(uTopTexture, topUv);
                    bool topFace = surfaceNormal.y > 0.8;
                    vec2 sideUv = topUv;
                    if (vShape > 0.5) {
                        sideUv.x = fract(sideUv.x + (vSideAngle / TWO_PI));
                    }
                    vec4 sideSample = uHasSideTexture > 0.5 ? texture(uSideTexture, sideUv) : vec4(0.0);
                    vec3 finalColor = functionalSideColor;
                    if (topFace) {
                        finalColor = mix(playerSideColor, topSample.rgb * shade, clamp(topSample.a, 0.0, 1.0));
                    } else if (uHasSideTexture > 0.5) {
                        float overlayAlpha = step(0.5, sideSample.a);
                        float edgeDistance = min(min(sideUv.x, 1.0 - sideUv.x), min(sideUv.y, 1.0 - sideUv.y));
                        float seamFactor = 1.0 - smoothstep(0.015, 0.08, edgeDistance);
                        vec3 playerHuedOverlay = mix(sideSample.rgb, playerSideColor, 0.35);
                        vec3 seamTintedOverlay = mix(sideSample.rgb * shade, playerHuedOverlay, seamFactor);
                        finalColor = mix(functionalSideColor, seamTintedOverlay, overlayAlpha);
                    }
                    float light = vLightLevel < 0.0 ? -vLightLevel - 1.0 : vLightLevel;
                    float memoryShade = vLightLevel < 0.0 ? mix(.55, 1.0, smoothstep(.14, .74, light)) : 1.0;
                    float fogAlpha = 1.0 - (1.0 - pow(1.0 - clamp(light, 0.0, 1.0), 1.3) * 0.42) * memoryShade;
                    // Pixel-sized edges within the existing material pass.
                    if (vShape < 0.5) finalColor = mix(finalColor, vec3(.025,.035,.055), faceInk(vUv, .8) * .8);
                    finalColor *= (1.0 - fogAlpha);
                    outColor = vec4(finalColor, vAlpha);
                    outPackedDepth = packDepth(gl_FragCoord.z);
                }
            `);
            this.planeProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location = 0) in vec3 aPosition;
                layout(location = 1) in vec3 aNormal;
                layout(location = 2) in vec2 aUv;
                uniform mat4 uViewProjection;
                uniform mat4 uModel;
                out vec2 vUv;
                void main() {
                    gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
                    vUv = aUv;
                }
            `, `#version 300 es
                precision highp float;
                in vec2 vUv;
                uniform sampler2D uTexture;
                uniform sampler2D uFog;
                uniform bool uHasFog;
                layout(location = 0) out vec4 outColor;
                layout(location = 1) out vec4 outPackedDepth;
                vec4 packDepth(float depth) {
                    const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
                    const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
                    vec4 result = fract(depth * bitShift);
                    result -= result.xxyz * bitMask;
                    return result;
                }
                void main() {
                    outColor = texture(uTexture, vUv);
                    if (uHasFog) {
                        vec4 fog = texture(uFog, vUv);
                        outColor = vec4(mix(outColor.rgb, fog.rgb, fog.a), 1.0);
                    }
                    outPackedDepth = packDepth(gl_FragCoord.z);
                }
            `);
            this.presentProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location = 0) in vec2 aPosition;
                out vec2 vUv;
                void main() {
                    vUv = aPosition * 0.5 + 0.5;
                    gl_Position = vec4(aPosition, 0.0, 1.0);
                }
            `, `#version 300 es
                precision highp float;
                in vec2 vUv;
                uniform sampler2D uTexture;
                uniform bool uPackDepth;
                out vec4 outColor;
                void main() {
                    vec4 sampleColor = texture(uTexture, vUv);
                    if (uPackDepth) {
                        vec4 depth = fract(min(sampleColor.r, .99999994) * vec4(16777216.0,65536.0,256.0,1.0));
                        outColor = depth - depth.xxyz * vec4(0.0,1.0/256.0,1.0/256.0,1.0/256.0);
                    } else outColor = sampleColor;
                }
            `);

            this.meshUniforms = {
                viewProjection: gl.getUniformLocation(this.meshProgram, 'uViewProjection'),
                model: gl.getUniformLocation(this.meshProgram, 'uModel'),
                normalMatrix: gl.getUniformLocation(this.meshProgram, 'uNormalMatrix'),
                color: gl.getUniformLocation(this.meshProgram, 'uColor'),
                alpha: gl.getUniformLocation(this.meshProgram, 'uAlpha'),
                lightLevel: gl.getUniformLocation(this.meshProgram, 'uLightLevel')
            };
            this.instancedMeshUniforms = {
                viewProjection: gl.getUniformLocation(this.instancedMeshProgram, 'uViewProjection'),
                layerAlpha: gl.getUniformLocation(this.instancedMeshProgram, 'uLayerAlpha')
            };
            this.texturedCubeUniforms = {
                viewProjection: gl.getUniformLocation(this.texturedCubeProgram, 'uViewProjection'),
                topTexture: gl.getUniformLocation(this.texturedCubeProgram, 'uTopTexture'),
                sideTexture: gl.getUniformLocation(this.texturedCubeProgram, 'uSideTexture'),
                hasSideTexture: gl.getUniformLocation(this.texturedCubeProgram, 'uHasSideTexture')
            };
            this.planeUniforms = {
                viewProjection: gl.getUniformLocation(this.planeProgram, 'uViewProjection'),
                model: gl.getUniformLocation(this.planeProgram, 'uModel'),
                texture: gl.getUniformLocation(this.planeProgram, 'uTexture'),
                fog: gl.getUniformLocation(this.planeProgram, 'uFog'),
                hasFog: gl.getUniformLocation(this.planeProgram, 'uHasFog')
            };
            this.presentUniforms = {
                packDepth: gl.getUniformLocation(this.presentProgram, 'uPackDepth'),
                texture: gl.getUniformLocation(this.presentProgram, 'uTexture')
            };

            let cubeData = createCubeData();
            this.cubeMesh = createMesh(gl, cubeData.positions, cubeData.normals, cubeData.indices, cubeData.uvs);
            let cylinderData = createCylinderData(16);
            this.cylinderMesh = createMesh(gl, cylinderData.positions, cylinderData.normals, cylinderData.indices, cylinderData.uvs);
            let planeData = createPlaneData();
            this.planeMesh = createMesh(gl, planeData.positions, planeData.normals, planeData.indices, planeData.uvs);
            this.backgroundTexture = createTexture(gl);
            this.backgroundTextureSize = { width: 0, height: 0 };
            this.backgroundTextureVersion = -1;
            this.fogTexture = createTexture(gl);
            this.fogTextureVersion = -1;
            this.fogTextureSize = { width: 0, height: 0 };
            this.topTextureCache = new Map();
            this.overlayDepthCache = new Map();
            this.overlayDepthFrame = null;
            this.meshCache = new Map();
            this.modelRequests = new Map();
            this.cubeInstanceBuffer = gl.createBuffer();
            this.cubeInstanceCapacity = 0;
            this.cubeInstanceArray = null;
            this.tmpProjection = new Float32Array(16);
            this.tmpView = new Float32Array(16);
            this.tmpViewProjection = new Float32Array(16);
            this.tmpInverseViewProjection = new Float32Array(16);
            this.tmpModel = new Float32Array(16);
            this.tmpNormal = new Float32Array(9);
            this.cssWidth = 1;
            this.cssHeight = 1;
            // Overscan (css px on each side, from snapshot.viewPad): the
            // canvas is that much larger than the view and sits that much
            // up-left of it, so the page can slide it during a pan without
            // exposing an edge. Screen coordinates in and out of the public
            // methods stay relative to the view; "canvas" ones include it.
            this.viewPad = 0;
            this.pickViewPad = 0;
            this.orbitYaw = 0;
            this.orbitPitch = 0.92;
            this.sceneFramebuffer = gl.createFramebuffer();
            // Use a shared sample count supported by both color and depth formats.
            let colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
            let depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
            this.supportedSceneSamples = Array.from(colorSamples).filter(n => n > 1 && n <= 4 && depthSamples.includes(n)).sort((a,b) => a-b)[0] || 0;
            this.sceneSamples = this.supportedSceneSamples;
            this.graphicsOptions = typeof normalizeGraphicsOptions === 'function' ? normalizeGraphicsOptions(null) : null;
            this.postProcess = window.Defence3PostProcess ? new window.Defence3PostProcess(gl) : null;
            this.msaaFramebuffer = gl.createFramebuffer();
            this.msaaBuffers = [gl.createRenderbuffer(), gl.createRenderbuffer(), gl.createRenderbuffer()];
            this.depthPackFramebuffer = gl.createFramebuffer();
            this.textureAnisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
            this.sceneColorTexture = gl.createTexture();
            this.sceneDepthColorTexture = gl.createTexture();
            this.sceneDepthTexture = gl.createTexture();
            this.presentVao = gl.createVertexArray();
            this.presentBuffer = gl.createBuffer();
            this.sceneTargetSize = { width: 0, height: 0 };

            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.disable(gl.CULL_FACE);
            gl.clearColor(0.03, 0.05, 0.08, 1);

            gl.bindTexture(gl.TEXTURE_2D, this.sceneColorTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthColorTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);

            gl.bindVertexArray(this.presentVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.presentBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1,
                1, -1,
                -1, 1,
                1, 1
            ]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);

            let bindInstanceAttributes = (mesh) => {
                mesh.instanceBase = 0;
                mesh.instanceBuffer = this.cubeInstanceBuffer;
                gl.bindVertexArray(mesh.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
                let instanceStrideBytes = INSTANCE_STRIDE * 4;
                for (let row = 0; row < 4; row++) {
                    let location = 3 + row;
                    gl.enableVertexAttribArray(location);
                    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, instanceStrideBytes, row * 16);
                    gl.vertexAttribDivisor(location, 1);
                }
                gl.enableVertexAttribArray(7);
                gl.vertexAttribPointer(7, 3, gl.FLOAT, false, instanceStrideBytes, 64);
                gl.vertexAttribDivisor(7, 1);
                gl.enableVertexAttribArray(8);
                gl.vertexAttribPointer(8, 1, gl.FLOAT, false, instanceStrideBytes, 76);
                gl.vertexAttribDivisor(8, 1);
                gl.enableVertexAttribArray(9);
                gl.vertexAttribPointer(9, 1, gl.FLOAT, false, instanceStrideBytes, 80);
                gl.vertexAttribDivisor(9, 1);
                gl.enableVertexAttribArray(10);
                gl.vertexAttribPointer(10, 1, gl.FLOAT, false, instanceStrideBytes, 84);
                gl.vertexAttribDivisor(10, 1);
                gl.enableVertexAttribArray(11);
                gl.vertexAttribPointer(11, 3, gl.FLOAT, false, instanceStrideBytes, 88);
                gl.vertexAttribDivisor(11, 1);
                gl.enableVertexAttribArray(12);
                gl.vertexAttribPointer(12, 1, gl.FLOAT, false, instanceStrideBytes, 100);
                gl.vertexAttribDivisor(12, 1);
                gl.enableVertexAttribArray(14);
                gl.vertexAttribPointer(14, 1, gl.FLOAT, false, instanceStrideBytes, 104);
                gl.vertexAttribDivisor(14, 1);
                gl.enableVertexAttribArray(15);
                gl.vertexAttribPointer(15, 1, gl.FLOAT, false, instanceStrideBytes, 108);
                gl.vertexAttribDivisor(15, 1);
                gl.bindVertexArray(null);
            };
            bindInstanceAttributes(this.cubeMesh);
            bindInstanceAttributes(this.cylinderMesh);
            this.bindFigureInstanceAttributes = bindInstanceAttributes;
            this.figureMeshes = new Map();
            // Common kinds up front; any other combination is built on first use.
            for (let kind of [
                'figure:sword', 'rider:dual_blades', 'mage:fire_staff', 'mage:water_staff', 'mage:ice_staff', 'mage:poison_staff', 'mage:laser_staff',
                'heavy:king_sword', 'ogre:great_axe', 'knight:warhammer',
                'worker:hammer', 'worker:pickaxe', 'worker:axe', 'worker:cutter', 'wingworker:healer_staff', 'wingworker:research_orb',
                'pegasus:bow', 'pegasus:lance', 'mole:claws', 'serpent:engine',
                'tower', 'tower:twin', 'tower:sniper', 'tower:laser', 'tower:fire', 'tower:water', 'tower:ice', 'tower:poison', 'tower:sand',
                'tower:elements', 'tower:watch', 'portal', 'barrack:rural', 'barrack:castle', 'barrack:boss', 'barrack:arcane', 'barrack:aerie',
                'workshop:spawner', 'workshop:astar_spawner', 'workshop:salvager', 'workshop:builder_spawner', 'workshop:healer_spawner',
                'workshop:research', 'item', 'item:relay', 'item:house', 'farm:energy', 'farm:astar', 'mine:energy', 'mine:astar'
            ]) {
                this.getFigureMesh(kind);
                this.getFigureMesh(kind + ':lod');
            }
            gl.bindVertexArray(null);
            this.figureProgram = createProgram(gl, `#version 300 es
                precision highp float;
                layout(location=0) in vec3 aPosition;
                layout(location=1) in vec3 aNormal;
                layout(location=2) in vec2 aUv;
                layout(location=3) in vec4 m0;
                layout(location=4) in vec4 m1;
                layout(location=5) in vec4 m2;
                layout(location=6) in vec4 m3;
                layout(location=7) in vec3 color;
                layout(location=8) in float alpha;
                layout(location=9) in float moveAmount;
                layout(location=10) in float phaseIn;
                layout(location=11) in vec3 trim;
                layout(location=12) in float light;
                layout(location=13) in vec4 detail;
                layout(location=14) in float atlasLayer;
                layout(location=15) in float statusLayer;
                uniform mat4 uViewProjection;
                uniform float uAnimationMode;
                uniform float uRig;
                uniform float uTime;
                // Unit layer (see drawUnitLayer): tick interpolation factor and
                // the flyer bob's time.
                uniform float uLayerAlpha;
                uniform float uFlyTime;
                out vec3 vNormal;
                out vec3 vColor;
                out vec3 vTrim;
                out vec2 vUv;
                out float vAlpha;
                out float vLight;
                flat out int vSurface;
                flat out float vLayer;
                flat out float vStatusLayer;
                void main() {
                    vec3 p = aPosition, n = aNormal;
                    // Instance matrices are yaw + scale; their constant slots
                    // carry the unit layer's data (zero for other draws):
                    // offset back to the previous tick (m0.w, m1.w), walk phase
                    // rate (m2.w), flyer bob seed and flag (m1.x, m1.z).
                    float phase = phaseIn + m2.w * uLayerAlpha;
                    float animationMode = floor(uAnimationMode + .5);
                    float rig = floor(uRig + .5);
                    float joint = detail.y, aj = abs(joint), sj = sign(joint), pivot = detail.z;
                    // In idle mode 7 moveAmount is how far the idle pose has settled.
                    float blend = moveAmount;
                    float angle = 0.0;
                    if (aj == 1.0) {
                        angle = sin(phase) * moveAmount * joint * .65;
                        if (animationMode == 1.0) {
                            // One-shot attack: both arms drive forward while the cape follows through.
                            angle = sin(phase) * 1.15;
                        } else if (animationMode == 2.0) {
                            // Builder: dominant tool arm makes a broad hammering arc.
                            angle = joint == -1.0 ? (-.45 + sin(phase) * 1.05) : sin(phase + 1.4) * .18;
                        } else if (animationMode == 3.0) {
                            // Collectors scoop inward with alternating arms.
                            angle = sin(phase + sj * 1.2) * .72;
                        } else if (animationMode == 4.0) {
                            // Salvager: short, fast cutting strokes.
                            angle = sin(phase * 1.7) * (joint < 0.0 ? .72 : .22);
                        } else if (animationMode == 5.0) {
                            // Healer: wings and limbs open in a slow restorative pulse.
                            angle = (.28 + sin(phase * .55) * .22) * sj;
                        } else if (animationMode == 6.0) {
                            // Researcher: asymmetric instrument-tuning motion.
                            angle = sin(phase * .8 + (joint > 0.0 ? 0.0 : 1.8)) * .48;
                        } else if (animationMode == 7.0) {
                            // Idle: workers sit down (legs forward, hands on knees);
                            // everyone else lets the arms hang and sway a little.
                            if (rig == 1.0) angle = pivot < .45 ? -1.35 * blend : -.45 * blend;
                            else angle = pivot < .45 ? 0.0 : sin(phase * .5 + sj) * .07 * blend;
                        }
                    } else if (joint == 2.0) {
                        angle = sin(phase + aPosition.y * 3.0) * moveAmount * .10;
                        if (animationMode == 1.0) angle = -sin(phase) * .16;
                        else if (animationMode >= 2.0 && animationMode <= 6.0) angle = 0.0;
                        else if (animationMode == 7.0) angle = sin(phase * .7 + aPosition.y * 2.0) * .05 * blend;
                    } else if (aj == 4.0) {
                        // Quadruped legs: diagonal pairs trot; a short rear on attack.
                        angle = animationMode == 1.0 ? sin(phase) * .35 * sj
                            : animationMode == 7.0 ? 0.0 : sin(phase * 1.2) * moveAmount * sj * .75;
                    } else if (joint == 5.0) {
                        // Neck: grazing (or sniffing) while idle, tossed back on attack.
                        if (animationMode == 7.0) angle = (rig == 8.0 ? (.5 + .5 * sin(phase * 3.0)) * .3 : smoothstep(.1, .8, sin(phase * .35)) * 1.05) * blend;
                        else if (animationMode == 1.0) angle = -sin(phase) * .35;
                        else angle = sin(phase * 2.0) * .05 * moveAmount;
                    }
                    float c = cos(angle), s = sin(angle);
                    p.y -= pivot; p.z -= detail.x == 4.0 ? 0.0 : detail.w;
                    p.yz = mat2(c, s, -s, c) * p.yz;
                    p.y += pivot; p.z += detail.x == 4.0 ? 0.0 : detail.w;
                    n.yz = mat2(c, s, -s, c) * n.yz;
                    if (aj == 3.0) {
                        // Wings flap even while hovering; each rotates at its root.
                        p = aPosition; n = aNormal;
                        float root = pivot > 0.0 ? pivot : .43;
                        float wingScale = animationMode == 5.0 ? .72 : (animationMode == 6.0 ? .34 : (animationMode == 1.0 ? .8 : (animationMode == 7.0 ? .3 : .48)));
                        float wing = sin(phase) * sj * wingScale;
                        float wc = cos(wing), ws = sin(wing);
                        p.y -= root;
                        p.xy = mat2(wc,ws,-ws,wc) * p.xy;
                        p.y += root;
                        n.xy = mat2(wc,ws,-ws,wc) * n.xy;
                    } else if (aj == 6.0) {
                        // Instrument rings turn about the vertical axis, in opposite senses.
                        float spin = phase * .8 * sj;
                        float rc = cos(spin), rs = sin(spin);
                        p.xz = mat2(rc, rs, -rs, rc) * p.xz;
                        n.xz = mat2(rc, rs, -rs, rc) * n.xz;
                    } else if (aj == 7.0) {
                        // Structure parts turning in their own (xy) plane about
                        // (0, pivot) over time: portal swirls, saw blades, orbs.
                        // detail.w adds to the speed.
                        float spin = uTime * (.6 + detail.w) * sj;
                        float rc = cos(spin), rs = sin(spin);
                        p = aPosition; n = aNormal;
                        p.y -= pivot;
                        p.xy = mat2(rc, rs, -rs, rc) * p.xy;
                        p.y += pivot;
                        n.xy = mat2(rc, rs, -rs, rc) * n.xy;
                    }
                    if (animationMode == 1.0) p.z += sin(phase) * .16;
                    if (animationMode == 2.0) p.y -= max(0.0, sin(phase)) * .035;
                    if (animationMode == 5.0) p.y += (sin(phase * .55) + 1.0) * .035;
                    if (animationMode == 6.0) p.y += sin(phase * .8 + aPosition.x * 2.0) * .018;
                    if (animationMode == 7.0) {
                        if (rig == 1.0) p.y -= .19 * blend;
                        else if (rig >= 4.0 && rig <= 7.0) p.y += sin(phase) * .03;
                        else p.y *= 1.0 + sin(phase * .5) * .014 * blend;
                    } else {
                        p.y += abs(sin(phase)) * moveAmount * .018;
                    }
                    vec3 layerOffset = vec3(m0.w, 0.0, m1.w) * (1.0 - uLayerAlpha);
                    if (m1.z > .5) layerOffset.y += sin(uFlyTime * 2.2 + m1.x) * .035 - (animationMode == 1.0 ? sin(phase) * .22 : 0.0);
                    mat4 model = mat4(vec4(m0.x, 0.0, m0.z, 0.0), vec4(0.0, m1.y, 0.0, 0.0), vec4(m2.x, 0.0, m2.z, 0.0), vec4(m3.xyz + layerOffset, 1.0));
                    if (detail.x == 4.0 && detail.w > .5) {
                        // Keep the entire HUD rectangle world-aligned. Rotating only
                        // its UVs would crop the level/health text at oblique angles.
                        vec2 facing = normalize(m0.xz);
                        mat2 undoYaw = mat2(facing.x,-facing.y,facing.y,facing.x);
                        p.xz = undoYaw * p.xz;
                        n.xz = undoYaw * n.xz;
                    }
                    // Inverse scale gives correct lighting even while a building squashes.
                    vec3 scale2 = vec3(dot(m0.xyz,m0.xyz), dot(m1.xyz,m1.xyz), dot(m2.xyz,m2.xyz));
                    vNormal = normalize(mat3(model) * (n / max(scale2, vec3(.00001))));
                    vec4 world = model * vec4(p, 1);
                    // A squashed structure (unit on its tile) packs the roof and
                    // its 2D panel into a sliver; lift the panel so it is not lost
                    // to depth fighting with the roof below.
                    if (detail.x == 4.0 && aNormal.y > .5) world.y += .02 * (1.0 - clamp(sqrt(scale2.y), 0.0, 1.0));
                    gl_Position = uViewProjection * world;
                    vColor = color; vTrim = trim; vUv = aUv;
                    vAlpha = alpha; vLight = light; vSurface = int(detail.x + .5); vLayer = atlasLayer; vStatusLayer = statusLayer;
                }
            `, `#version 300 es
                precision highp float;
                in vec3 vNormal;
                in vec3 vColor;
                in vec3 vTrim;
                in vec2 vUv;
                in float vAlpha;
                in float vLight;
                flat in int vSurface;
                flat in float vLayer;
                flat in float vStatusLayer;
                uniform float uIsUnit;
                uniform float uIsFlying;
                uniform float uSpriteLodBias;
                ${CEL_LIGHTING_GLSL}
                uniform sampler2D uTopTexture;
                uniform highp sampler2DArray uAtlas;
                uniform float uUseAtlas;
                uniform sampler2D uSideTexture;
                uniform float uHasSideTexture;
                layout(location=0) out vec4 outColor;
                layout(location=1) out vec4 outPackedDepth;
                void main() {
                    // vTrim is the functional color used by the 2D sprite (farm
                    // yellow, builder green, etc.); vColor identifies the owner.
                    // Lift dark palettes without replacing their hue with white.
                    float peak = max(vTrim.r, max(vTrim.g, vTrim.b));
                    vec3 typeColor = vTrim * max(1.0, .62 / max(peak, .01));
                    // Keep 2D's type colors on the body and owner colors on trim.
                    vec3 base = typeColor;
                    if (vSurface == 1) base = mix(mix(vec3(.055,.065,.08), typeColor, .12), mix(vec3(.76,.84,.92), typeColor, .20), uIsFlying);
                    else if (vSurface == 2) base = vColor;
                    else if (vSurface == 3) base = vec3(.48,.94,1.0);
                    else if (vSurface == 5) base = vec3(.42,.29,.18);
                    else if (vSurface == 6) base = vec3(.88,.86,.80);
                    else if (vSurface == 7) base = min(vec3(1.0), typeColor * 1.3 + .1);
                    else if (vSurface == 8) base = vec3(.96,.74,.24);
                    else if (vSurface == 9) base = vec3(.88,.18,.20);
                    else if (vSurface == 10) base = vec3(.44,.45,.49); // stone
                    else if (vSurface == 11) base = vec3(.24,.54,.22); // leaves
                    else if (vSurface == 12) base = vec3(.035,.02,.06); // void (unlit)
                    else if (vSurface == 13) base = vec3(.80,.67,.36); // straw
                    else if (vSurface == 14) base = vec3(.19,.20,.23); // dark gray
                    bool glowing = vSurface == 3 || vSurface == 4 || vSurface == 7 || vSurface == 12 || vSurface == 15;
                    if (vSurface == 15) {
                        // Status icon (sprite atlas layer, or none) over the owner color.
                        base = vColor;
                        if (vStatusLayer >= 0.0) {
                            vec4 icon = texture(uAtlas, vec3(vUv, vStatusLayer), uSpriteLodBias);
                            base = mix(base, icon.rgb, icon.a);
                        }
                    } else if (vSurface == 4) {
                        // Preserve thin sprite strokes without disabling distant mipmaps.
                        // Exact 2D panels come from the shared sprite atlas (one
                        // draw for every panel); uUseAtlas is uniform per draw.
                        vec4 texel = uUseAtlas > .5 ? texture(uAtlas, vec3(vUv, vLayer), uSpriteLodBias) : texture(uTopTexture, vUv, uSpriteLodBias);
                        // Transparent sprite padding must not turn into a pale plaque.
                        if (texel.a < .1) discard;
                        base = mix(vec3(.055,.065,.08), texel.rgb, texel.a);
                    }
                    float diffuse = max(dot(normalize(vNormal), normalize(vec3(-.42,.86,.31))),0.0);
                    float shade = glowing ? 1.0 : mix(.72, 1.0, celShade(diffuse));
                    vec3 shaded = base * shade;
                    if (!glowing) {
                        shaded *= mix(.86, 1.0, uIsUnit);
                        shaded = mix(shaded, vec3(.025,.035,.055), faceInk(vUv, mix(.65, 1.05, uIsUnit)) * .88);
                    }
                    float light = vLight < 0.0 ? -vLight - 1.0 : vLight;
                    float memoryShade = vLight < 0.0 ? mix(.55, 1.0, smoothstep(.14, .74, light)) : 1.0;
                    float fog = (1.0 - pow(1.0-clamp(light,0.0,1.0),1.3)*.42) * memoryShade;
                    outColor = vec4(shaded * fog,vAlpha);
                    vec4 depth = fract(gl_FragCoord.z * vec4(16777216.0,65536.0,256.0,1.0));
                    outPackedDepth = depth - depth.xxyz * vec4(0.0,1.0/256.0,1.0/256.0,1.0/256.0);
                }
            `);
            this.figureUniforms = {
                spriteLodBias: gl.getUniformLocation(this.figureProgram, 'uSpriteLodBias'),
                animationMode: gl.getUniformLocation(this.figureProgram, 'uAnimationMode'),
                rig: gl.getUniformLocation(this.figureProgram, 'uRig'),
                time: gl.getUniformLocation(this.figureProgram, 'uTime'),
                layerAlpha: gl.getUniformLocation(this.figureProgram, 'uLayerAlpha'),
                flyTime: gl.getUniformLocation(this.figureProgram, 'uFlyTime'),
                isFlying: gl.getUniformLocation(this.figureProgram, 'uIsFlying'),
                isUnit: gl.getUniformLocation(this.figureProgram, 'uIsUnit'),
                viewProjection: gl.getUniformLocation(this.figureProgram, 'uViewProjection'),
                topTexture: gl.getUniformLocation(this.figureProgram, 'uTopTexture'),
                atlas: gl.getUniformLocation(this.figureProgram, 'uAtlas'),
                useAtlas: gl.getUniformLocation(this.figureProgram, 'uUseAtlas'),
                sideTexture: gl.getUniformLocation(this.figureProgram, 'uSideTexture'),
                hasSideTexture: gl.getUniformLocation(this.figureProgram, 'uHasSideTexture')
            };
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        getFigureMesh(key) {
            let mesh = this.figureMeshes.get(key);
            if (mesh) return mesh;
            let gl = this.gl;
            let simplified = key.endsWith(':lod') ? 1 : key.endsWith(':lod2') ? 2 : 0;
            let data = createFigureData(simplified ? key.slice(0, key.lastIndexOf(':lod')) : key, simplified);
            mesh = createMesh(gl, data.positions, data.normals, data.indices, data.uvs);
            mesh.details = data.details;
            mesh.rig = figureRig(key);
            this.bindFigureInstanceAttributes(mesh);
            gl.bindVertexArray(mesh.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, data.details, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(13);
            gl.vertexAttribPointer(13, 4, gl.FLOAT, false, 16, 0);
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            this.figureMeshes.set(key, mesh);
            return mesh;
        }

        getFigureMeshKey(object) {
            // The kind follows fields fixed for an object's life (model,
            // weapon, flags); objects are reused between frames.
            let kind = object._r3dKind;
            if (kind === undefined || object._r3dKindModel !== object.modelKey || object._r3dKindWeapon !== object.weaponType) {
                kind = object._r3dKind = proceduralKind(object);
                object._r3dKindModel = object.modelKey;
                object._r3dKindWeapon = object.weaponType;
            }
            if (!kind) return null;
            // Detail follows the object's own on-screen size (its view depth),
            // not just the zoom: a far corner of a tilted view is small even
            // when zoomed in. A little hysteresis keeps a model from flipping
            // between meshes at the threshold while the camera moves.
            let pixels = this.pixelsPerWorldAt(Number(object.x) || 0, 0, Number(object.z) || 0) * Math.max(object.scaleX, object.scaleZ);
            let level = figureLodLevel(object._r3dLod | 0, pixels);
            object._r3dLod = level;
            if (!level) return kind;
            let lod = lodMeshKeys.get(kind);
            if (!lod) lodMeshKeys.set(kind, lod = [kind + ':lod', kind + ':lod2']);
            return lod[level - 1];
        }

        // On-screen CSS pixels per world unit at a point, from its depth along
        // the view direction (orthographic flat view: the zoom).
        pixelsPerWorldAt(x, y, z) {
            let eye = this.lodEye, f = this.lodForward;
            if (!eye || !this.lodProjectionScale) return this.lodPixelsPerWorld || 32;
            let depth = (x - eye[0]) * f[0] + (y - eye[1]) * f[1] + (z - eye[2]) * f[2];
            return this.lodProjectionScale / Math.max(0.1, depth);
        }

        getPrimitiveMesh(object) {
            return object && object.renderShape === 'cylinder' ? this.cylinderMesh : this.cubeMesh;
        }

        // Settings > Rendering. MSAA and resolution changes reallocate the
        // scene target on the next resize; everything else is per frame.
        setGraphicsOptions(options) {
            // Called every frame with the settings object, which is replaced
            // (not mutated) on change.
            if (options === this.graphicsSource) return;
            this.graphicsSource = options;
            if (!this.supported || !this.postProcess || typeof normalizeGraphicsOptions !== 'function') return;
            let next = normalizeGraphicsOptions(options);
            let prev = this.graphicsOptions;
            if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
            this.graphicsOptions = next;
            let samples = (next.aa === 'msaa' || next.aa === 'msaa_fxaa') ? this.supportedSceneSamples : 0;
            if (samples !== this.sceneSamples || !prev || prev.resolution !== next.resolution) {
                this.sceneSamples = samples;
                this.sceneTargetSize.width = this.sceneTargetSize.height = 0;
                if (this.cssWidth > 0 && this.cssHeight > 0) this.resize(this.cssWidth, this.cssHeight);
            }
        }

        setEnabled(enabled) {
            this.enabled = !!enabled && this.supported;
            this.canvas.style.display = this.enabled ? 'block' : 'none';
        }

        resizeForSnapshot(snapshot) {
            let pad = Math.max(0, Number(snapshot.viewPad) || 0);
            this.resize((Number(snapshot.viewportWidth) || 1) + 2 * pad, (Number(snapshot.viewportHeight) || 1) + 2 * pad);
        }

        resize(width, height) {
            if (!this.supported) return;
            let safeWidth = Math.max(1, Math.floor(width || 1));
            let safeHeight = Math.max(1, Math.floor(height || 1));
            // Match 2D's native display pixels instead of asking the browser to
            // rescale a 1.5x canvas on a 2x display. Bound large-screen GPU cost.
            const pixelBudget = 6000000;
            this.pixelRatio = Math.min(window.devicePixelRatio || 1, Math.max(1, Math.sqrt(pixelBudget / (safeWidth * safeHeight))));
            // Resolution scale renders fewer pixels; the canvas is stretched back by CSS.
            let resolution = this.graphicsOptions ? this.graphicsOptions.resolution : 1;
            if (resolution < 1) this.pixelRatio *= resolution;
            this.cssWidth = safeWidth;
            this.cssHeight = safeHeight;
            let deviceWidth = Math.max(1, Math.floor(safeWidth * this.pixelRatio));
            let deviceHeight = Math.max(1, Math.floor(safeHeight * this.pixelRatio));
            if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
                this.canvas.width = deviceWidth;
                this.canvas.height = deviceHeight;
                this.canvas.style.width = safeWidth + 'px';
                this.canvas.style.height = safeHeight + 'px';
            }
            this.ensureSceneRenderTarget(deviceWidth, deviceHeight);
            this.gl.viewport(0, 0, deviceWidth, deviceHeight);
        }

        ensureSceneRenderTarget(width, height) {
            if (!this.sceneFramebuffer || !this.sceneColorTexture || !this.sceneDepthTexture) return;
            if (this.sceneTargetSize.width === width && this.sceneTargetSize.height === height) return;
            let gl = this.gl;
            this.sceneTargetSize.width = width;
            this.sceneTargetSize.height = height;

            gl.bindTexture(gl.TEXTURE_2D, this.sceneColorTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthColorTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneColorTexture, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.sceneDepthColorTexture, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.sceneDepthTexture, 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthPackFramebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneDepthColorTexture, 0);
            if (this.sceneSamples) {
                // Color and depth only: packed depth for overlays is taken from
                // the resolved depth texture, so a multisampled packed-depth
                // attachment would only cost fill rate and bandwidth.
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFramebuffer);
                for (let i of [0, 2]) {
                    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaBuffers[i]);
                    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.sceneSamples, i === 2 ? gl.DEPTH_COMPONENT24 : gl.RGBA8, width, height);
                    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, i === 2 ? gl.DEPTH_ATTACHMENT : gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msaaBuffers[i]);
                }
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) this.sceneSamples = 0;
                gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
        }

        // Depth is resolved only for overlay occlusion readback.
        resolveScene(withDepth = false) {
            if (!this.sceneSamples) return;
            let gl = this.gl, { width, height } = this.sceneTargetSize;
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFramebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFramebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, withDepth ? gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT : gl.COLOR_BUFFER_BIT, gl.NEAREST);
            gl.drawBuffers(this.sceneDrawBuffers);
        }

        captureOverlayDepthFrame() {
            let gl = this.gl;
            let width = this.sceneTargetSize.width;
            let height = this.sceneTargetSize.height;
            if (width <= 0 || height <= 0) {
                this.overlayDepthFrame = null;
                return;
            }
            if (this.sceneSamples) {
                // Packed depth bytes cannot be averaged by MSAA: pack the resolved
                // depth texture instead, keeping health-bar occlusion accurate.
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthPackFramebuffer);
                gl.disable(gl.DEPTH_TEST);
                gl.useProgram(this.presentProgram);
                gl.bindVertexArray(this.presentVao);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthTexture);
                gl.uniform1i(this.presentUniforms.texture, 0);
                gl.uniform1i(this.presentUniforms.packDepth, 1);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                gl.enable(gl.DEPTH_TEST);
            }
            let requiredLength = width * height * 4;
            // Frame validity is cleared by render/resize; keep the large backing
            // buffer separately so overlays do not allocate a screenful every frame.
            if (!this.overlayDepthBytes || this.overlayDepthBytes.length !== requiredLength) {
                this.overlayDepthBytes = new Uint8Array(requiredLength);
            }
            this.overlayDepthFrame = { width, height, bytes: this.overlayDepthBytes };
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFramebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT1);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.overlayDepthFrame.bytes);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        }

        presentSceneToCanvas(flat = false) {
            let gl = this.gl;
            let post = this.postProcess, options = this.graphicsOptions;
            if (post && options && post.isActive(options, flat)) {
                post.render(options, {
                    colorTex: this.sceneColorTexture, depthTex: this.sceneDepthTexture,
                    width: this.sceneTargetSize.width, height: this.sceneTargetSize.height,
                    near: 0.1, far: 220, flat, quadVao: this.presentVao,
                    pixelsPerWorld: this.lodPixelsPerWorld, pixelRatio: this.pixelRatio,
                    projectionScale: (this.lodProjectionScale || 0) * this.pixelRatio,
                    shadow: flat ? null : this.shadowFrame
                });
                return;
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.sceneTargetSize.width, this.sceneTargetSize.height);
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(this.presentProgram);
            gl.bindVertexArray(this.presentVao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneColorTexture);
            gl.uniform1i(this.presentUniforms.texture, 0);
            gl.uniform1i(this.presentUniforms.packDepth, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.enable(gl.DEPTH_TEST);
        }

        adjustOrbit(deltaYaw, deltaPitch) {
            this.orbitYaw += Number(deltaYaw) || 0;
            this.orbitPitch = Math.max(0.38, Math.min(1.42, this.orbitPitch + (Number(deltaPitch) || 0)));
        }

        getGroundMovementBasis() {
            return {
                forwardX: -Math.sin(this.orbitYaw),
                forwardZ: -Math.cos(this.orbitYaw),
                rightX: Math.cos(this.orbitYaw),
                rightZ: -Math.sin(this.orbitYaw)
            };
        }

        uploadBackgroundTexture(sourceCanvas, version) {
            let gl = this.gl;
            let needsUpload = this.backgroundTextureSource !== sourceCanvas || this.backgroundTextureVersion !== version || this.backgroundTextureSize.width !== sourceCanvas.width || this.backgroundTextureSize.height !== sourceCanvas.height;
            if (!needsUpload) return;
            gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            if (this.backgroundTextureSize.width !== sourceCanvas.width || this.backgroundTextureSize.height !== sourceCanvas.height) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
                this.backgroundTextureSize.width = sourceCanvas.width;
                this.backgroundTextureSize.height = sourceCanvas.height;
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
            }
            this.backgroundTextureVersion = version;
            this.backgroundTextureSource = sourceCanvas;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        uploadFogTexture(source, version) {
            if (!source) return;
            let gl = this.gl;
            let resized = this.fogTextureSize.width !== source.width || this.fogTextureSize.height !== source.height;
            if (!resized && this.fogTextureSource === source && this.fogTextureVersion === version) return;
            gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            if (resized) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                this.fogTextureSize = { width: source.width, height: source.height };
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
            }
            this.fogTextureVersion = version;
            this.fogTextureSource = source;
        }

        buildViewProjection(snapshot) {
            let pad = Math.max(0, Number(snapshot.viewPad) || 0);
            this.viewPad = pad;
            let viewW = Math.max(1, Number(snapshot.viewportWidth) || 1);
            let viewH = Math.max(1, Number(snapshot.viewportHeight) || 1);
            let growX = (viewW + 2 * pad) / viewW, growY = (viewH + 2 * pad) / viewH;
            if (snapshot.flat2d) {
                // World X/Z map exactly to the existing 2D mouse/camera math.
                const camera = snapshot.camera;
                const m = this.tmpViewProjection;
                m.fill(0);
                m[0] = 2 / (camera.visibleWidth * growX);
                m[9] = -2 / (camera.visibleHeight * growY);
                m[6] = -0.001;
                m[12] = -camera.centerX * m[0];
                m[13] = -camera.centerZ * m[9];
                m[15] = 1;
                invertMatrix4(this.tmpInverseViewProjection, m);
                this.lodProjectionScale = 0;
                return;
            }
            let aspect = Math.max(1e-4, (viewW + 2 * pad) / (viewH + 2 * pad));
            let camera = snapshot.camera || {};
            let centerX = Number(camera.centerX) || 0;
            let centerZ = Number(camera.centerZ) || 0;
            let visibleWidth = Math.max(1.2, Number(camera.visibleWidth) || 1.2);
            let visibleHeight = Math.max(1.2, Number(camera.visibleHeight) || 1.2);
            let distance = Math.max(1.8, Math.max(visibleWidth, visibleHeight) * 1.25);
            let horizontalDistance = Math.cos(this.orbitPitch) * distance;
            let eye = [
                centerX + Math.sin(this.orbitYaw) * horizontalDistance,
                Math.sin(this.orbitPitch) * distance,
                centerZ + Math.cos(this.orbitYaw) * horizontalDistance
            ];
            let target = [centerX, 0, centerZ];
            // Overscan widens the field of view by exactly the margin, so the
            // view itself projects as without it.
            // The old fixed far plane clipped the entire arena at scale.
            const far = Math.max(220, distance + Math.hypot(snapshot.worldWidth || 0, snapshot.worldHeight || 0) * 2);
            perspective(this.tmpProjection, 2 * Math.atan(Math.tan(0.37) * growY), aspect, Math.max(.1, distance / 10000), far);
            // CSS pixels per world unit at view depth 1; divide by a point's
            // depth along the view direction for its on-screen scale.
            this.lodProjectionScale = this.cssHeight * this.tmpProjection[5] / 2;
            this.lodPixelsPerWorld = this.lodProjectionScale / distance;
            let lodEye = this.lodEye || (this.lodEye = new Float32Array(3));
            let lodForward = this.lodForward || (this.lodForward = new Float32Array(3));
            lodEye[0] = eye[0]; lodEye[1] = eye[1]; lodEye[2] = eye[2];
            let fx = centerX - eye[0], fy = -eye[1], fz = centerZ - eye[2], fl = Math.hypot(fx, fy, fz) || 1;
            lodForward[0] = fx / fl; lodForward[1] = fy / fl; lodForward[2] = fz / fl;
            lookAt(this.tmpView, eye, target, [0, 1, 0]);
            multiplyMatrices(this.tmpViewProjection, this.tmpProjection, this.tmpView);
            invertMatrix4(this.tmpInverseViewProjection, this.tmpViewProjection);
        }

        getGroundViewportBounds(snapshot, paddingTiles = 0) {
            if (!snapshot) return null;
            let footprint = this.getGroundFrustumPolygon(snapshot);
            if (!footprint || footprint.length < 3) return null;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let point of footprint) {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }
            let pad = Math.max(0, Number(paddingTiles) || 0);
            let worldWidth = Number(snapshot.worldWidth) || 0;
            let worldHeight = Number(snapshot.worldHeight) || 0;
            return {
                minGx: Math.floor(minX - pad),
                minGy: Math.floor(minY - pad),
                maxGx: worldWidth > 0 ? Math.min(worldWidth - 1, Math.ceil(maxX + pad)) : Math.ceil(maxX + pad),
                maxGy: worldHeight > 0 ? Math.min(worldHeight - 1, Math.ceil(maxY + pad)) : Math.ceil(maxY + pad)
            };
        }

        // `viewOnly`: the view's footprint without the overscan margin.
        getGroundFrustumPolygon(snapshot, viewOnly = false) {
            if (!snapshot) return null;
            this.resizeForSnapshot(snapshot);
            this.buildViewProjection(snapshot);
            let pad = viewOnly ? (this.viewPad || 0) : 0;
            let sx = this.cssWidth > 0 ? (this.cssWidth - 2 * pad) / this.cssWidth : 1;
            let sy = this.cssHeight > 0 ? (this.cssHeight - 2 * pad) / this.cssHeight : 1;

            let corners = [];
            for (let z of [-1, 1]) {
                for (let y of [-sy, sy]) {
                    for (let x of [-sx, sx]) {
                        corners.push(transformClipToWorld(this.tmpInverseViewProjection, x, y, z));
                    }
                }
            }

            let points = [];
            let addPoint = (x, y) => {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                if (points.some(point => Math.abs(point.x - x) < 1e-5 && Math.abs(point.y - y) < 1e-5)) return;
                points.push({ x, y });
            };
            let edgeBits = [1, 2, 4];
            for (let i = 0; i < corners.length; i++) {
                let a = corners[i];
                if (!a) continue;
                for (let bit of edgeBits) {
                    let j = i ^ bit;
                    if (j <= i) continue;
                    let b = corners[j];
                    if (!b) continue;
                    let ay = a[1], by = b[1];
                    if (Math.abs(ay) < 1e-6) addPoint(a[0], a[2]);
                    if (Math.abs(by) < 1e-6) addPoint(b[0], b[2]);
                    if ((ay < 0 && by > 0) || (ay > 0 && by < 0)) {
                        let t = -ay / (by - ay);
                        addPoint(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t);
                    }
                }
            }
            if (points.length < 3) return null;
            let centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
            let centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
            points.sort((a, b) => Math.atan2(a.y - centerY, a.x - centerX) - Math.atan2(b.y - centerY, b.x - centerX));
            return points;
        }

        // View coordinates (relative to the game area).
        projectWorldToScreen(x, y, z) {
            let projected = this.projectWorldToCanvasDetailed(x, y, z);
            if (!projected) return null;
            return {
                x: projected.x - (this.viewPad || 0),
                y: projected.y - (this.viewPad || 0),
            };
        }

        projectWorldToScreenDetailed(x, y, z) {
            let projected = this.projectWorldToCanvasDetailed(x, y, z);
            if (projected) { projected.x -= this.viewPad || 0; projected.y -= this.viewPad || 0; }
            return projected;
        }

        // Canvas coordinates (include the overscan): for drawing on the canvases.
        projectWorldToCanvas(x, y, z) {
            let projected = this.projectWorldToCanvasDetailed(x, y, z);
            return projected ? { x: projected.x, y: projected.y } : null;
        }

        projectWorldToCanvasDetailed(x, y, z) {
            let clipX = this.tmpViewProjection[0] * x + this.tmpViewProjection[4] * y + this.tmpViewProjection[8] * z + this.tmpViewProjection[12];
            let clipY = this.tmpViewProjection[1] * x + this.tmpViewProjection[5] * y + this.tmpViewProjection[9] * z + this.tmpViewProjection[13];
            let clipZ = this.tmpViewProjection[2] * x + this.tmpViewProjection[6] * y + this.tmpViewProjection[10] * z + this.tmpViewProjection[14];
            let clipW = this.tmpViewProjection[3] * x + this.tmpViewProjection[7] * y + this.tmpViewProjection[11] * z + this.tmpViewProjection[15];
            if (!clipW || clipW <= 0) return null;
            let invW = 1 / clipW;
            let ndcX = clipX * invW;
            let ndcY = clipY * invW;
            let ndcZ = clipZ * invW;
            return {
                x: (ndcX * 0.5 + 0.5) * this.cssWidth,
                y: (1 - (ndcY * 0.5 + 0.5)) * this.cssHeight,
                depth01: ndcZ * 0.5 + 0.5,
                clipW,
                ndcZ,
            };
        }


        pickRenderedSource(screenX, screenY, candidates) {
            if (this.scaleLayers) return this.pickScaleSource(screenX, screenY, candidates);
            if (!this.pickInverseViewProjection || !this.pickObjects) return null;
            this.syncUnitLayerPickPositions();
            let pickPad = this.pickViewPad || 0;
            screenX += pickPad;
            screenY += pickPad;
            const nx = screenX / this.cssWidth * 2 - 1, ny = 1 - screenY / this.cssHeight * 2;
            const near = transformClipToWorld(this.pickInverseViewProjection, nx, ny, -1);
            const far = transformClipToWorld(this.pickInverseViewProjection, nx, ny, 1);
            if (!near || !far) return null;
            let bestT = 1, best = null;
            const texturePixels = new Map();
            const pose = [0, 0, 0];
            for (const { object: o, mesh } of this.pickObjects) {
                if (!candidates.has(o.pickSource) || o.pickSource.dead || o.pickSource.energy <= 0) continue;
                const c = Math.cos(o.rotationY), s = Math.sin(o.rotationY);
                const local = p => {
                    const x = p[0] - o.x, z = p[2] - o.z;
                    return [(c * x - s * z) / o.scaleX, (p[1] - o.y) / o.scaleY, (s * x + c * z) / o.scaleZ];
                };
                const a = local(near), b = local(far), d = b.map((v, i) => v - a[i]);
                // Conservative animated bounds first; triangles only for objects under the pointer.
                const margin = mesh.details ? 1.5 : 0;
                let lo = 0, hi = bestT;
                for (let axis = 0; axis < 3; axis++) {
                    const min = mesh.bounds[axis] - margin, max = mesh.bounds[axis + 3] + margin;
                    if (Math.abs(d[axis]) < 1e-10) {
                        if (a[axis] < min || a[axis] > max) { hi = -1; break; }
                    } else {
                        const t0 = (min - a[axis]) / d[axis], t1 = (max - a[axis]) / d[axis];
                        lo = Math.max(lo, Math.min(t0, t1));
                        hi = Math.min(hi, Math.max(t0, t1));
                    }
                }
                if (lo > hi) continue;
                const vertices = new Float64Array(mesh.positions.length);
                for (let i = 0; i < mesh.positions.length / 3; i++) {
                    let x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
                    if (mesh.details) {
                        poseFigureVertex(pose, x, y, z, mesh.details, i, o.walkPhase || 0, o.moveAmount || 0, o.animationMode || 0, mesh.rig || 0);
                        x = pose[0]; y = pose[1]; z = pose[2];
                        if (mesh.details[i * 4] === 4 && mesh.details[i * 4 + 3] > .5) {
                            const px = x;
                            x = c * x - s * z;
                            z = s * px + c * z;
                        }
                    }
                    vertices[i * 3] = x;
                    vertices[i * 3 + 1] = y;
                    vertices[i * 3 + 2] = z;
                }
                const v = vertices, indices = mesh.indices;
                for (let i = 0; i < indices.length; i += 3) {
                    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
                    const ex = v[ib] - v[ia], ey = v[ib + 1] - v[ia + 1], ez = v[ib + 2] - v[ia + 2];
                    const fx = v[ic] - v[ia], fy = v[ic + 1] - v[ia + 1], fz = v[ic + 2] - v[ia + 2];
                    const px = d[1] * fz - d[2] * fy, py = d[2] * fx - d[0] * fz, pz = d[0] * fy - d[1] * fx;
                    const det = ex * px + ey * py + ez * pz;
                    if (Math.abs(det) < 1e-10) continue;
                    const tx = a[0] - v[ia], ty = a[1] - v[ia + 1], tz = a[2] - v[ia + 2];
                    const u = (tx * px + ty * py + tz * pz) / det;
                    if (u < 0 || u > 1) continue;
                    const qx = ty * ez - tz * ey, qy = tz * ex - tx * ez, qz = tx * ey - ty * ex;
                    const w = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
                    if (w < 0 || u + w > 1) continue;
                    const t = (fx * qx + fy * qy + fz * qz) / det;
                    if (t < 0 || t >= bestT) continue;
                    if (mesh.details && mesh.details[indices[i] * 4] === 4 && o.topTextureCanvas && mesh.uvs) {
                        // Match the panel shader's alpha discard; transparent HUD margins aren't solid.
                        const canvas = o.topTextureCanvas;
                        if (!texturePixels.has(canvas)) {
                            let pixels = null;
                            try { pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height); } catch (_) {}
                            texturePixels.set(canvas, pixels);
                        }
                        const pixels = texturePixels.get(canvas);
                        if (pixels) {
                            const uv = mesh.uvs;
                            const i0 = indices[i] * 2, i1 = indices[i + 1] * 2, i2 = indices[i + 2] * 2;
                            const tu = uv[i0] * (1 - u - w) + uv[i1] * u + uv[i2] * w;
                            const tv = uv[i0 + 1] * (1 - u - w) + uv[i1 + 1] * u + uv[i2 + 1] * w;
                            const px = Math.max(0, Math.min(pixels.width - 1, Math.floor(tu * pixels.width)));
                            const py = Math.max(0, Math.min(pixels.height - 1, Math.floor((1 - tv) * pixels.height)));
                            if (pixels.data[(py * pixels.width + px) * 4 + 3] < 26) continue;
                        }
                    }
                    if (t >= 0 && t < bestT) { bestT = t; best = o.pickSource; }
                }
            }
            return best;
        }

        // Box selection against what is drawn: the sources whose rendered
        // mesh has a triangle reaching into the screen rectangle, so a tall
        // tower is caught by its top as well. Unlike a click, a box is a
        // coarse gesture: figures are tested in their rest pose (posing every
        // vertex of hundreds of units made a drag release take tens of ms).
        // `candidates` (a Set) limits the test to those sources. Each object's
        // bounds are projected first; only one straddling the box edge has
        // its triangles tested.
        boxRenderedSources(minX, minY, maxX, maxY, candidates = null) {
            if (this.scaleLayers) {
                const hits = new Set();
                this.visitScaleCandidates(candidates, (source, x, z, size, height) => {
                    const p = this.projectWorldToScreen(x, height, z);
                    const radius = Math.max(1, this.pixelsPerWorldAt(x, height, z) * size * .5);
                    if (p && p.x + radius >= minX && p.x - radius <= maxX && p.y + radius >= minY && p.y - radius <= maxY) hits.add(source);
                });
                return hits;
            }
            const hits = new Set();
            let pickPad = this.pickViewPad || 0;
            minX += pickPad; maxX += pickPad;
            minY += pickPad; maxY += pickPad;
            const m = this.pickViewProjection;
            if (!m || !this.pickObjects) return hits;
            this.syncUnitLayerPickPositions();
            const width = this.cssWidth, height = this.cssHeight;
            // Screen bounds of the object's mesh bounds (grown a little for
            // panels that turn to face the camera): 0 off the box, 2 wholly
            // inside it, 1 straddling or behind the camera.
            const boundsState = (o, mesh, c, s) => {
                const b = mesh.bounds;
                if (!b) return 1;
                const margin = mesh.details ? .35 : 0;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (let k = 0; k < 8; k++) {
                    const lx = (k & 1 ? b[3] + margin : b[0] - margin) * o.scaleX;
                    const ly = k & 2 ? b[4] + margin : b[1] - margin;
                    const lz = (k & 4 ? b[5] + margin : b[2] - margin) * o.scaleZ;
                    const wx = c * lx + s * lz + o.x, wy = ly * o.scaleY + o.y, wz = -s * lx + c * lz + o.z;
                    const clipW = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
                    if (!(clipW > 0)) return 1;
                    const sx = ((m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / clipW * 0.5 + 0.5) * width;
                    const sy = (1 - ((m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / clipW * 0.5 + 0.5)) * height;
                    if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
                    if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
                }
                if (x1 < minX || x0 > maxX || y1 < minY || y0 > maxY) return 0;
                return x0 >= minX && x1 <= maxX && y0 >= minY && y1 <= maxY ? 2 : 1;
            };
            // Separating axis test: the rectangle's axes (bounds), then each
            // triangle edge's normal (the triangle's third vertex is `ox, oy`).
            const edgeSeparates = (px, py, qx, qy, ox, oy) => {
                const nx = qy - py, ny = px - qx;
                const d0 = px * nx + py * ny, d1 = ox * nx + oy * ny;
                const triMin = Math.min(d0, d1), triMax = Math.max(d0, d1);
                const ax = minX * nx, bx = maxX * nx, ay = minY * ny, by = maxY * ny;
                const boxMin = Math.min(ax, bx) + Math.min(ay, by), boxMax = Math.max(ax, bx) + Math.max(ay, by);
                return triMax < boxMin || boxMax < triMin;
            };
            const overlaps = (ax, ay, bx, by, cx, cy) => {
                if (Math.max(ax, bx, cx) < minX || Math.min(ax, bx, cx) > maxX) return false;
                if (Math.max(ay, by, cy) < minY || Math.min(ay, by, cy) > maxY) return false;
                return !edgeSeparates(ax, ay, bx, by, cx, cy) && !edgeSeparates(bx, by, cx, cy, ax, ay) && !edgeSeparates(cx, cy, ax, ay, bx, by);
            };
            for (const { object: o, mesh } of this.pickObjects) {
                const source = o.pickSource;
                if (!source || hits.has(source) || !mesh || !mesh.positions || !mesh.indices) continue;
                if (candidates && !candidates.has(source)) continue;
                const c = Math.cos(o.rotationY || 0), s = Math.sin(o.rotationY || 0);
                const state = boundsState(o, mesh, c, s);
                if (state === 0) continue;
                if (state === 2 && mesh.indices.length) { hits.add(source); continue; }
                const count = mesh.positions.length / 3;
                // Scratch buffers reused across objects and calls (no garbage per drag).
                if (!this.boxScratch || this.boxScratch.inFront.length < count) {
                    const size = Math.max(count, 1024);
                    this.boxScratch = { screen: new Float64Array(size * 2), inFront: new Uint8Array(size) };
                }
                const { screen, inFront } = this.boxScratch;
                inFront.fill(0, 0, count);
                for (let i = 0; i < count; i++) {
                    let x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
                    if (mesh.details && mesh.details[i * 4] === 4 && mesh.details[i * 4 + 3] > .5) {
                        const px = x;
                        x = c * x - s * z;
                        z = s * px + c * z;
                    }
                    const lx = x * o.scaleX, lz = z * o.scaleZ;
                    const wx = c * lx + s * lz + o.x, wy = y * o.scaleY + o.y, wz = -s * lx + c * lz + o.z;
                    const clipW = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
                    if (!(clipW > 0)) continue;
                    inFront[i] = 1;
                    screen[i * 2] = ((m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / clipW * 0.5 + 0.5) * width;
                    screen[i * 2 + 1] = (1 - ((m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / clipW * 0.5 + 0.5)) * height;
                }
                const indices = mesh.indices;
                for (let i = 0; i < indices.length; i += 3) {
                    const a = indices[i], b = indices[i + 1], d = indices[i + 2];
                    if (!inFront[a] || !inFront[b] || !inFront[d]) continue;
                    if (overlaps(screen[a * 2], screen[a * 2 + 1], screen[b * 2], screen[b * 2 + 1], screen[d * 2], screen[d * 2 + 1])) {
                        hits.add(source);
                        break;
                    }
                }
            }
            return hits;
        }

        getScreenPixelsPerTile(x, y, z) {
            let center = this.projectWorldToScreen(x, y, z);
            let offsetX = this.projectWorldToScreen(x + 1, y, z);
            let offsetZ = this.projectWorldToScreen(x, y, z + 1);
            if (!center) return 0;
            let sx = offsetX ? Math.hypot(offsetX.x - center.x, offsetX.y - center.y) : 0;
            let sz = offsetZ ? Math.hypot(offsetZ.x - center.x, offsetZ.y - center.y) : 0;
            return Math.max(sx, sz);
        }

        getSceneDepthAtCssPixel(x, y) {
            let key = `${Math.round(x)},${Math.round(y)}`;
            if (this.overlayDepthCache.has(key)) return this.overlayDepthCache.get(key);
            if (!this.overlayDepthFrame || !this.overlayDepthFrame.bytes) return NaN;
            let width = this.overlayDepthFrame.width;
            let height = this.overlayDepthFrame.height;
            if (width <= 0 || height <= 0) return NaN;
            let px = Math.max(0, Math.min(this.sceneTargetSize.width - 1, Math.round(x * this.pixelRatio)));
            let py = Math.max(0, Math.min(this.sceneTargetSize.height - 1, Math.round((this.cssHeight - 1 - y) * this.pixelRatio)));
            let offset = (py * width + px) * 4;
            let bytes = this.overlayDepthFrame.bytes;
            let depth = decodePackedDepth(bytes, offset);
            this.overlayDepthCache.set(key, depth);
            return depth;
        }

        isOverlayPointVisible(projected, depthBias = 0.0012) {
            if (!projected) return false;
            let sceneDepth = this.getSceneDepthAtCssPixel(projected.x, projected.y);
            if (!Number.isFinite(sceneDepth) || sceneDepth <= 0 || sceneDepth >= 1) return true;
            return projected.depth01 <= (sceneDepth + depthBias);
        }

        getTopTexture(key, sourceCanvas) {
            if (!key || !sourceCanvas) return null;
            let version = Number(sourceCanvas._textureVersion) || 0;
            let cached = this.topTextureCache.get(key);
            if (cached && cached.texture) {
                cached.lastUsedFrame = this.textureFrame;
                let sameSize = cached.width === sourceCanvas.width && cached.height === sourceCanvas.height;
                if (cached.version === version && sameSize) return cached.texture;
                this.gl.bindTexture(this.gl.TEXTURE_2D, cached.texture);
                this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
                this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                if (!sameSize) {
                    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, sourceCanvas);
                } else {
                    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, sourceCanvas);
                }
                if (cached.mipmapped) this.gl.generateMipmap(this.gl.TEXTURE_2D);
                cached.version = version;
                cached.width = sourceCanvas.width;
                cached.height = sourceCanvas.height;
                return cached.texture;
            }
            let texture = createTexture(this.gl);
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            // Mipmaps stabilize distant symbols; non-sprite textures also use anisotropy.
            let exactSprite = String(key).startsWith('2d:');
            let mipmapped = !String(key).startsWith('shared_audio');
            // 2D uses unsmoothed pixels. Do the same within each sprite mip,
            // blending levels only to avoid hard transitions while zooming.
            if (exactSprite) this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
            if (mipmapped) {
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, exactSprite ? this.gl.NEAREST_MIPMAP_LINEAR : this.gl.LINEAR_MIPMAP_LINEAR);
                if (this.textureAnisotropy && !exactSprite) {
                    let ext = this.textureAnisotropy;
                    this.gl.texParameterf(this.gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, this.gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
                }
            }
            this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
            this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, sourceCanvas);
            if (mipmapped) this.gl.generateMipmap(this.gl.TEXTURE_2D);
            this.topTextureCache.set(key, { texture, version, mipmapped, width: sourceCanvas.width, height: sourceCanvas.height, lastUsedFrame: this.textureFrame });
            return texture;
        }

        drawGroundOverlays(overlays) {
            if (!overlays) return;
            let groups = overlays.selectionContours || [], lines = overlays.lines || [];
            let ranges = overlays.rangeLines || [];
            let count = lines.length + ranges.length;
            for (let group of groups) for (let path of group.paths) count += path.length;
            if (!count) return;
            let gl = this.gl;
            if (!this.groundLineProgram) {
                // Screen-width quads rather than driver-dependent GL line widths.
                // Depth testing against the scene hides ground outlines behind models.
                this.groundLineProgram = createProgram(gl, `#version 300 es
                    precision highp float;
                    layout(location=0) in vec4 aEnds;
                    layout(location=1) in vec4 aColor;
                    layout(location=2) in vec2 aStyle;
                    uniform mat4 uViewProjection;
                    uniform vec2 uViewport;
                    uniform int uSeeThroughCount;
                    uniform int uRangeStart;
                    uniform int uRangeEnd;
                    out vec4 vColor;
                    out float vAlong;
                    out float vAcross;
                    flat out float vDashed;
                    void main() {
                        vec4 a = uViewProjection * vec4(aEnds.x, .05, aEnds.y, 1.);
                        vec4 b = uViewProjection * vec4(aEnds.z, .05, aEnds.w, 1.);
                        // Clip before dividing by w. Long range boundaries can
                        // cross the camera plane; expanding those un-clipped
                        // endpoints produces enormous screen-covering quads.
                        float da = a.z + a.w, db = b.z + b.w;
                        if (da <= 0.0 && db <= 0.0) {
                            gl_Position = vec4(2.,2.,2.,1.);
                            vColor = vec4(0.); vAcross = 0.; vAlong = 0.; vDashed = 0.;
                            return;
                        }
                        if (da < 0.0) a = mix(a, b, -da / (db - da));
                        else if (db < 0.0) b = mix(b, a, -db / (da - db));
                        vec2 delta = (b.xy / b.w - a.xy / a.w) * uViewport * .5;
                        float lengthPx = max(length(delta), .001);
                        vec2 normal = vec2(-delta.y, delta.x) / lengthPx;
                        float end = float(gl_VertexID / 2);
                        float side = float(gl_VertexID % 2) * 2. - 1.;
                        vec4 p = mix(a, b, end);
                        p.xy += normal * side * 1.25 * 2. / uViewport * p.w;
                        // Selection instances precede rally lines in this batch.
                        // Bring only opted-in outlines to the near plane; depth
                        // writes stay disabled, preserving the scene and rallies.
                        if (gl_InstanceID < uSeeThroughCount || (gl_InstanceID >= uRangeStart && gl_InstanceID < uRangeEnd)) p.z = -p.w;
                        gl_Position = p;
                        vColor = aColor; vAcross = side;
                        vAlong = aStyle.y + end * lengthPx; vDashed = aStyle.x;
                    }
                `, `#version 300 es
                    precision highp float;
                    in vec4 vColor;
                    in float vAlong;
                    in float vAcross;
                    flat in float vDashed;
                    layout(location=0) out vec4 outColor;
                    void main() {
                        if (vDashed > .5 && mod(vAlong, 9.) > 5.) discard;
                        float coverage = 1. - smoothstep(.55, 1., abs(vAcross));
                        outColor = vec4(vColor.rgb, vColor.a * coverage);
                    }
                `);
                this.groundLineVao = gl.createVertexArray();
                this.groundLineBuffer = gl.createBuffer();
                this.groundLineColors = new Map();
                this.groundLineUniforms = {
                    viewProjection: gl.getUniformLocation(this.groundLineProgram, 'uViewProjection'),
                    viewport: gl.getUniformLocation(this.groundLineProgram, 'uViewport'),
                    seeThroughCount: gl.getUniformLocation(this.groundLineProgram, 'uSeeThroughCount'),
                    rangeStart: gl.getUniformLocation(this.groundLineProgram, 'uRangeStart'),
                    rangeEnd: gl.getUniformLocation(this.groundLineProgram, 'uRangeEnd')
                };
                gl.bindVertexArray(this.groundLineVao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.groundLineBuffer);
                for (let [location, size, offset] of [[0,4,0], [1,4,16], [2,2,32]]) {
                    gl.enableVertexAttribArray(location);
                    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 40, offset);
                    gl.vertexAttribDivisor(location, 1);
                }
            }
            if (!this.groundLineData || this.groundLineData.length < count * 10) {
                this.groundLineData = new Float32Array(Math.max(1024, count * 20));
                gl.bindBuffer(gl.ARRAY_BUFFER, this.groundLineBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, this.groundLineData.byteLength, gl.DYNAMIC_DRAW);
            }
            let data = this.groundLineData, offset = 0;
            let add = (x1, z1, x2, z2, color, dashed, phase) => {
                let rgba = this.groundLineColors.get(color);
                if (!rgba) {
                    let match = /^rgba?\(([^)]+)\)$/.exec(color);
                    if (match) {
                        let values = match[1].split(',').map(Number);
                        rgba = [values[0]/255, values[1]/255, values[2]/255, values.length > 3 ? values[3] : 1];
                    } else rgba = [...hexToRgb(color), 1];
                    this.groundLineColors.set(color, rgba);
                }
                data[offset++] = x1; data[offset++] = z1; data[offset++] = x2; data[offset++] = z2;
                for (let value of rgba) data[offset++] = value;
                data[offset++] = dashed ? 1 : 0; data[offset++] = phase;
            };
            let tile = overlays.worldTileSize || 32;
            for (let group of groups) for (let path of group.paths) {
                let phase = 0;
                let firstProjected = overlays.selectionDashed && this.projectWorldToCanvas(path[0][0]/tile, .05, path[0][1]/tile);
                let pa = firstProjected;
                for (let i = 0; i < path.length; i++) {
                    let a = path[i], b = path[(i + 1) % path.length];
                    add(a[0]/tile, a[1]/tile, b[0]/tile, b[1]/tile, group.color, overlays.selectionDashed, phase);
                    if (overlays.selectionDashed) {
                        let pb = i + 1 === path.length ? firstProjected : this.projectWorldToCanvas(b[0]/tile, .05, b[1]/tile);
                        if (pa && pb) phase += Math.hypot(pb.x-pa.x, pb.y-pa.y);
                        pa = pb;
                    }
                }
            }
            for (let line of ranges) add(line.x1, line.z1, line.x2, line.z2, line.color, false, 0);
            for (let line of lines) add(line.x1, line.z1, line.x2, line.z2, line.color, line.dashed, 0);
            gl.useProgram(this.groundLineProgram);
            gl.bindVertexArray(this.groundLineVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.groundLineBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, offset));
            gl.uniformMatrix4fv(this.groundLineUniforms.viewProjection, false, this.tmpViewProjection);
            gl.uniform2f(this.groundLineUniforms.viewport, this.cssWidth, this.cssHeight);
            gl.uniform1i(this.groundLineUniforms.seeThroughCount, overlays.selectionSeeThrough ? count - lines.length - ranges.length : 0);
            gl.uniform1i(this.groundLineUniforms.rangeStart, count - lines.length - ranges.length);
            gl.uniform1i(this.groundLineUniforms.rangeEnd, overlays.rangeSeeThrough ? count - lines.length : 0);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            // Preserve the packed scene depth attachment for other overlays.
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, offset / 10);
            gl.drawBuffers(this.sceneDrawBuffers);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            overlays.groundLinesRendered = true;
        }

        drawOverlay(overlays, ctx) {
            if (!ctx || !overlays) return;
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            let projectGround = (x, z) => this.projectWorldToCanvas(x, 0.05, z);
            let getPathGroup = (groups, key, init) => {
                let group = groups.get(key);
                if (group) return group;
                group = init();
                groups.set(key, group);
                return group;
            };

            let rectGroups = new Map();
            for (let rect of overlays.rects || []) {
                let corners = [
                    projectGround(rect.x - rect.halfWidth, rect.z - rect.halfHeight),
                    projectGround(rect.x + rect.halfWidth, rect.z - rect.halfHeight),
                    projectGround(rect.x + rect.halfWidth, rect.z + rect.halfHeight),
                    projectGround(rect.x - rect.halfWidth, rect.z + rect.halfHeight)
                ];
                if (corners.some(p => !p)) continue;
                let group = getPathGroup(rectGroups, `${rect.color}|${rect.dashed ? 1 : 0}`, () => ({
                    color: rect.color,
                    dashed: !!rect.dashed,
                    path: new Path2D()
                }));
                group.path.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < corners.length; i++) group.path.lineTo(corners[i].x, corners[i].y);
                group.path.closePath();
            }
            for (let group of rectGroups.values()) {
                ctx.strokeStyle = group.color;
                ctx.lineWidth = 1.5;
                ctx.setLineDash(group.dashed ? [5, 4] : []);
                ctx.stroke(group.path);
            }

            let areaTileGroups = new Map();
            for (let tile of overlays.areaTiles || []) {
                let key = `${tile.strokeColor}|${tile.fillColor || ''}|${tile.dashed ? 1 : 0}`;
                let group = getPathGroup(areaTileGroups, key, () => ({
                    strokeColor: tile.strokeColor,
                    dashed: !!tile.dashed,
                    tiles: []
                }));
                group.tiles.push(tile);
            }
            for (let group of areaTileGroups.values()) {
                let tileSet = new Set();
                for (let tile of group.tiles) tileSet.add(`${tile.x},${tile.y}`);
                let path = new Path2D();
                for (let tile of group.tiles) {
                    let corners = [
                        projectGround(tile.x, tile.y),
                        projectGround(tile.x + 1, tile.y),
                        projectGround(tile.x + 1, tile.y + 1),
                        projectGround(tile.x, tile.y + 1)
                    ];
                    if (corners.some(p => !p)) continue;
                    if (!tileSet.has(`${tile.x},${tile.y - 1}`)) {
                        path.moveTo(corners[0].x, corners[0].y);
                        path.lineTo(corners[1].x, corners[1].y);
                    }
                    if (!tileSet.has(`${tile.x + 1},${tile.y}`)) {
                        path.moveTo(corners[1].x, corners[1].y);
                        path.lineTo(corners[2].x, corners[2].y);
                    }
                    if (!tileSet.has(`${tile.x},${tile.y + 1}`)) {
                        path.moveTo(corners[2].x, corners[2].y);
                        path.lineTo(corners[3].x, corners[3].y);
                    }
                    if (!tileSet.has(`${tile.x - 1},${tile.y}`)) {
                        path.moveTo(corners[3].x, corners[3].y);
                        path.lineTo(corners[0].x, corners[0].y);
                    }
                }
                ctx.strokeStyle = group.strokeColor;
                ctx.lineWidth = 1.1;
                ctx.setLineDash(group.dashed ? [5, 4] : []);
                ctx.stroke(path);
            }

            let ringGroups = new Map();
            for (let ring of overlays.rings || []) {
                let steps = 40;
                let first = null;
                let path = new Path2D();
                for (let i = 0; i <= steps; i++) {
                    let a = (i / steps) * Math.PI * 2;
                    let p = projectGround(ring.x + Math.cos(a) * ring.radius, ring.z + Math.sin(a) * ring.radius);
                    if (!p) continue;
                    if (!first) {
                        first = p;
                        path.moveTo(p.x, p.y);
                    } else {
                        path.lineTo(p.x, p.y);
                    }
                }
                if (!first) continue;
                let key = `${ring.strokeColor}|${ring.fillColor || ''}|${ring.dashed ? 1 : 0}`;
                let group = getPathGroup(ringGroups, key, () => ({
                    strokeColor: ring.strokeColor,
                    fillColor: ring.fillColor || null,
                    dashed: !!ring.dashed,
                    path: new Path2D()
                }));
                group.path.addPath(path);
            }
            for (let group of ringGroups.values()) {
                ctx.strokeStyle = group.strokeColor;
                ctx.fillStyle = group.fillColor || 'transparent';
                ctx.lineWidth = 1.25;
                ctx.setLineDash(group.dashed ? [5, 4] : []);
                if (group.fillColor) ctx.fill(group.path);
                ctx.stroke(group.path);
            }

            let lineGroups = new Map();
            for (let line of (overlays.groundLinesRendered ? [] : overlays.lines || [])) {
                let p1 = projectGround(line.x1, line.z1);
                let p2 = projectGround(line.x2, line.z2);
                if (!p1 || !p2) continue;
                let group = getPathGroup(lineGroups, `${line.color}|${line.dashed ? 1 : 0}`, () => ({
                    color: line.color,
                    dashed: !!line.dashed,
                    path: new Path2D()
                }));
                group.path.moveTo(p1.x, p1.y);
                group.path.lineTo(p2.x, p2.y);
            }
            for (let group of lineGroups.values()) {
                ctx.strokeStyle = group.color;
                ctx.lineWidth = 1.5;
                ctx.setLineDash(group.dashed ? [5, 4] : []);
                ctx.stroke(group.path);
            }

            ctx.setLineDash([]);
            let plusMarkerGroups = new Map();
            let arrowMarkerGroups = new Map();
            let dotMarkerGroups = new Map();
            for (let marker of overlays.markers || []) {
                let p = projectGround(marker.x, marker.z);
                if (!p) continue;
                if (marker.kind === 'plus') {
                    let group = getPathGroup(plusMarkerGroups, marker.color, () => ({ color: marker.color, path: new Path2D() }));
                    group.path.moveTo(p.x - 5, p.y);
                    group.path.lineTo(p.x + 5, p.y);
                    group.path.moveTo(p.x, p.y - 5);
                    group.path.lineTo(p.x, p.y + 5);
                } else if (marker.kind === 'arrow') {
                    let group = getPathGroup(arrowMarkerGroups, marker.color, () => ({ color: marker.color, path: new Path2D() }));
                    group.path.moveTo(p.x, p.y - 6);
                    group.path.lineTo(p.x - 5, p.y + 4);
                    group.path.lineTo(p.x + 5, p.y + 4);
                    group.path.closePath();
                } else {
                    let group = getPathGroup(dotMarkerGroups, marker.color, () => ({ color: marker.color, path: new Path2D() }));
                    group.path.moveTo(p.x + 3.5, p.y);
                    group.path.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
                }
            }
            ctx.lineWidth = 1.5;
            for (let group of plusMarkerGroups.values()) {
                ctx.strokeStyle = group.color;
                ctx.stroke(group.path);
            }
            for (let group of arrowMarkerGroups.values()) {
                ctx.fillStyle = group.color;
                ctx.fill(group.path);
            }
            for (let group of dotMarkerGroups.values()) {
                ctx.fillStyle = group.color;
                ctx.fill(group.path);
            }

            for (let bar of overlays.bars || []) {
                let p = this.projectWorldToCanvasDetailed(bar.x, Number(bar.lift) || 0.6, bar.z);
                if (!p || !this.isOverlayPointVisible(p)) continue;
                let pixelsPerTile = this.getScreenPixelsPerTile(bar.x, Number(bar.lift) || 0.6, bar.z);
                if (pixelsPerTile <= 0) continue;
                let scale = pixelsPerTile / 32;
                let width = Math.max(1, Math.round((Number(bar.width) || 1) * scale));
                let height = Math.max(1, Math.round((Number(bar.height) || 1) * scale));
                let x = Math.round(p.x - width * 0.5);
                let y = Math.round(p.y + (Number(bar.offsetY) || 0) * scale);
                let pct = Math.max(0, Math.min(1, Number(bar.pct) || 0));
                ctx.fillStyle = bar.bgColor || '#333';
                ctx.fillRect(x, y, width, height);
                ctx.fillStyle = bar.fillColor || '#0f0';
                ctx.fillRect(x, y, Math.round(width * pct), height);
            }

            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            for (let text of overlays.texts || []) {
                let p = this.projectWorldToCanvasDetailed(text.x, Number(text.lift) || 0.8, text.z);
                if (!p || !text.text || !this.isOverlayPointVisible(p)) continue;
                let pixelsPerTile = this.getScreenPixelsPerTile(text.x, Number(text.lift) || 0.8, text.z);
                if (pixelsPerTile <= 0) continue;
                let scale = Math.max(0.45, pixelsPerTile / 32);
                let fontSize = Math.max(7, Math.round(11 * scale));
                ctx.font = `${text.font && /700/.test(text.font) ? '700' : '700'} ${fontSize}px Segoe UI, Arial, sans-serif`;
                ctx.lineJoin = 'round';
                ctx.lineWidth = Math.max(1, Math.round(2 * scale));
                ctx.strokeStyle = text.strokeColor || 'rgba(0,0,0,0.95)';
                ctx.fillStyle = text.color || '#ddd';
                let y = Math.round(p.y + (Number(text.offsetY) || 0) * scale);
                ctx.strokeText(String(text.text), Math.round(p.x), y);
                ctx.fillText(String(text.text), Math.round(p.x), y);
            }
            ctx.restore();
        }

        drawBuildPreview(preview, ctx) {
            if (!ctx || !preview) return;
            let projectGround = (x, z) => this.projectWorldToCanvas(x, 0.06, z);
            let drawTile = (tileX, tileZ, fillStyle, strokeStyle) => {
                let corners = [
                    projectGround(tileX, tileZ),
                    projectGround(tileX + 1, tileZ),
                    projectGround(tileX + 1, tileZ + 1),
                    projectGround(tileX, tileZ + 1)
                ];
                if (corners.some(p => !p)) return null;
                ctx.beginPath();
                ctx.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
                ctx.closePath();
                ctx.fillStyle = fillStyle;
                ctx.strokeStyle = strokeStyle;
                ctx.lineWidth = 1.5;
                ctx.fill();
                ctx.stroke();
                let minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
                let maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
                let minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
                let maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
                return { minX, maxX, minY, maxY };
            };

            ctx.save();
            let goodFill = 'rgba(0,255,0,0.22)';
            let badFill = 'rgba(255,70,70,0.24)';
            let goodStroke = 'rgba(120,255,120,0.95)';
            let badStroke = 'rgba(255,210,80,0.95)';
            let fillStyle = preview.canBuild ? goodFill : badFill;
            let strokeStyle = preview.canBuild ? goodStroke : badStroke;

            let bounds = null;
            if (Array.isArray(preview.areaCells) && preview.areaCells.length > 0) {
                for (let cell of preview.areaCells) {
                    let rect = drawTile(cell.x, cell.y, cell.occupied ? 'rgba(0,255,0,0.18)' : 'rgba(255,120,0,0.20)', strokeStyle);
                    if (!rect) continue;
                    if (!bounds) bounds = rect;
                    else {
                        bounds.minX = Math.min(bounds.minX, rect.minX);
                        bounds.maxX = Math.max(bounds.maxX, rect.maxX);
                        bounds.minY = Math.min(bounds.minY, rect.minY);
                        bounds.maxY = Math.max(bounds.maxY, rect.maxY);
                    }
                }
                let center = projectGround(preview.areaCenterX, preview.areaCenterY);
                if (center) {
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = 'bold 13px monospace';
                    ctx.fillStyle = preview.canBuild ? '#4f4' : '#fd0';
                    ctx.fillText(`${preview.filledCount}/${preview.areaCellCount}`, center.x, center.y);
                    if (preview.filledCount === preview.areaCellCount) {
                        ctx.font = '10px monospace';
                        ctx.fillText(`M${preview.areaMultiplierLevel}->${preview.areaMultiplierLevel + 1}`, center.x, center.y + 13);
                        ctx.fillStyle = preview.canBuild ? '#4f4' : '#f88';
                        ctx.fillText(`E${preview.areaUpgradeCost}`, center.x, center.y + 24);
                    }
                }
            } else {
                bounds = drawTile(preview.gx, preview.gy, fillStyle, strokeStyle);
            }

            if (preview.rangeRadiusTiles > 0) {
                ctx.strokeStyle = preview.canBuild ? 'rgba(80,255,80,0.45)' : 'rgba(255,90,90,0.45)';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                let steps = 40;
                let started = false;
                let radius = preview.rangeRadiusTiles;
                for (let i = 0; i <= steps; i++) {
                    let a = i / steps * Math.PI * 2;
                    let p = projectGround(preview.gx + 0.5 + Math.cos(a) * radius, preview.gy + 0.5 + Math.sin(a) * radius);
                    if (!p) continue;
                    if (!started) {
                        ctx.moveTo(p.x, p.y);
                        started = true;
                    } else {
                        ctx.lineTo(p.x, p.y);
                    }
                }
                if (started) ctx.stroke();
            }

            // The flat icon only stands in until the 3D model ghost is shown.
            let image = preview.modelShown ? null : preview.image;
            if (bounds && image && image.complete && image.naturalWidth > 0) {
                let drawW = Math.max(16, Math.min(72, (bounds.maxX - bounds.minX) * 0.82));
                let drawH = Math.max(16, Math.min(72, (bounds.maxY - bounds.minY) * 0.82));
                let cx = (bounds.minX + bounds.maxX) * 0.5;
                let cy = (bounds.minY + bounds.maxY) * 0.5;
                ctx.globalAlpha = preview.canBuild ? 0.72 : 0.55;
                ctx.drawImage(image, cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH);
            }
            ctx.restore();
        }

        screenToGround(clientX, clientY, rect) {
            if (!rect || !this.tmpInverseViewProjection) return null;
            // `rect` is the view's; the projection covers the overscan too.
            let pad = this.viewPad || 0;
            let width = Math.max(1, (rect.width || 1) + 2 * pad);
            let height = Math.max(1, (rect.height || 1) + 2 * pad);
            let ndcX = ((clientX - rect.left + pad) / width) * 2 - 1;
            let ndcY = 1 - ((clientY - rect.top + pad) / height) * 2;
            let nearPoint = transformClipToWorld(this.tmpInverseViewProjection, ndcX, ndcY, -1);
            let farPoint = transformClipToWorld(this.tmpInverseViewProjection, ndcX, ndcY, 1);
            if (!nearPoint || !farPoint) return null;
            let rayX = farPoint[0] - nearPoint[0];
            let rayY = farPoint[1] - nearPoint[1];
            let rayZ = farPoint[2] - nearPoint[2];
            if (Math.abs(rayY) < 1e-5) return null;
            let t = -nearPoint[1] / rayY;
            if (!Number.isFinite(t) || t < 0) return null;
            return {
                x: nearPoint[0] + rayX * t,
                y: nearPoint[2] + rayZ * t,
            };
        }

        getModelCandidates(object) {
            if (Array.isArray(object.modelCandidates) && object.modelCandidates.length > 0) return object.modelCandidates;
            let key = sanitizeModelKey(object.modelKey);
            return [
                `../../assets/defence3/${key}.glb`,
                `../../assets/defence3/${key}.gltf`,
                `../../assets/models/${key}.glb`,
                `../../assets/models/${key}.gltf`,
                `../../assets/${key}.glb`,
                `../../assets/${key}.gltf`
            ];
        }

        requestModel(object) {
            if (proceduralKind(object)) return null;
            let key = sanitizeModelKey(object.modelKey);
            if (key === 'cube') return null;
            if (this.meshCache.has(key)) return this.meshCache.get(key);
            if (this.modelRequests.has(key)) return null;

            let candidates = this.getModelCandidates(object);
            let promise = (async () => {
                for (let url of candidates) {
                    try {
                        let parsed = await parseGltfUrl(url);
                        let meshData = buildMeshDataFromGltf(parsed.json, parsed.buffers);
                        if (!meshData) continue;
                        let mesh = createMesh(this.gl, meshData.positions, meshData.normals, meshData.indices, null);
                        this.meshCache.set(key, mesh);
                        return;
                    } catch (error) {
                        // Try next candidate.
                    }
                }
                this.meshCache.set(key, null);
            })().finally(() => {
                this.modelRequests.delete(key);
            });
            this.modelRequests.set(key, promise);
            return null;
        }

        drawBackground(snapshot) {
            if (!snapshot.backgroundCanvas) return;
            let gl = this.gl;
            let backgroundBounds = snapshot.backgroundBounds || {};
            let planeCenterX = Number.isFinite(backgroundBounds.centerX) ? backgroundBounds.centerX : snapshot.camera.centerX;
            let planeCenterZ = Number.isFinite(backgroundBounds.centerZ) ? backgroundBounds.centerZ : snapshot.camera.centerZ;
            let planeWidth = Math.max(1, Number(backgroundBounds.width) || snapshot.camera.visibleWidth);
            let planeHeight = Math.max(1, Number(backgroundBounds.height) || snapshot.camera.visibleHeight);
            this.uploadBackgroundTexture(snapshot.backgroundCanvas, Number.isFinite(snapshot.backgroundVersion) ? snapshot.backgroundVersion : 0);
            this.uploadFogTexture(snapshot.fogCanvas, snapshot.fogVersion);
            gl.useProgram(this.planeProgram);
            gl.bindVertexArray(this.planeMesh.vao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
            gl.uniform1i(this.planeUniforms.texture, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
            gl.uniform1i(this.planeUniforms.fog, 1);
            gl.uniform1i(this.planeUniforms.hasFog, snapshot.fogCanvas ? 1 : 0);
            gl.uniformMatrix4fv(this.planeUniforms.viewProjection, false, this.tmpViewProjection);
            composeModelMatrix(
                this.tmpModel,
                planeCenterX,
                0,
                planeCenterZ,
                0,
                planeWidth,
                1,
                planeHeight
            );
            gl.uniformMatrix4fv(this.planeUniforms.model, false, this.tmpModel);
            gl.drawElements(gl.TRIANGLES, this.planeMesh.indexCount, gl.UNSIGNED_INT, 0);
        }

        // Shadow placement for one object into `out`; false when it casts none.
        computeShadow(object, out) {
            if (!object) return false;
            let alpha = Math.max(0, Math.min(1, Number(object.alpha) || 1));
            if (alpha < 0.14) return false;

            let caster = shadowCasterByModelKey.get(object.modelKey);
            if (caster === undefined) {
                let modelKey = sanitizeModelKey(object.modelKey);
                caster = !(modelKey === 'particle' || modelKey.indexOf('projectile_') === 0 || modelKey.indexOf('dropped_') === 0);
                if (shadowCasterByModelKey.size >= 512) shadowCasterByModelKey.clear();
                shadowCasterByModelKey.set(object.modelKey, caster);
            }
            if (!caster) return false;

            let scaleX = Math.max(0.01, Number(object.scaleX) || 0);
            let scaleY = Math.max(0.01, Number(object.scaleY) || 0);
            let scaleZ = Math.max(0.01, Number(object.scaleZ) || 0);
            if (Math.max(scaleX, scaleY, scaleZ) < 0.05) return false;

            let lightLevel = Math.max(0, Math.min(1, Number(object.lightLevel) || 0));
            let dirX = Number(object.shadowDirX);
            let dirZ = Number(object.shadowDirZ);
            if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || Math.hypot(dirX, dirZ) < 0.0001) {
                dirX = SHADOW_LIGHT_DIRECTION[0];
                dirZ = SHADOW_LIGHT_DIRECTION[2];
            }
            let dirLength = Math.hypot(dirX, dirZ) || 1;
            dirX /= dirLength;
            dirZ /= dirLength;
            let shadowLength = Math.max(0.6, Math.min(2.6, Number(object.shadowLength) || (1 + (1 - lightLevel) * 0.9)));
            let baseY = Math.max(0, Number(object.y) || 0);
            let casterHeight = Math.max(0.04, baseY + scaleY * 0.58);
            let shadowStretch = Math.min(2.2, (1.02 + casterHeight * 0.16) * shadowLength);
            let lightY = Math.max(0.2, SHADOW_LIGHT_DIRECTION[1]);
            let shadowOffset = (casterHeight * shadowLength / lightY) * 0.4;
            out.x = (Number(object.x) || 0) - dirX * shadowOffset;
            out.y = SHADOW_GROUND_Y;
            out.z = (Number(object.z) || 0) - dirZ * shadowOffset;
            out.rotationY = Number(object.rotationY) || 0;
            out.scaleX = scaleX * shadowStretch;
            out.scaleY = SHADOW_FLAT_HEIGHT * (0.5 + lightLevel);
            out.scaleZ = scaleZ * shadowStretch;
            out.alpha = Math.max(0.04, Math.min(0.28, (0.05 + 0.24 * lightLevel - casterHeight * 0.03) * alpha));
            out.renderShape = object.renderShape === 'cylinder' ? 'cylinder' : 'box';
            return true;
        }

        getShadowInfo(object) {
            let shadow = {};
            return this.computeShadow(object, shadow) ? shadow : null;
        }

        drawShadowObject(object, shadow = this.getShadowInfo(object)) {
            if (!shadow) return;

            let gl = this.gl;
            let mesh = this.requestModel(object);
            if (mesh === undefined || mesh === null) mesh = this.getPrimitiveMesh(shadow);

            gl.useProgram(this.meshProgram);
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(this.meshUniforms.viewProjection, false, this.tmpViewProjection);
            composeModelMatrix(
                this.tmpModel,
                shadow.x,
                shadow.y,
                shadow.z,
                shadow.rotationY,
                shadow.scaleX,
                shadow.scaleY,
                shadow.scaleZ
            );
            extractNormalMatrix(this.tmpNormal, this.tmpModel);
            gl.uniformMatrix4fv(this.meshUniforms.model, false, this.tmpModel);
            gl.uniformMatrix3fv(this.meshUniforms.normalMatrix, false, this.tmpNormal);
            gl.uniform3f(this.meshUniforms.color, 0, 0, 0);
            gl.uniform1f(this.meshUniforms.alpha, shadow.alpha);
            gl.uniform1f(this.meshUniforms.lightLevel, 1);
            gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
        }

        // Primitive shadows are written straight into per-shape instance
        // data while the scene is sorted, instead of one object per shadow.
        beginShadowBatches() {
            let batches = this.shadowBatches || (this.shadowBatches = {
                box: { renderShape: 'box', data: new Float32Array(64 * INSTANCE_STRIDE), count: 0 },
                cylinder: { renderShape: 'cylinder', data: new Float32Array(64 * INSTANCE_STRIDE), count: 0 }
            });
            batches.box.count = batches.cylinder.count = 0;
            return batches;
        }

        pushShadowInstance(object, batches = this.shadowBatches, dx = 0, dz = 0) {
            let shadow = this.shadowScratch || (this.shadowScratch = {});
            if (!this.computeShadow(object, shadow)) return false;
            let batch = shadow.renderShape === 'cylinder' ? batches.cylinder : batches.box;
            let base = batch.count * INSTANCE_STRIDE;
            if (base + INSTANCE_STRIDE > batch.data.length) {
                let grown = new Float32Array(batch.data.length * 2);
                grown.set(batch.data);
                batch.data = grown;
            }
            let data = batch.data;
            writeModelMatrix(data, base, shadow.x, shadow.y, shadow.z, shadow.rotationY, shadow.scaleX, shadow.scaleY, shadow.scaleZ);
            data[base + 16] = 0;
            data[base + 17] = 0;
            data[base + 18] = 0;
            data[base + 19] = shadow.alpha;
            data[base + 20] = shadow.renderShape === 'cylinder' ? 1 : 0;
            data[base + 21] = 0;
            data[base + 22] = 0;
            data[base + 23] = 0;
            data[base + 24] = 0;
            data[base + 25] = 1;
            data[base + 3] = dx;
            data[base + 7] = dz;
            batch.count++;
            return true;
        }

        newShadowBatches() {
            return {
                box: { renderShape: 'box', data: new Float32Array(64 * INSTANCE_STRIDE), count: 0 },
                cylinder: { renderShape: 'cylinder', data: new Float32Array(64 * INSTANCE_STRIDE), count: 0 }
            };
        }

        drawShadowInstances(batch) {
            if (!batch || batch.count <= 0) return;
            let gl = this.gl;
            let mesh = this.getPrimitiveMesh(batch);
            let base = this.allocInstances(batch.count);
            this.cubeInstanceArray.set(batch.data.subarray(0, batch.count * INSTANCE_STRIDE), base * INSTANCE_STRIDE);
            this.uploadInstances(base, batch.count);
            gl.useProgram(this.instancedMeshProgram);
            gl.bindVertexArray(mesh.vao);
            this.setInstanceBase(mesh, base);
            gl.uniformMatrix4fv(this.instancedMeshUniforms.viewProjection, false, this.tmpViewProjection);
            gl.uniform1f(this.instancedMeshUniforms.layerAlpha, batch.layerAlpha === undefined ? 1 : batch.layerAlpha);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, batch.count);
        }

        drawShadows(meshObjects, batches) {
            let hasMeshes = !!(meshObjects && meshObjects.length > 0);
            let hasPrimitives = !!(batches && (batches.box.count > 0 || batches.cylinder.count > 0));
            let hasLayers = !!(this.unitLayerShadow || (this.staticGroups && this.staticGroups.shadow));
            if (!hasMeshes && !hasPrimitives && !hasLayers) return;

            let gl = this.gl;
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            for (let entry of meshObjects || []) this.drawShadowObject(entry.object, entry.shadow);
            if (batches) {
                // Black shadows blend multiplicatively: their order is irrelevant.
                this.drawShadowInstances(batches.box);
                this.drawShadowInstances(batches.cylinder);
            }
            // The layers' drop shadows (Simple shadows), kept per layer.
            for (let extra of [this.unitLayerShadow, this.staticGroups && this.staticGroups.shadow]) {
                if (!extra) continue;
                extra.box.layerAlpha = extra.cylinder.layerAlpha = extra === this.unitLayerShadow ? this.layerAlpha : 1;
                this.drawShadowInstances(extra.box);
                this.drawShadowInstances(extra.cylinder);
            }
            if (this.staticGroups && this.staticGroups.shadowMeshes) for (let entry of this.staticGroups.shadowMeshes) this.drawShadowObject(entry.object, entry.shadow);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            gl.drawBuffers(this.sceneDrawBuffers);
        }

        getPackedObjectLight(object) {
            let light = Math.max(0, Math.min(1, Number(object.lightLevel) || 0));
            // Negative values encode remembered lighting in the existing
            // instance channel, preserving batching and the shadow inputs.
            return object.historyGhost ? -1 - light : light;
        }

        drawObject(object) {
            let gl = this.gl;
            let mesh = this.requestModel(object);
            if (mesh === undefined || mesh === null) mesh = this.cubeMesh;
            gl.useProgram(this.meshProgram);
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(this.meshUniforms.viewProjection, false, this.tmpViewProjection);
            composeModelMatrix(
                this.tmpModel,
                object.x,
                object.y,
                object.z,
                object.rotationY || 0,
                object.scaleX,
                object.scaleY,
                object.scaleZ
            );
            extractNormalMatrix(this.tmpNormal, this.tmpModel);
            gl.uniformMatrix4fv(this.meshUniforms.model, false, this.tmpModel);
            gl.uniformMatrix3fv(this.meshUniforms.normalMatrix, false, this.tmpNormal);
            let color = hexToRgb(object.tint);
            gl.uniform3f(this.meshUniforms.color, color[0], color[1], color[2]);
            gl.uniform1f(this.meshUniforms.alpha, Math.max(0.05, Math.min(1, Number(object.alpha) || 1)));
            gl.uniform1f(this.meshUniforms.lightLevel, this.getPackedObjectLight(object));
            gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
        }

        // ---- Frame instance arena ----
        // Every instanced batch of a frame is written once into one buffer
        // (CPU copy + GPU buffer) at its own range. The shadow-map pass
        // draws the same batches again from their ranges instead of
        // rebuilding and re-uploading them. Reset at the start of render().
        resetInstanceArena() {
            this.arenaUsed = 0;
            this.arenaStamp = this.textureFrame;
        }

        // The static arena (structure layer) takes the place of the frame
        // arena while its batches are drawn: exchanges the current arena
        // fields with `other` and returns the previous ones.
        swapArena(other) {
            let cur = { buffer: this.cubeInstanceBuffer, array: this.cubeInstanceArray, cap: this.cubeInstanceCapacity, used: this.arenaUsed, stamp: this.arenaStamp };
            this.cubeInstanceBuffer = other.buffer; this.cubeInstanceArray = other.array; this.cubeInstanceCapacity = other.cap;
            this.arenaUsed = other.used; this.arenaStamp = other.stamp;
            return cur;
        }

        // ---- Structure layer ----
        // Structures the frame builder kept (renderer.js, STRUCTURE LAYER) are
        // grouped when the layer changes and written to the static arena on
        // their first draw; later frames draw them from there.
        prepareStaticLayer(layer) {
            if (this.staticLayerVersion === layer.version && this.staticGroups) return;
            let gl = this.gl;
            this.staticLayerVersion = layer.version;
            let st = this.staticArenaState || (this.staticArenaState = { buffer: gl.createBuffer(), array: null, cap: 0, used: 0, stamp: 0 });
            st.used = 0;
            st.stamp = -layer.version;
            let textured = new Map(), cubes = new Map(), meshes = [], picks = [];
            for (let o of layer.objects) {
                let figureMeshKey = this.getFigureMeshKey(o);
                let mesh = figureMeshKey ? null : this.requestModel(o);
                let isTextured = (o.topTextureKey && o.topTextureCanvas) || (o.sideTextureKey && o.sideTextureCanvas);
                if (o.pickSource) {
                    let pickMesh = mesh || (isTextured && figureMeshKey && this.getFigureMesh(figureMeshKey)) || this.getPrimitiveMesh(o);
                    let entry = o._r3dPick || (o._r3dPick = { object: o, mesh: null });
                    entry.mesh = pickMesh;
                    picks.push(entry);
                }
                if (mesh) meshes.push(o);
                else if (isTextured) {
                    let atlasPanel = !!(figureMeshKey && isAtlasPanel(o));
                    let key = atlasPanel
                        ? `atlas|${figureMeshKey}|anim:${Number(o.animationMode) || 0}`
                        : `${o.topTextureKey || ''}|${o.sideTextureKey || ''}|${figureMeshKey || o.renderShape || 'box'}|anim:${Number(o.animationMode) || 0}`;
                    let g = textured.get(key);
                    if (!g) textured.set(key, g = { atlas: atlasPanel, figure: figureMeshKey, objects: [], topKey: o.topTextureKey, topCanvas: o.topTextureCanvas,
                        sideKey: !figureMeshKey && !atlasPanel && o.sideTextureKey && o.sideTextureCanvas ? o.sideTextureKey : null, sideCanvas: o.sideTextureCanvas });
                    g.objects.push(o);
                } else {
                    let key = o.renderShape || 'box';
                    let g = cubes.get(key);
                    if (!g) cubes.set(key, g = []);
                    g.push(o);
                }
            }
            let shadow = null, shadowMeshes = null;
            if (this.graphicsOptions && this.graphicsOptions.shadows === 'simple') {
                shadow = this.newShadowBatches(); shadowMeshes = [];
                for (let o of meshes) { let info = this.getShadowInfo(o); if (info) shadowMeshes.push({ object: o, shadow: info }); }
                for (let g of textured.values()) for (let o of g.objects) this.pushShadowInstance(o, shadow);
                for (let g of cubes.values()) for (let o of g) this.pushShadowInstance(o, shadow);
            }
            this.staticGroups = { textured: [...textured.values()], cubes: [...cubes.values()], meshes, picks, slots: null, shadow, shadowMeshes };
        }

        drawStaticLayer(atlas) {
            let groups = this.staticGroups;
            if (!groups) return;
            let saved = this.swapArena(this.staticArenaState);
            try {
                let firstWrite = this.arenaUsed === 0;
                for (let g of groups.textured) {
                    // Textures are looked up each frame (keeps their cache entries).
                    let top = g.atlas ? null : this.getTopTexture(g.topKey, g.topCanvas);
                    let side = g.sideKey ? this.getTopTexture(g.sideKey, g.sideCanvas) : null;
                    this.drawTexturedCubeInstances(g.objects, top, side, g.atlas ? atlas : null);
                }
                for (let g of groups.cubes) this.drawCubeInstances(g);
                if (firstWrite && atlas) {
                    // The atlas layers the written batches use, kept each frame.
                    let slots = new Set(), a = this.cubeInstanceArray, n = this.arenaUsed;
                    for (let i = 0; i < n; i++) {
                        let top = a[i * INSTANCE_STRIDE + 26], status = a[i * INSTANCE_STRIDE + 27];
                        if (top >= 0) slots.add(top | 0);
                        if (status >= 0) slots.add(status | 0);
                    }
                    groups.slots = Int32Array.from(slots);
                } else if (groups.slots && atlas) {
                    for (let i = 0; i < groups.slots.length; i++) atlas.lastUsed[groups.slots[i]] = atlas.frame;
                }
            } finally {
                this.staticArenaState = this.swapArena(saved);
            }
            for (let o of groups.meshes) this.drawObject(o);
        }

        // Room for `count` instances; returns the first instance index.
        allocInstances(count) {
            let base = this.arenaUsed || 0;
            let need = base + count;
            if (!(this.cubeInstanceCapacity >= need)) {
                let gl = this.gl;
                let next = Math.max(256, this.cubeInstanceCapacity || 0);
                while (next < need) next *= 2;
                let grown = new Float32Array(next * INSTANCE_STRIDE);
                if (this.cubeInstanceArray && base > 0) grown.set(this.cubeInstanceArray.subarray(0, base * INSTANCE_STRIDE));
                this.cubeInstanceArray = grown;
                this.cubeInstanceCapacity = next;
                gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, grown.byteLength, gl.DYNAMIC_DRAW);
                // The ranges already written this frame go along.
                if (base > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, grown, 0, base * INSTANCE_STRIDE);
            }
            this.arenaUsed = need;
            return base;
        }

        uploadInstances(base, count) {
            let gl = this.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, base * INSTANCE_STRIDE * 4, this.cubeInstanceArray, base * INSTANCE_STRIDE, count * INSTANCE_STRIDE);
        }

        // Points the bound mesh VAO's instance attributes at `base`.
        setInstanceBase(mesh, base, buffer = this.cubeInstanceBuffer) {
            if (mesh.instanceBase === base && mesh.instanceBuffer === buffer) return;
            mesh.instanceBase = base;
            mesh.instanceBuffer = buffer;
            let gl = this.gl;
            let stride = INSTANCE_STRIDE * 4, o = base * stride;
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            for (let row = 0; row < 4; row++) gl.vertexAttribPointer(3 + row, 4, gl.FLOAT, false, stride, o + row * 16);
            gl.vertexAttribPointer(7, 3, gl.FLOAT, false, stride, o + 64);
            gl.vertexAttribPointer(8, 1, gl.FLOAT, false, stride, o + 76);
            gl.vertexAttribPointer(9, 1, gl.FLOAT, false, stride, o + 80);
            gl.vertexAttribPointer(10, 1, gl.FLOAT, false, stride, o + 84);
            gl.vertexAttribPointer(11, 3, gl.FLOAT, false, stride, o + 88);
            gl.vertexAttribPointer(12, 1, gl.FLOAT, false, stride, o + 100);
            gl.vertexAttribPointer(14, 1, gl.FLOAT, false, stride, o + 104);
            gl.vertexAttribPointer(15, 1, gl.FLOAT, false, stride, o + 108);
        }

        ensureCubeInstanceCapacity(requiredCount) {
            if (this.cubeInstanceCapacity >= requiredCount) return;
            let gl = this.gl;
            let nextCapacity = Math.max(32, this.cubeInstanceCapacity || 0);
            while (nextCapacity < requiredCount) nextCapacity *= 2;
            this.cubeInstanceCapacity = nextCapacity;
            this.cubeInstanceArray = new Float32Array(nextCapacity * INSTANCE_STRIDE);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.cubeInstanceArray.byteLength, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        drawCubeInstances(objects) {
            if (!objects || objects.length <= 0) return;
            let gl = this.gl;
            let mesh = this.getPrimitiveMesh(objects[0]);
            // Written once per frame (the shadow-map pass draws it again).
            let first = objects._arenaFrame === this.arenaStamp && objects._arenaCount === objects.length ? objects._arenaBase : -1;
            if (first < 0) {
            first = this.allocInstances(objects.length);
            let data = this.cubeInstanceArray;
            for (let index = 0; index < objects.length; index++) {
                let object = objects[index];
                let base = (first + index) * INSTANCE_STRIDE;
                writeModelMatrix(data, base, object.x, object.y, object.z, object.rotationY || 0, object.scaleX, object.scaleY, object.scaleZ);
                let color = hexToRgb(object.tint);
                data[base + 16] = color[0];
                data[base + 17] = color[1];
                data[base + 18] = color[2];
                data[base + 19] = Math.max(0.05, Math.min(1, Number(object.alpha) || 1));
                data[base + 20] = object.renderShape === 'cylinder' ? 1 : 0;
                data[base + 21] = 0;
                data[base + 22] = color[0];
                data[base + 23] = color[1];
                data[base + 24] = color[2];
                data[base + 25] = this.getPackedObjectLight(object);
            }
            this.uploadInstances(first, objects.length);
            objects._arenaFrame = this.arenaStamp; objects._arenaBase = first; objects._arenaCount = objects.length;
            }
            gl.useProgram(this.instancedMeshProgram);
            gl.bindVertexArray(mesh.vao);
            this.setInstanceBase(mesh, first);
            gl.uniformMatrix4fv(this.instancedMeshUniforms.viewProjection, false, this.tmpViewProjection);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, objects.length);
        }

        // ---- Unit layer ----
        // Objects the frame builder put in the layer (see renderer.js, UNIT
        // LAYER) are written to their own buffer when the layer changes (a
        // tick), and drawn from it every frame with uLayerAlpha. Returns the
        // objects the layer cannot draw (no atlas panel or figure), for the
        // per-frame path.
        // The frame builder writes each layer object here as it goes (one pass
        // over the units): instance data into buckets by figure mesh and
        // animation mode. prepareUnitLayer then joins the buckets.
        beginUnitLayerWrite(version) {
            this.directVersion = version;
            let buckets = this.directBuckets || (this.directBuckets = new Map());
            for (let byMode of buckets.values()) for (let b of byMode) if (b) { b.count = 0; b.picks.length = 0; }
            this.directAtlas = this.getFlatAtlas();
            // The atlas layers the layer uses (a stamp per layer, no Set).
            this.directSlotList = [];
            this.directSlotMark = (this.directSlotMark | 0) + 1;
            if (!this.directSlotSeen || this.directSlotSeen.length < this.directAtlas.lastUsed.length) this.directSlotSeen = new Int32Array(Math.max(64, this.directAtlas.lastUsed.length));
            // Simple shadows: each object's drop shadow, with its offset back to
            // the previous tick (two sets alternate between builds).
            let simple = !!(this.graphicsOptions && this.graphicsOptions.shadows === 'simple');
            if (simple) {
                let sets = this.directShadowSets || (this.directShadowSets = [this.newShadowBatches(), this.newShadowBatches()]);
                this.directShadowIndex = (this.directShadowIndex || 0) ^ 1;
                this.directShadow = sets[this.directShadowIndex];
                this.directShadow.box.count = this.directShadow.cylinder.count = 0;
            } else this.directShadow = null;
        }

        // Returns false when the object cannot be drawn from the layer.
        writeUnitLayerObject(o) {
            let atlas = this.directAtlas;
            let kind = this.getFigureMeshKey(o);
            let top = kind && isAtlasPanel(o) ? atlas.layerFor(o.topTextureCanvas) : -1;
            if (top < 0) return false;
            let byMode = this.directBuckets.get(kind);
            if (!byMode) this.directBuckets.set(kind, byMode = []);
            let mode = o.animationMode | 0;
            let b = byMode[mode];
            if (!b) byMode[mode] = b = { kind, mode, data: new Float32Array(64 * INSTANCE_STRIDE), count: 0, picks: [], sample: null };
            if ((b.count + 1) * INSTANCE_STRIDE > b.data.length) {
                let grown = new Float32Array(b.data.length * 2);
                grown.set(b.data);
                b.data = grown;
            }
            let data = b.data, base = b.count * INSTANCE_STRIDE;
            writeObjectMatrix(data, base, o);
            data[base + 3] = o._pdx; data[base + 7] = o._pdz; data[base + 11] = o._phaseRate;
            data[base + 4] = o._flySeed; data[base + 6] = o._flyOn;
            let color = objectRgb(o);
            data[base + 16] = color[0]; data[base + 17] = color[1]; data[base + 18] = color[2];
            data[base + 19] = Math.max(0.05, Math.min(1, Number(o.alpha) || 1));
            data[base + 20] = o.moveAmount || 0;
            data[base + 21] = o.walkPhase || 0;
            let side = objectSideRgb(o);
            data[base + 22] = side[0]; data[base + 23] = side[1]; data[base + 24] = side[2];
            data[base + 25] = this.getPackedObjectLight(o);
            data[base + 26] = top;
            let status = o.statusTextureCanvas ? atlas.layerFor(o.statusTextureCanvas) : -1;
            data[base + 27] = status;
            this.markDirectSlot(top);
            if (status >= 0) this.markDirectSlot(status);
            if (o.pickSource) b.picks.push(o);
            if (!b.count) b.sample = o;
            b.count++;
            if (this.directShadow) this.pushShadowInstance(o, this.directShadow, o._pdx, o._pdz);
            return true;
        }

        markDirectSlot(slot) {
            let seen = this.directSlotSeen;
            if (slot >= seen.length) { let g = new Int32Array(slot * 2 + 1); g.set(seen); this.directSlotSeen = seen = g; }
            if (seen[slot] !== this.directSlotMark) { seen[slot] = this.directSlotMark; this.directSlotList.push(slot); }
        }

        // The atlas layers of the status icons (one per status code), for
        // records written through writeUnitLayerRecord.
        statusSlotsFor(canvases) {
            let atlas = this.directAtlas || this.getFlatAtlas();
            let out = this.statusSlotScratch || (this.statusSlotScratch = new Float32Array(8));
            for (let i = 0; i < canvases.length; i++) {
                let slot = canvases[i] ? atlas.layerFor(canvases[i]) : -1;
                out[i] = slot;
                if (slot >= 0) this.markDirectSlot(slot);
            }
            return out;
        }

        // A finished instance record (all but the panel's atlas layer) into
        // the bucket of its figure mesh and animation mode. The unit is kept
        // for picking. False when the panel has no atlas layer.
        writeUnitLayerRecord(kind, mode, rec, panel, unit) {
            let atlas = this.directAtlas;
            let top = atlas.layerFor(panel);
            if (top < 0) return false;
            let byMode = this.directBuckets.get(kind);
            if (!byMode) this.directBuckets.set(kind, byMode = []);
            let b = byMode[mode];
            if (!b) byMode[mode] = b = { kind, mode, data: new Float32Array(64 * INSTANCE_STRIDE), count: 0, picks: [], sample: null };
            if ((b.count + 1) * INSTANCE_STRIDE > b.data.length) {
                let grown = new Float32Array(b.data.length * 2);
                grown.set(b.data);
                b.data = grown;
            }
            let base = b.count * INSTANCE_STRIDE;
            b.data.set(rec, base);
            b.data[base + 26] = top;
            this.markDirectSlot(top);
            (b.pickUnits || (b.pickUnits = [])).push(unit, b.count);
            if (!b.count) b.sample = b.sample || { animationMode: mode, topTextureKey: '2d:', modelKey: 'unit_' };
            b.count++;
            if (this.directShadow) {
                let proxy = this.shadowProxy || (this.shadowProxy = {});
                this.fillRecordProxy(proxy, b.data, base, unit);
                this.pushShadowInstance(proxy, this.directShadow, b.data[base + 3], b.data[base + 7]);
            }
            return true;
        }

        // An object-like view of an instance record (picking, drop shadows).
        fillRecordProxy(o, data, base, unit) {
            let sx = Math.hypot(data[base], data[base + 2]), sz = Math.hypot(data[base + 8], data[base + 10]);
            o.x = data[base + 12]; o.y = data[base + 13]; o.z = data[base + 14];
            o.scaleX = sx; o.scaleY = data[base + 5]; o.scaleZ = sz;
            o.rotationY = Math.atan2(-data[base + 2] / (sx || 1), data[base] / (sx || 1));
            o.alpha = 1; o.lightLevel = data[base + 25]; o.pickSource = unit;
            o.modelKey = 'unit_' + (unit && unit.unitType || 'norm'); o.renderShape = 'cylinder';
            o.shadowDirX = undefined; o.shadowDirZ = undefined; o.shadowLength = undefined;
            o._pdx = data[base + 3]; o._pdz = data[base + 7]; o._cx = o.x; o._cz = o.z;
            return o;
        }

        prepareUnitLayer(layer, atlas) {
            this.layerAlpha = Number(layer.alpha) || 0;
            this.layerFlyTime = Number(layer.flyTime) || 0;
            if (this.unitLayerVersion === layer.version && this.unitLayerDraws) {
                // Keep its atlas layers (evicted after two frames unused).
                let slots = this.unitLayerSlots, frame = atlas.frame;
                for (let i = 0; i < slots.length; i++) atlas.lastUsed[slots[i]] = frame;
                return this.unitLayerFallback;
            }
            let gl = this.gl;
            this.unitLayerVersion = layer.version;
            if (this.directVersion === layer.version && this.directBuckets) return this.joinUnitLayerBuckets(layer, atlas);
            let groups = new Map(), fallback = [], picks = [], slotSet = new Set();
            let total = 0;
            for (let o of layer.objects) {
                let kind = this.getFigureMeshKey(o);
                let top = kind && isAtlasPanel(o) ? atlas.layerFor(o.topTextureCanvas) : -1;
                if (top < 0) { fallback.push(o); continue; }
                o._layerTop = top;
                // By kind (interned strings), then animation mode: no key
                // strings built per object.
                let byMode = groups.get(kind);
                if (!byMode) groups.set(kind, byMode = []);
                let mode = o.animationMode | 0;
                let g = byMode[mode];
                if (!g) byMode[mode] = g = { kind, objects: [] };
                g.objects.push(o);
                total++;
            }
            let need = total * INSTANCE_STRIDE;
            if (!this.unitLayerArray || this.unitLayerArray.length < need) {
                this.unitLayerArray = new Float32Array(Math.max(need, 1024 * INSTANCE_STRIDE, (this.unitLayerArray ? this.unitLayerArray.length : 0) * 2));
            }
            if (!this.unitLayerBuffer) this.unitLayerBuffer = gl.createBuffer();
            let data = this.unitLayerArray, statusAtlas = atlas, draws = [], at = 0;
            let groupList = [];
            for (let byMode of groups.values()) for (let g of byMode) if (g) groupList.push(g);
            for (let g of groupList) {
                let first = at;
                let groupMesh = this.getFigureMesh(g.kind);
                for (let o of g.objects) {
                    let base = at * INSTANCE_STRIDE;
                    writeObjectMatrix(data, base, o);
                    data[base + 3] = o._pdx; data[base + 7] = o._pdz; data[base + 11] = o._phaseRate;
                    data[base + 4] = o._flySeed; data[base + 6] = o._flyOn;
                    let color = objectRgb(o);
                    data[base + 16] = color[0]; data[base + 17] = color[1]; data[base + 18] = color[2];
                    data[base + 19] = Math.max(0.05, Math.min(1, Number(o.alpha) || 1));
                    data[base + 20] = o.moveAmount || 0;
                    data[base + 21] = o.walkPhase || 0;
                    let side = objectSideRgb(o);
                    data[base + 22] = side[0]; data[base + 23] = side[1]; data[base + 24] = side[2];
                    data[base + 25] = this.getPackedObjectLight(o);
                    data[base + 26] = o._layerTop;
                    let status = o.statusTextureCanvas ? statusAtlas.layerFor(o.statusTextureCanvas) : -1;
                    data[base + 27] = status;
                    slotSet.add(o._layerTop);
                    if (status >= 0) slotSet.add(status);
                    if (o.pickSource) {
                        let entry = o._r3dPick || (o._r3dPick = { object: o, mesh: null });
                        entry.mesh = groupMesh;
                        picks.push(entry);
                    }
                    at++;
                }
                draws.push({ first, count: at - first, sample: g.objects[0], kind: g.kind, mesh: groupMesh, statusAtlas, buffer: this.unitLayerBuffer, fallback: null });
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.unitLayerBuffer);
            if ((this.unitLayerBufferBytes || 0) < data.byteLength) {
                gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
                this.unitLayerBufferBytes = data.byteLength;
            }
            if (at) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, at * INSTANCE_STRIDE);
            // A reallocated buffer invalidates attribute pointers set from it.
            for (let d of draws) d.mesh.instanceBuffer = null;
            this.unitLayerDraws = draws;
            this.unitLayerPicks = picks;
            this.unitLayerSlots = Int32Array.from(slotSet);
            this.unitLayerFallback = fallback;
            this.unitLayerObjects = layer.objects;
            return fallback;
        }

        // prepareUnitLayer for a layer written through writeUnitLayerObject.
        joinUnitLayerBuckets(layer, atlas) {
            let gl = this.gl;
            let buckets = [];
            for (let byMode of this.directBuckets.values()) for (let b of byMode) if (b && b.count) buckets.push(b);
            let draws = [], picks = [];
            let recordPicks = [];
            for (let b of buckets) {
                // Keep each model bucket on the GPU: no second monolithic
                // allocation/copy of every unit on each published tick.
                const storage = b.storage || (b.storage = new PersistentInstances(INSTANCE_STRIDE));
                storage.data = b.data; storage.count = b.count; storage.version = layer.version;
                storage.upload(gl);
                let mesh = this.getFigureMesh(b.kind);
                if (b.pickUnits && b.pickUnits.length) { recordPicks.push({ b, mesh, first: 0, data: b.data, units: b.pickUnits }); b.pickUnits = []; }
                draws.push({ first: 0, count: b.count, sample: b.sample, kind: b.kind, mesh, statusAtlas: atlas, buffer: storage.buffer, fallback: null });
                for (let o of b.picks) {
                    let entry = o._r3dPick || (o._r3dPick = { object: o, mesh: null });
                    entry.mesh = mesh;
                    picks.push(entry);
                }
            }
            for (let d of draws) d.mesh.instanceBuffer = null;
            let slots = Int32Array.from(this.directSlotList);
            for (let i = 0; i < slots.length; i++) atlas.lastUsed[slots[i]] = atlas.frame;
            this.unitLayerDraws = draws;
            this.unitLayerPicks = picks;
            this.unitLayerSlots = slots;
            this.unitLayerFallback = layer.fallback || [];
            this.unitLayerObjects = layer.objects;
            this.unitLayerShadow = this.directShadow;
            // Record-written units get pick entries only when something picks.
            this.unitLayerRecordPicks = recordPicks;
            this.unitLayerRecordPicksBuilt = null;
            return this.unitLayerFallback;
        }

        drawUnitLayer(atlas) {
            let draws = this.unitLayerDraws;
            if (!draws || !atlas) return;
            for (let d of draws) this.drawTexturedInstanceRange(d, null, null, atlas);
        }

        // Picking reads object positions: put the layer's objects where this
        // frame shows them.
        syncUnitLayerPickPositions() {
            // Pick entries for the units written as records (built once per
            // layer, appended once per frame).
            let rp = this.unitLayerRecordPicks;
            if (rp && rp.length && this.unitLayerDraws) {
                let built = this.unitLayerRecordPicksBuilt;
                if (!built) {
                    built = this.unitLayerRecordPicksBuilt = [];
                    for (let e of rp) {
                        let data = e.data || this.unitLayerArray;
                        for (let k = 0; k < e.units.length; k += 2) {
                            let o = this.fillRecordProxy({}, data, (e.first + e.units[k + 1]) * INSTANCE_STRIDE, e.units[k]);
                            built.push({ object: o, mesh: e.mesh });
                        }
                    }
                }
                if (this.pickObjects && this.pickRecordsFrame !== this.textureFrame) {
                    this.pickRecordsFrame = this.textureFrame;
                    for (let e of built) this.pickObjects.push(e);
                }
                let back = 1 - (this.layerAlpha || 0);
                for (let e of built) { let o = e.object; o.x = o._cx + o._pdx * back; o.z = o._cz + o._pdz * back; }
            }
            let objects = this.unitLayerObjects;
            if (!objects) return;
            let back = 1 - (this.layerAlpha || 0);
            for (let o of objects) { o.x = o._cx + o._pdx * back; o.z = o._cz + o._pdz * back; }
        }

        // With `atlas`, objects are figures with exact 96px 2D panels drawn from
        // the sprite atlas; any panel without a layer falls back to its own
        // texture.
        drawTexturedCubeInstances(objects, topTexture, sideTexture = null, atlas = null) {
            if (!objects || objects.length <= 0 || (!topTexture && !atlas)) return;
            let gl = this.gl;
            // Already written this frame (the shadow-map pass): draw its range.
            let cached = objects._arenaFrame === this.arenaStamp && objects._arenaTotal === objects.length ? objects._arenaDraw : null;
            if (cached) {
                if (cached.fallback) for (let f of cached.fallback) this.drawTexturedCubeInstances(f.list, f.texture);
                if (cached.count) this.drawTexturedInstanceRange(cached, topTexture, sideTexture, atlas);
                return;
            }
            let input = objects;
            let fallbackDraws = null;
            if (atlas) {
                let fallback = null;
                let layers = this.atlasLayers || (this.atlasLayers = []);
                let kept = this.atlasObjects || (this.atlasObjects = []);
                layers.length = kept.length = 0;
                for (let object of objects) {
                    let layer = atlas.layerFor(object.topTextureCanvas);
                    if (layer >= 0) { kept.push(object); layers.push(layer); }
                    else (fallback || (fallback = [])).push(object);
                }
                if (fallback) {
                    let byKey = new Map();
                    for (let object of fallback) {
                        let list = byKey.get(object.topTextureKey);
                        if (!list) byKey.set(object.topTextureKey, list = []);
                        list.push(object);
                    }
                    fallbackDraws = [];
                    for (let list of byKey.values()) {
                        let texture = this.getTopTexture(list[0].topTextureKey, list[0].topTextureCanvas);
                        fallbackDraws.push({ list, texture });
                        this.drawTexturedCubeInstances(list, texture);
                    }
                }
                if (!kept.length) {
                    input._arenaFrame = this.arenaStamp; input._arenaTotal = input.length;
                    input._arenaDraw = { fallback: fallbackDraws, count: 0 };
                    return;
                }
                objects = kept;
            }
            let kind = this.getFigureMeshKey(objects[0]);
            let mesh = kind ? this.getFigureMesh(kind) : this.getPrimitiveMesh(objects[0]);
            let uniforms = kind ? this.figureUniforms : this.texturedCubeUniforms;
            // Front status displays sample the sprite atlas even when the
            // back panels of this batch do not.
            let statusAtlas = kind ? atlas || this.getFlatAtlas() : null;
            let first = this.allocInstances(objects.length);
            let data = this.cubeInstanceArray;
            for (let index = 0; index < objects.length; index++) {
                let object = objects[index];
                let base = (first + index) * INSTANCE_STRIDE;
                writeObjectMatrix(data, base, object);
                let color = objectRgb(object);
                data[base + 16] = color[0];
                data[base + 17] = color[1];
                data[base + 18] = color[2];
                data[base + 19] = Math.max(0.05, Math.min(1, Number(object.alpha) || 1));
                if (kind) {
                    data[base + 20] = object.moveAmount || 0;
                    data[base + 21] = object.walkPhase || 0;
                } else {
                    data[base + 20] = object.renderShape === 'cylinder' ? 1 : 0;
                    data[base + 21] = (Number(object.sideTextureAngle) || 0) - (object.renderShape === 'cylinder' ? (Number(object.rotationY) || 0) : 0);
                }
                let sideColor = objectSideRgb(object);
                data[base + 22] = sideColor[0];
                data[base + 23] = sideColor[1];
                data[base + 24] = sideColor[2];
                data[base + 25] = this.getPackedObjectLight(object);
                data[base + 26] = atlas ? this.atlasLayers[index] : 0;
                data[base + 27] = statusAtlas && object.statusTextureCanvas ? statusAtlas.layerFor(object.statusTextureCanvas) : -1;
            }
            this.uploadInstances(first, objects.length);
            let draw = { first, count: objects.length, sample: objects[0], kind, mesh, statusAtlas, fallback: fallbackDraws, buffer: this.cubeInstanceBuffer };
            input._arenaFrame = this.arenaStamp; input._arenaTotal = input.length; input._arenaDraw = draw;
            this.drawTexturedInstanceRange(draw, topTexture, sideTexture, atlas);
        }

        // Draws a textured batch already written to the instance arena.
        drawTexturedInstanceRange(draw, topTexture, sideTexture, atlas) {
            let gl = this.gl;
            let { kind, mesh, statusAtlas } = draw;
            let objects = [draw.sample];
            let uniforms = kind ? this.figureUniforms : this.texturedCubeUniforms;
            gl.useProgram(kind ? this.figureProgram : this.texturedCubeProgram);
            if (kind) {
                gl.uniform1f(uniforms.isFlying, kind.startsWith('bird') ? 1 : 0);
                gl.uniform1f(uniforms.rig, mesh.rig);
                gl.uniform1f(uniforms.time, this.animationTime || 0);
                gl.uniform1f(uniforms.animationMode, Number(objects[0].animationMode) || 0);
                gl.uniform1f(uniforms.spriteLodBias, String(objects[0].topTextureKey).startsWith('2d:') ? -.5 : 0);
                let key = objects[0].modelKey || '';
                gl.uniform1f(uniforms.isUnit, key.startsWith('unit_') ? 1 : 0);
            }
            gl.bindVertexArray(mesh.vao);
            this.setInstanceBase(mesh, draw.first, draw.buffer || this.cubeInstanceBuffer);
            if (kind) {
                gl.uniform1f(uniforms.layerAlpha, draw.buffer ? this.layerAlpha : 1);
                gl.uniform1f(uniforms.flyTime, this.layerFlyTime || 0);
            }
            gl.uniformMatrix4fv(uniforms.viewProjection, false, this.tmpViewProjection);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, topTexture);
            gl.uniform1i(uniforms.topTexture, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, sideTexture);
            gl.uniform1i(uniforms.sideTexture, 1);
            gl.uniform1f(uniforms.hasSideTexture, sideTexture ? 1 : 0);
            if (kind) {
                // The array sampler keeps its own unit even when unused.
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, statusAtlas ? statusAtlas.texture : null);
                gl.uniform1i(uniforms.atlas, 2);
                gl.uniform1f(uniforms.useAtlas, atlas ? 1 : 0);
                gl.activeTexture(gl.TEXTURE0);
            }
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, draw.count);
        }

        ensureFxResources() {
            if (this.fxProgram) return;
            let gl = this.gl;
            this.fxProgram = createProgram(gl, FX_VERTEX_GLSL, fxFragmentGlsl());
            this.fxUniforms = {
                viewProjection: gl.getUniformLocation(this.fxProgram, 'uViewProjection'),
                flat: gl.getUniformLocation(this.fxProgram, 'uFlat')
            };
            this.fxBuffer = gl.createBuffer();
            this.fxBufferBytes = 0;
            let planeData = createPlaneData();
            let sources = [createCenteredCubeData(), createOrbData(), createSpikeData(), planeData];
            this.fxMeshes = sources.map(data => {
                let mesh = createMesh(gl, data.positions, data.normals, data.indices, null);
                gl.bindVertexArray(mesh.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuffer);
                for (let row = 0; row < 4; row++) {
                    gl.enableVertexAttribArray(3 + row);
                    gl.vertexAttribDivisor(3 + row, 1);
                }
                return mesh;
            });
            gl.bindVertexArray(null);
        }

        // One upload of every mesh's instances, then one draw per mesh.
        drawFx(batch, flat) {
            if (!batch || batch.total <= 0) return;
            this.ensureFxResources();
            let gl = this.gl;
            let bytes = batch.total * FX_STRIDE * 4;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuffer);
            if (this.fxBufferBytes < bytes) {
                this.fxBufferBytes = Math.max(64 * 1024, bytes * 2);
                gl.bufferData(gl.ARRAY_BUFFER, this.fxBufferBytes, gl.DYNAMIC_DRAW);
            }
            let offsets = this.fxOffsets || (this.fxOffsets = new Int32Array(FX_MESH_COUNT));
            let offset = 0;
            for (let mesh = 0; mesh < FX_MESH_COUNT; mesh++) {
                let count = batch.count[mesh];
                offsets[mesh] = offset;
                if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, offset, batch.data[mesh], 0, count * FX_STRIDE);
                offset += count * FX_STRIDE * 4;
            }
            gl.useProgram(this.fxProgram);
            gl.uniformMatrix4fv(this.fxUniforms.viewProjection, false, this.tmpViewProjection);
            gl.uniform1f(this.fxUniforms.flat, flat ? 1 : 0);
            if (flat) gl.disable(gl.DEPTH_TEST);
            else gl.enable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
            // Decals first: ground marks sit under shots and debris.
            for (let mesh of [FX_MESH_DECAL, FX_MESH_BOX, FX_MESH_SPIKE, FX_MESH_ORB]) {
                let count = batch.count[mesh];
                if (count <= 0) continue;
                let fxMesh = this.fxMeshes[mesh];
                gl.bindVertexArray(fxMesh.vao);
                // No base instance in WebGL2: point the attributes at this mesh's run.
                for (let row = 0; row < 4; row++) gl.vertexAttribPointer(3 + row, 4, gl.FLOAT, false, FX_STRIDE * 4, offsets[mesh] + row * 16);
                gl.drawElementsInstanced(gl.TRIANGLES, fxMesh.indexCount, gl.UNSIGNED_INT, 0, count);
            }
            gl.drawBuffers(this.sceneDrawBuffers);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
            gl.bindVertexArray(null);
        }

        // Scene objects (3D-style) for the flat view: converted into a batch.
        drawFlatSprites(objects) {
            const batch = this.flatObjectBatch || (this.flatObjectBatch = new FlatSpriteBatch());
            batch.reset();
            for (let i = 0; i < objects.length; i++) batch.pushObject(objects[i]);
            this.drawFlatBatch(batch);
        }

        getFlatAtlas() {
            return this.flatAtlas || (this.flatAtlas = new FlatSpriteAtlas(this.gl));
        }

        // One upload of the whole instance buffer, then one draw per run.
        // Panels, tiles and untextured sprites share a run through the
        // texture array; only other textures split runs. Runs keep painter
        // order: sprites are never sorted.
        drawFlatBatch(batch) {
            const gl = this.gl;
            const count = batch.count;
            if (!this.flatProgram) {
                this.flatProgram = createProgram(gl, `#version 300 es
                    precision highp float;
                    layout(location=0) in vec4 rect;
                    layout(location=1) in vec4 tint;
                    layout(location=2) in float angle;
                    layout(location=3) in float layer;
                    uniform mat4 viewProjection;
                    out vec2 uv;
                    out vec4 color;
                    flat out float spriteLayer;
                    void main() {
                        vec2 p = vec2(float(gl_VertexID % 2), float(gl_VertexID / 2));
                        uv = vec2(p.x, 1. - p.y);
                        vec2 d = (p - .5) * rect.zw;
                        float c = cos(angle), s = sin(angle);
                        vec2 world = rect.xy + vec2(c*d.x-s*d.y,s*d.x+c*d.y);
                        gl_Position = viewProjection * vec4(world.x, .1, world.y, 1.);
                        color = tint;
                        spriteLayer = layer;
                    }`, `#version 300 es
                    precision highp float;
                    precision highp sampler2DArray;
                    uniform sampler2D sprite;
                    uniform sampler2DArray atlas;
                    in vec2 uv;
                    in vec4 color;
                    flat in float spriteLayer;
                    layout(location=0) out vec4 outColor;
                    void main() {
                        // Sampled unconditionally: mip selection needs
                        // derivatives from uniform control flow.
                        vec4 layered = texture(atlas, vec3(uv, max(spriteLayer, 0.)));
                        vec4 single = texture(sprite, uv);
                        vec4 texel = spriteLayer >= 0. ? layered : spriteLayer > -1.5 ? single : vec4(1.);
                        outColor = texel * color;
                    }`);
                this.flatVao = gl.createVertexArray();
                this.flatBuffer = gl.createBuffer();
                this.flatBufferBytes = 0;
                this.flatUniforms = {
                    matrix: gl.getUniformLocation(this.flatProgram, 'viewProjection'),
                    sprite: gl.getUniformLocation(this.flatProgram, 'sprite'),
                    atlas: gl.getUniformLocation(this.flatProgram, 'atlas')
                };
                gl.bindVertexArray(this.flatVao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffer);
                for (let location = 0; location < 4; location++) {
                    gl.enableVertexAttribArray(location);
                    gl.vertexAttribDivisor(location, 1);
                }
            }
            if (!count) return;
            const data = batch.data, textures = batch.textures;
            const atlas = this.getFlatAtlas();
            atlas.beginFrame(this.textureFrame);
            for (let i = 0, o = FLAT_LAYER; i < count; i++, o += FLAT_STRIDE) {
                const texture = textures[i];
                data[o] = texture ? atlas.layerFor(texture) : FLAT_UNTEXTURED;
            }
            atlas.endFrame();
            this.flatData = data;
            gl.useProgram(this.flatProgram);
            gl.bindVertexArray(this.flatVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffer);
            const bytes = count * FLAT_STRIDE * 4;
            if (this.flatBufferBytes < bytes) {
                this.flatBufferBytes = Math.max(64 * 1024, bytes * 2);
                gl.bufferData(gl.ARRAY_BUFFER, this.flatBufferBytes, gl.DYNAMIC_DRAW);
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * FLAT_STRIDE);
            gl.uniformMatrix4fv(this.flatUniforms.matrix, false, this.tmpViewProjection);
            gl.uniform1i(this.flatUniforms.sprite, 0);
            gl.uniform1i(this.flatUniforms.atlas, 1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.texture);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
            for (let start = 0; start < count;) {
                let end = start + 1;
                let texture = null;
                if (data[start * FLAT_STRIDE + FLAT_LAYER] === FLAT_SINGLE) {
                    texture = textures[start];
                    while (end < count && data[end * FLAT_STRIDE + FLAT_LAYER] === FLAT_SINGLE && textures[end] === texture) end++;
                    gl.bindTexture(gl.TEXTURE_2D, this.getTopTexture(flatTextureKey(texture), texture));
                } else {
                    while (end < count && data[end * FLAT_STRIDE + FLAT_LAYER] !== FLAT_SINGLE) end++;
                }
                // No base instance in WebGL2: offset the attributes instead.
                const base = start * FLAT_STRIDE * 4;
                gl.vertexAttribPointer(0, 4, gl.FLOAT, false, FLAT_STRIDE * 4, base);
                gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLAT_STRIDE * 4, base + 16);
                gl.vertexAttribPointer(2, 1, gl.FLOAT, false, FLAT_STRIDE * 4, base + 32);
                gl.vertexAttribPointer(3, 1, gl.FLOAT, false, FLAT_STRIDE * 4, base + 36);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - start);
                start = end;
            }
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
            gl.activeTexture(gl.TEXTURE0);
            gl.drawBuffers(this.sceneDrawBuffers);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
        }

        visitScaleCandidates(candidates, visit) {
            if (this.columnLayers) {
                const C = this.columnLayers;
                for (const source of candidates || C.unitSources.concat(C.structureSources)) {
                    if (!source || source.dead || source.energy <= 0 || source._historyGhost) continue;
                    const F = source._structView ? C.structures : C.units, s = source._s;
                    if (!(s >= 0)) continue;
                    const moving = !source._structView;
                    if (moving && (F.flags[s] & 1024)) continue;
                    const x = F.x[s] / C.tile, z = F.y[s] / C.tile;
                    if (!C.fullVisibility && !(C.visibility[Math.floor(z)] && C.visibility[Math.floor(z)][Math.floor(x)] > 0)) continue;
                    visit(source, moving ? (F.px[s] + (F.x[s] - F.px[s]) * C.alpha) / C.tile : x,
                        moving ? (F.py[s] + (F.y[s] - F.py[s]) * C.alpha) / C.tile : z,
                        moving ? Math.max(.28, Math.min(.9, F.r[s] * 2.2 / C.tile)) : .94, .02);
                }
                return;
            }
            for (const layer of this.scaleLayers || []) {
                if (!layer.sourceIndex) layer.sourceIndex = new Map(layer.sources.map((source, i) => [source, i]));
                const d = layer.data, a = layer.alpha;
                for (const source of candidates || layer.sources) {
                    const i = layer.sourceIndex.get(source);
                    if (i === undefined || source.dead || source.energy <= 0 || source._historyGhost) continue;
                    const o = i * 12;
                    visit(source, d[o + 2] + (d[o] - d[o + 2]) * a, d[o + 3] + (d[o + 1] - d[o + 3]) * a,
                        d[o + 4], this.lodPixelsPerWorld < 4 ? .015 : d[o + 5] * .5);
                }
            }
        }

        pickScaleSource(x, y, candidates) {
            let best = null, distance = Infinity;
            this.visitScaleCandidates(candidates, (source, wx, wz, size, height) => {
                const p = this.projectWorldToScreen(wx, height, wz);
                if (!p) return;
                const radius = Math.max(2, this.pixelsPerWorldAt(wx, height, wz) * size * .7);
                const d = (p.x - x) ** 2 + (p.y - y) ** 2;
                if (d <= radius * radius && d < distance) { distance = d; best = source; }
            });
            return best;
        }

        // Consume the worker's existing SoA columns without visiting entities,
        // building matrices, copying records or sorting. Each GPU point is a
        // screen-facing unit/building glyph. Visibility and transforms are GPU work.
        drawFrameColumns(C, snapshot) {
            const gl = this.gl;
            if (!this.columnProgram) {
                this.columnProgram = createProgram(gl, `#version 300 es
                    precision highp float;
                    precision highp int;
                    layout(location=0) in float aX;
                    layout(location=1) in float aZ;
                    layout(location=2) in float aPX;
                    layout(location=3) in float aPZ;
                    layout(location=4) in float aRadius;
                    layout(location=5) in float aEnergy;
                    layout(location=6) in float aOwner;
                    layout(location=7) in float aFlags;
                    layout(location=8) in float aAlive;
                    layout(location=9) in float aKind;
                    uniform mat4 uViewProjection;
                    uniform float uAlpha, uTile, uScale, uFlat, uLightNorm;
                    uniform int uStructure, uFull;
                    uniform vec3 uColors[9];
                    uniform sampler2D uVisibility;
                    out vec4 vColor;
                    void main() {
                        vec2 current = vec2(aX,aZ) / uTile;
                        vec2 p = uStructure != 0 ? current : mix(vec2(aPX,aPZ) / uTile,current,uAlpha);
                        int flags = int(aFlags);
                        bool alive = uStructure != 0 ? aAlive > 0. : aAlive >= 0. && (flags & 1024) == 0;
                        float light = uFull != 0 ? 1. : texelFetch(uVisibility,ivec2(current),0).r / uLightNorm;
                        if (!alive || (aEnergy <= 0. && (uStructure == 0 || aKind < 4.)) || light <= 0.) { gl_Position=vec4(2.,2.,2.,1.); gl_PointSize=1.; vColor=vec4(0.); return; }
                        gl_Position = uViewProjection * vec4(p.x,.02,p.y,1.);
                        float size = uStructure != 0 ? .94 : clamp(aRadius * 2.2 / uTile,.28,.9);
                        gl_PointSize = clamp(size * uScale / (uFlat > .5 ? 1. : max(.01,gl_Position.w)),1.,64.);
                        float shade = .35 + .65 * clamp(light,0.,1.);
                        vColor = vec4(uColors[clamp(int(aOwner)+1,0,8)] * shade, uStructure != 0 && (flags & 1) != 0 ? .6 : 1.);
                    }`, `#version 300 es
                    precision highp float;
                    precision highp int;
                    uniform int uStructure;
                    in vec4 vColor;
                    out vec4 color;
                    void main() {
                        if (vColor.a <= 0.) discard;
                        vec2 p = gl_PointCoord * 2. - 1.;
                        if (uStructure == 0 && dot(p,p) > 1.) discard;
                        color = vColor;
                    }`);
                this.columnUniforms = {};
                for (const n of ['ViewProjection','Alpha','Tile','Scale','Flat','LightNorm','Structure','Full','Colors','Visibility']) this.columnUniforms[n] = gl.getUniformLocation(this.columnProgram,'u'+n);
                this.columnStores = [{},{}];
                this.columnVisibilityTexture = createTexture(gl);
            }
            const U = this.columnUniforms;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.columnVisibilityTexture);
            if (!C.fullVisibility && (this.columnVisibilityVersion !== C.visibilityVersion || this.columnVisibilitySource !== C.visibility)) {
                const width = snapshot.worldWidth, height = snapshot.worldHeight;
                if (!this.columnVisibilityData || this.columnVisibilityData.length !== width * height) this.columnVisibilityData = new Float32Array(width * height);
                const data = this.columnVisibilityData;
                for (let y=0; y<height; y++) data.set(C.visibility[y],y*width);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
                if (this.columnVisibilityWidth !== width || this.columnVisibilityHeight !== height) {
                    gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,width,height,0,gl.RED,gl.FLOAT,data);
                    this.columnVisibilityWidth=width;this.columnVisibilityHeight=height;
                } else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,width,height,gl.RED,gl.FLOAT,data);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
                this.columnVisibilityVersion=C.visibilityVersion;this.columnVisibilitySource=C.visibility;
            } else if (!this.columnVisibilityWidth) {
                gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1,1,0,gl.RED,gl.FLOAT,new Float32Array([1]));
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
            }
            gl.useProgram(this.columnProgram);
            gl.uniformMatrix4fv(U.ViewProjection,false,this.tmpViewProjection);
            gl.uniform1f(U.Alpha,C.alpha);gl.uniform1f(U.Tile,C.tile);
            gl.uniform1f(U.LightNorm,Math.max(.001,C.lightNorm));
            gl.uniform1f(U.Flat,snapshot.flat2d?1:0);
            gl.uniform1f(U.Scale,snapshot.flat2d ? this.sceneTargetSize.width / (snapshot.camera.visibleWidth * (this.cssWidth / snapshot.viewportWidth)) : this.lodProjectionScale * this.pixelRatio);
            gl.uniform1i(U.Full,C.fullVisibility?1:0);gl.uniform1i(U.Visibility,0);
            const colors = this.columnColors || (this.columnColors = new Float32Array(27));
            for (let i=0;i<9;i++) colors.set(hexToRgb(C.colors[i]),i*3);
            gl.uniform3fv(U.Colors,colors);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.NONE]);
            if (snapshot.flat2d) gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
            for (let kind=0;kind<2;kind++) {
                const F = kind ? C.units : C.structures, S = this.columnStores[kind], structure = !kind;
                const fields = structure ? ['x','y','x','y',null,'energy','owner','flags','alive','kind'] : ['x','y','px','py','r','energy','owner','flags','id',null];
                if (!S.buffer) { S.buffer=gl.createBuffer();S.vao=gl.createVertexArray(); }
                gl.bindVertexArray(S.vao);gl.bindBuffer(gl.ARRAY_BUFFER,S.buffer);
                if (S.frame !== F) {
                    const bytes = F.buf.byteLength;
                    if (!S.bytes || S.bytes < bytes) { S.bytes=bytes;gl.bufferData(gl.ARRAY_BUFFER,bytes,gl.DYNAMIC_DRAW); }
                    const seen = new Set();
                    for (let i=0;i<fields.length;i++) {
                        const name=fields[i];
                        if (!name) {gl.disableVertexAttribArray(i);gl.vertexAttrib1f(i,1);continue;}
                        const a=F[name], type=a instanceof Float32Array?gl.FLOAT:a instanceof Int32Array?gl.INT:a instanceof Int16Array?gl.SHORT:gl.UNSIGNED_BYTE;
                        if (!seen.has(name)) {gl.bufferSubData(gl.ARRAY_BUFFER,a.byteOffset,a);seen.add(name);}
                        gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,1,type,false,0,a.byteOffset);
                    }
                    S.frame=F;
                }
                gl.uniform1i(U.Structure,structure?1:0);
                gl.drawArrays(gl.POINTS,0,F.n);
            }
            gl.disable(gl.BLEND);gl.enable(gl.DEPTH_TEST);gl.drawBuffers(this.sceneDrawBuffers);
        }

        disposeFrameColumns() {
            for (const S of this.columnStores || []) {
                if (S.buffer) this.gl.deleteBuffer(S.buffer);
                if (S.vao) this.gl.deleteVertexArray(S.vao);
            }
            this.columnStores=[{},{}];this.columnLayers=null;
        }

        // Small shared geometry replaces invisible panel/model detail at army
        // scale. Positions, facing and interpolation remain entirely on GPU.
        drawScaleInstances(layer, flat) {
            if (!layer || !layer.count) return;
            const gl = this.gl;
            if (!this.scaleProgram) {
                this.scaleProgram = createProgram(gl, `#version 300 es
                    precision highp float;
                    layout(location=0) in vec3 aPosition;
                    layout(location=1) in vec3 aNormal;
                    layout(location=3) in vec4 aMotion;
                    layout(location=4) in vec4 aShape;
                    layout(location=5) in vec4 aColor;
                    uniform mat4 uViewProjection;
                    uniform float uAlpha;
                    uniform float uFlat;
                    out vec4 vColor;
                    out vec2 vLocal;
                    flat out float vKind;
                    void main() {
                        vec3 p = aPosition;
                        vLocal = p.xz * 2.0;
                        vKind = aShape.w;
                        if (aShape.w < .5 && uFlat < .5) p.xz *= 1.0 - p.y * .6;
                        p *= vec3(aShape.x, aShape.y, aShape.x);
                        float c = cos(aShape.z), s = sin(aShape.z);
                        p.xz = mat2(c,-s,s,c) * p.xz;
                        vec2 center = mix(aMotion.zw, aMotion.xy, uAlpha);
                        p += vec3(center.x, .015, center.y);
                        gl_Position = uViewProjection * vec4(p,1.0);
                        float light = uFlat > .5 ? 1.0 : .65 + .35 * max(0.0, dot(aNormal, normalize(vec3(.4,1.,.3))));
                        vColor = vec4(aColor.rgb * light, aColor.a);
                    }`, `#version 300 es
                    precision highp float;
                    in vec4 vColor;
                    in vec2 vLocal;
                    flat in float vKind;
                    uniform float uFlat;
                    layout(location=0) out vec4 color;
                    void main() {
                        if (uFlat > .5 && vKind < .5 && dot(vLocal,vLocal) > 1.) discard;
                        color = vColor;
                    }`);
                this.scaleUniforms = {};
                for (const name of ['ViewProjection', 'Alpha', 'Flat']) this.scaleUniforms[name] = gl.getUniformLocation(this.scaleProgram, 'u' + name);
                const cube = createCubeData(), plane = createPlaneData();
                this.scaleMeshes = [createMesh(gl, cube.positions, cube.normals, cube.indices), createMesh(gl, plane.positions, plane.normals, plane.indices)];
            }
            const impostor = flat || this.lodPixelsPerWorld < 4;
            const buffer = layer.upload(gl), mesh = this.scaleMeshes[impostor ? 1 : 0];
            gl.useProgram(this.scaleProgram);
            gl.uniformMatrix4fv(this.scaleUniforms.ViewProjection, false, this.tmpViewProjection);
            gl.uniform1f(this.scaleUniforms.Alpha, layer.alpha);
            gl.uniform1f(this.scaleUniforms.Flat, impostor ? 1 : 0);
            gl.bindVertexArray(mesh.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            for (let i = 0; i < 3; i++) {
                gl.enableVertexAttribArray(3 + i);
                gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, 48, i * 16);
                gl.vertexAttribDivisor(3 + i, 1);
            }
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
            if (flat) gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, layer.count);
            gl.disable(gl.BLEND);
            gl.enable(gl.DEPTH_TEST);
            gl.drawBuffers(this.sceneDrawBuffers);
        }

        render(snapshot) {
            if (!this.enabled || !this.supported || !snapshot) return;
            this.resizeForSnapshot(snapshot);
            this.buildViewProjection(snapshot);
            this.textureFrame = (this.textureFrame || 0) + 1;
            this.resetInstanceArena();
            // Seconds for time-driven structure animation (kept small for float precision).
            this.animationTime = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000) % 3600;

            let gl = this.gl;
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
            let overlays = snapshot.overlays || null;
            let needsOverlayDepth = !snapshot.flat2d && !!(overlays && ((overlays.bars && overlays.bars.length > 0) || (overlays.texts && overlays.texts.length > 0)));
            // Packed depth is written only for frames that read it back, and
            // with MSAA it is packed from the resolved depth texture instead.
            this.sceneDrawBuffers = needsOverlayDepth && !this.sceneSamples ? SCENE_DRAW_BUFFERS_WITH_DEPTH : SCENE_DRAW_BUFFERS_COLOR;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneSamples ? this.msaaFramebuffer : this.sceneFramebuffer);
            gl.drawBuffers(this.sceneDrawBuffers);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.drawBackground(snapshot);
            this.scaleLayers = snapshot.scaleLayers || null;
            this.columnLayers = snapshot.columnLayers || null;
            if (this.scaleLayers) {
                this.pickObjects = [];
                this.unitLayerObjects = this.unitLayerRecordPicks = null;
                this.unitLayerDraws = this.staticGroups = null;
                this.unitLayerVersion = this.staticLayerVersion = -1;
                this.pickInverseViewProjection = new Float32Array(this.tmpInverseViewProjection);
                this.pickViewProjection = new Float32Array(this.tmpViewProjection);
                this.pickViewPad = this.viewPad;
                this.shadowFrame = null;
                for (const layer of this.scaleLayers) this.drawScaleInstances(layer, snapshot.flat2d);
                if (this.columnLayers) this.drawFrameColumns(this.columnLayers,snapshot);
                this.drawFx(snapshot.fx, snapshot.flat2d);
                this.drawGroundOverlays(overlays);
                this.resolveScene();
                // Glyphs have no model depth to shade: skip SSAO/shadow/outline
                // passes. Keep the user's color grading and antialiasing.
                this.presentSceneToCanvas(true);
                this.trimTopTextures();
                return;
            }
            let objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
            if (snapshot.flat2d) {
                if (snapshot.flatBatch) this.drawFlatBatch(snapshot.flatBatch);
                else this.drawFlatSprites(objects);
                this.drawFx(snapshot.fx, true);
                this.drawGroundOverlays(snapshot.overlays);
                this.resolveScene();
                this.presentSceneToCanvas(true);
                this.trimTopTextures();
                return;
            }
            // Retain the transforms/LOD actually drawn, without rebuilding the scene on clicks.
            this.pickObjects = [];
            this.pickInverseViewProjection = new Float32Array(this.tmpInverseViewProjection);
            this.pickViewPad = this.viewPad;
            this.pickViewProjection = new Float32Array(this.tmpViewProjection);
            let opaqueCubeGroups = new Map();
            let transparentCubeGroups = new Map();
            // Textured groups persist between frames (keyed as before) and are
            // listed in first-use order each frame, so the draw order matches
            // a freshly built map without rebuilding groups for every frame.
            let frame = this.textureFrame;
            let groupCaches = this.texturedGroupCaches || (this.texturedGroupCaches = [new Map(), new Map()]);
            let opaqueTexturedCubeGroups = this.opaqueTexturedGroupList || (this.opaqueTexturedGroupList = []);
            let transparentTexturedCubeGroups = this.transparentTexturedGroupList || (this.transparentTexturedGroupList = []);
            opaqueTexturedCubeGroups.length = transparentTexturedCubeGroups.length = 0;
            let opaqueMeshObjects = [];
            let transparentMeshObjects = [];
            let shadowBatches = this.beginShadowBatches();
            let shadowMeshObjects = [];
            let shadowMode = this.graphicsOptions ? this.graphicsOptions.shadows : 'simple';
            let castShadows = shadowMode === 'simple';
            this.shadowFrame = null;
            // The unit layer (drawn from its own buffer); what it cannot draw
            // joins this frame's objects.
            let unitLayer = snapshot.unitLayer || null;
            let layerAtlas = null;
            if (unitLayer) {
                layerAtlas = this.getFlatAtlas();
                layerAtlas.beginFrame(this.textureFrame);
                let rest = this.prepareUnitLayer(unitLayer, layerAtlas);
                if (rest && rest.length) objects = objects.concat(rest);
                for (let e of this.unitLayerPicks) this.pickObjects.push(e);
            } else {
                this.unitLayerDraws = null; this.unitLayerPicks = null; this.unitLayerObjects = null; this.unitLayerVersion = -1; this.unitLayerShadow = null;
            }
            let staticLayer = snapshot.staticLayer || null;
            if (staticLayer) {
                if (!layerAtlas) { layerAtlas = this.getFlatAtlas(); layerAtlas.beginFrame(this.textureFrame); }
                this.prepareStaticLayer(staticLayer);
                for (let e of this.staticGroups.picks) this.pickObjects.push(e);
            } else {
                this.staticGroups = null; this.staticLayerVersion = -1;
            }
            for (let i = 0; i < objects.length; i++) {
                let object = objects[i];
                let isTransparent = (Number(object.alpha) || 1) < 0.999;
                let figureMeshKey = this.getFigureMeshKey(object);
                let mesh = figureMeshKey ? null : this.requestModel(object);
                let textured = (object.topTextureKey && object.topTextureCanvas) || (object.sideTextureKey && object.sideTextureCanvas);
                if (object.pickSource) {
                    let pickMesh = mesh || (textured && figureMeshKey && this.getFigureMesh(figureMeshKey)) || this.getPrimitiveMesh(object);
                    // One record per object, reused between frames.
                    let entry = object._r3dPick || (object._r3dPick = { object, mesh: null });
                    entry.mesh = pickMesh;
                    this.pickObjects.push(entry);
                }
                if (castShadows) {
                    if (mesh) {
                        let shadow = this.getShadowInfo(object);
                        if (shadow) shadowMeshObjects.push({ object, shadow });
                    } else {
                        this.pushShadowInstance(object);
                    }
                }
                if (mesh) {
                    (isTransparent ? transparentMeshObjects : opaqueMeshObjects).push(object);
                } else if (textured) {
                    // Scene objects are reused between frames with the same
                    // textures and shape; only the LOD mesh key can change.
                    let groupKey = object._r3dGroupFigure === figureMeshKey ? object._r3dGroupKey : undefined;
                    if (groupKey === undefined) {
                        // Figures with exact 2D panels differ only by atlas layer.
                        let atlasPanel = !!(figureMeshKey && isAtlasPanel(object));
                        groupKey = atlasPanel
                            ? `atlas|${figureMeshKey}|anim:${Number(object.animationMode) || 0}`
                            : `${object.topTextureKey || ''}|${object.sideTextureKey || ''}|${figureMeshKey || object.renderShape || 'box'}|anim:${Number(object.animationMode) || 0}`;
                        object._r3dGroupKey = groupKey;
                        object._r3dGroupFigure = figureMeshKey;
                    }
                    let groupCache = groupCaches[isTransparent ? 1 : 0];
                    let group = groupCache.get(groupKey);
                    if (!group) {
                        group = { topTexture: null, sideTexture: null, objects: [], frame: -1, atlas: groupKey.startsWith('atlas|') };
                        groupCache.set(groupKey, group);
                    }
                    if (group.frame !== frame) {
                        group.frame = frame;
                        group.objects.length = 0;
                        group.topTexture = group.atlas ? null : this.getTopTexture(object.topTextureKey, object.topTextureCanvas);
                        // Procedural panels use the full 2D status canvas; avoid
                        // uploading the obsolete audio texture for these models.
                        group.sideTexture = !figureMeshKey && !group.atlas && object.sideTextureKey && object.sideTextureCanvas ? this.getTopTexture(object.sideTextureKey, object.sideTextureCanvas) : null;
                        (isTransparent ? transparentTexturedCubeGroups : opaqueTexturedCubeGroups).push(group);
                    }
                    group.objects.push(object);
                } else {
                    let targetGroups = isTransparent ? transparentCubeGroups : opaqueCubeGroups;
                    let groupKey = object.renderShape || 'box';
                    let group = targetGroups.get(groupKey);
                    if (!group) {
                        group = [];
                        targetGroups.set(groupKey, group);
                    }
                    group.push(object);
                }
            }
            this.drawShadows(shadowMeshObjects, shadowBatches);
            for (let object of opaqueMeshObjects) this.drawObject(object);
            let atlas = layerAtlas || (opaqueTexturedCubeGroups.length || transparentTexturedCubeGroups.length ? this.getFlatAtlas() : null);
            if (atlas && !layerAtlas) atlas.beginFrame(this.textureFrame);
            for (let group of opaqueTexturedCubeGroups) {
                this.drawTexturedCubeInstances(group.objects, group.topTexture, group.sideTexture, group.atlas ? atlas : null);
            }
            if (unitLayer) this.drawUnitLayer(atlas);
            if (staticLayer) this.drawStaticLayer(atlas);
            for (let group of opaqueCubeGroups.values()) {
                this.drawCubeInstances(group);
            }
            if (shadowMode === 'detailed' || shadowMode === 'high') {
                this.renderShadowMap(snapshot, shadowMode, opaqueMeshObjects, opaqueTexturedCubeGroups, opaqueCubeGroups, atlas);
            }
            if (transparentMeshObjects.length > 0 || transparentCubeGroups.size > 0 || transparentTexturedCubeGroups.length > 0) {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                transparentMeshObjects.sort((a, b) => {
                    let adx = a.x - snapshot.camera.centerX;
                    let adz = a.z - snapshot.camera.centerZ;
                    let bdx = b.x - snapshot.camera.centerX;
                    let bdz = b.z - snapshot.camera.centerZ;
                    return (bdx * bdx + bdz * bdz) - (adx * adx + adz * adz);
                });
                for (let object of transparentMeshObjects) this.drawObject(object);
                for (let group of transparentTexturedCubeGroups) {
                    this.drawTexturedCubeInstances(group.objects, group.topTexture, group.sideTexture, group.atlas ? atlas : null);
                }
                for (let group of transparentCubeGroups.values()) {
                    this.drawCubeInstances(group);
                }
                gl.depthMask(true);
                gl.disable(gl.BLEND);
            }
            if (atlas) atlas.endFrame();
            this.drawFx(snapshot.fx, false);
            this.drawGroundOverlays(overlays);
            let postNeedsDepth = !!(this.postProcess && this.graphicsOptions && this.postProcess.needsDepth(this.graphicsOptions, false));
            this.resolveScene(needsOverlayDepth || postNeedsDepth);
            if (needsOverlayDepth) this.captureOverlayDepthFrame();
            this.presentSceneToCanvas(false);
            // Delete GPU resources as well as JS entries. Never evict a texture
            // used in this frame; amortize cleanup after camera sweeps/battles.
            this.trimTopTextures();
            if (frame % 120 === 0) this.trimTexturedGroups(frame - 120);
            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        ensureShadowMap(size) {
            let gl = this.gl;
            size = Math.min(size, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048);
            if (this.shadowMap && this.shadowMap.size === size) return this.shadowMap;
            if (this.shadowMap) {
                gl.deleteTexture(this.shadowMap.tex);
                gl.deleteFramebuffer(this.shadowMap.fb);
            }
            let tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
            // Hardware depth comparison with bilinear PCF.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
            gl.bindTexture(gl.TEXTURE_2D, null);
            let fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
            gl.drawBuffers([gl.NONE]);
            gl.readBuffer(gl.NONE);
            this.shadowMap = { tex, fb, size, lightViewProjection: new Float32Array(16), view: new Float32Array(16) };
            return this.shadowMap;
        }

        // Settings > Shadows: detailed/high. Re-issues this frame's opaque
        // draws from the light into a depth-only target, so every geometry
        // path (animated figures, textured panels, models) casts exactly as
        // drawn. The post pass resolves it against the scene depth.
        renderShadowMap(snapshot, mode, meshObjects, texturedGroups, cubeGroups, atlas) {
            let gl = this.gl;
            let map = this.ensureShadowMap(mode === 'high' ? 4096 : 2048);
            // World units covered by the (square) map, or 0 when nothing is visible.
            let extent = buildShadowViewProjection(map.lightViewProjection, map.view, this.tmpInverseViewProjection,
                Number(snapshot.worldWidth) || 0, Number(snapshot.worldHeight) || 0, map.size);
            if (!extent) return;
            let cameraViewProjection = this.tmpViewProjection;
            let sceneDrawBuffers = this.sceneDrawBuffers;
            this.tmpViewProjection = map.lightViewProjection;
            this.sceneDrawBuffers = SHADOW_DRAW_BUFFERS;
            gl.bindFramebuffer(gl.FRAMEBUFFER, map.fb);
            gl.viewport(0, 0, map.size, map.size);
            gl.depthMask(true);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.colorMask(false, false, false, false);
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(1.6, 4);
            try {
                for (let object of meshObjects) this.drawObject(object);
                for (let group of texturedGroups) this.drawTexturedCubeInstances(group.objects, group.topTexture, group.sideTexture, group.atlas ? atlas : null);
                if (this.unitLayerDraws) this.drawUnitLayer(atlas);
                if (this.staticGroups) this.drawStaticLayer(atlas);
                for (let group of cubeGroups.values()) this.drawCubeInstances(group);
            } finally {
                gl.disable(gl.POLYGON_OFFSET_FILL);
                gl.colorMask(true, true, true, true);
                this.tmpViewProjection = cameraViewProjection;
                this.sceneDrawBuffers = sceneDrawBuffers;
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneSamples ? this.msaaFramebuffer : this.sceneFramebuffer);
                gl.drawBuffers(sceneDrawBuffers);
                gl.viewport(0, 0, this.sceneTargetSize.width, this.sceneTargetSize.height);
            }
            this.shadowFrame = {
                tex: map.tex, size: map.size, lightViewProjection: map.lightViewProjection,
                inverseViewProjection: this.tmpInverseViewProjection, taps: mode === 'high' ? 16 : 9,
                lightDirection: SHADOW_LIGHT_DIRECTION, worldTexel: extent / map.size
            };
        }

        trimTexturedGroups(oldestFrame) {
            for (let groupCache of this.texturedGroupCaches || []) {
                for (let [key, group] of groupCache) if (group.frame < oldestFrame) groupCache.delete(key);
            }
        }

        trimTopTextures() {
            const gl = this.gl;
            if (this.topTextureCache.size > 1024) {
                let remaining = 16;
                for (let [key, entry] of this.topTextureCache) {
                    if (entry.lastUsedFrame >= this.textureFrame - 2) continue;
                    gl.deleteTexture(entry.texture);
                    this.topTextureCache.delete(key);
                    if (--remaining <= 0 || this.topTextureCache.size <= 1024) break;
                }
            }
        }
    }

    Defence3Renderer3D.FlatSpriteBatch = FlatSpriteBatch;
    Defence3Renderer3D.PersistentInstances = PersistentInstances;
    Defence3Renderer3D.FxBatch = FxBatch;
    Defence3Renderer3D.FX_MESH = { BOX: FX_MESH_BOX, ORB: FX_MESH_ORB, SPIKE: FX_MESH_SPIKE, DECAL: FX_MESH_DECAL };
    Defence3Renderer3D.FX_PATTERN = FX_PATTERN;
    Defence3Renderer3D.workshopMiniature = workshopMiniature;
    window.Defence3Renderer3D = Defence3Renderer3D;
})();
