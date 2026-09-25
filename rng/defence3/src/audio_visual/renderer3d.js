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
            if (source.width !== FLAT_ATLAS_SIZE || source.height !== FLAT_ATLAS_SIZE) return FLAT_SINGLE;
            let slot = source._flatAtlasSlot;
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
    // one object/draw per limb. Surface IDs: type-colored cloth, neutral armor, player trim,
    // eyes and the complete 2D status render (on dedicated rectangular quads).
    function createFigureData(kind, simplified = false) {
        let variant = kind;
        kind = kind.split(':')[0];
        let weapon = variant.includes(':') ? variant.slice(variant.indexOf(':') + 1) : '';
        let positions = [], normals = [], indices = [], uvs = [], details = [];
        function part(x, y, z, sx, sy, sz, surface = 0, joint = 0, pivot = 0, taper = 1, yaw = 0) {
            // At strategic zoom, subpixel ornaments turn into noisy gray specks.
            // Keep broad plates (even thin ones), bodies, limbs and sprite panels.
            if (simplified) {
                let middleSize = sx + sy + sz - Math.min(sx, sy, sz) - Math.max(sx, sy, sz);
                let mainLimb = Math.abs(joint) === 1 && sy >= .25 && sx >= .13;
                let readableEquipment = !!weapon && (sy >= .20 || sx >= .20 || sz >= .20);
                if (surface === 3 || (middleSize < .18 && !mainLimb && !readableEquipment)) return;
            }
            let cube = createCubeData(), base = positions.length / 3;
            let yawCos = Math.cos(yaw), yawSin = Math.sin(yaw);
            for (let i = 0; i < cube.positions.length / 3; i++) {
                let px = cube.positions[i * 3], py = cube.positions[i * 3 + 1], pz = cube.positions[i * 3 + 2];
                let width = 1 + (taper - 1) * py;
                let localX = px * sx * width, localZ = pz * sz * width;
                positions.push(x + localX * yawCos + localZ * yawSin, y + py * sy, z - localX * yawSin + localZ * yawCos);
                uvs.push(cube.uvs[i * 2], 1 - cube.uvs[i * 2 + 1]);
                details.push(surface, joint, pivot, 0);
            }
            for (let index of cube.indices) indices.push(base + index);
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
        if (kind === 'figure' || kind === 'heavy' || kind === 'worker') {
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
            part(0, .19, -.205, .61, .47, .065, 0, 2, .66, .72); // cape
            part(0, .18, -.253, .53, .53, .04, 2); // rigid, readable back display
            panel(0, .20, -.277, .49, .49);
            if (kind === 'worker') {
                part(.38, .34, -.10, .19, .26, .22, 2, -1, .65);
                part(0, .79, 0, .56, .055, .47, 2); // worker helmet brim
                if (!weapon) {
                    part(.39, .17, .10, .065, .40, .065, 1, -1, .65);
                    part(.39, .48, .10, .28, .09, .12, 2, -1, .65); // fallback tool
                }
            } else if (kind === 'figure' && !weapon) {
                part(.36, .22, .12, .05, .40, .06, 2, -1, .65); // blade
            }
            if (kind === 'heavy') part(-.43, .26, .12, .24, .32, .10, 2, 1, .65);
            if (weapon === 'king_sword') for (let x of [-.18,0,.18]) part(x,.88,0,.07,.14,.12,2);
            if (['fire_blade','water_trident','ice_spear','poison_scythe','laser_staff'].includes(weapon)) {
                for (let side of [-1,1]) part(side*.34,.67,0,.15,.16,.19,2,0,0,.1);
            }
        } else if (kind === 'bird') {
            part(0,.30,0,.30,.25,.64,1,0,0,.65);
            part(0,.49,.25,.25,.21,.26,0,0,0,.55);
            part(0,.51,.43,.11,.06,.22,2,0,0,.1); // beak
            for (let side of [-1,1]) {
                part(side*.10,.60,.37,.045,.025,.035,3);
                part(side*.35,.43,-.04,.48,.065,.40,1,side*3);
                for (let feather=0;feather<3;feather++) {
                    part(side*(.55+feather*.085),.42,-.12-feather*.10,.30,.045,.19,feather===0?0:2,side*3,0,.15);
                }
            }
            part(0,.30,-.39,.33,.06,.35,2,0,0,.15);
            panel(0,.58,-.10,.43,.42,true);
            if (weapon === 'healer_staff' || weapon === 'research_orb') {
                part(0,.17,0,.31,.11,.28,0);
                part(0,.18,.145,.06,.09,.018,3);
            }
        } else if (kind === 'mole') {
            part(0,.07,0,.67,.39,.73,0,0,0,.55);
            part(0,.14,.39,.27,.17,.28,1,0,0,.12);
            for (let side of [-1,1]) part(side*.34,.025,.19,.19,.09,.40,2,side,.20);
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
            panel(0,.88,-.06,.66,.66,true);
        } else {
            part(0, 0, 0, 1, .12, 1, 1);
            part(0, .12, 0, .84, .075, .84, 2);
            if (kind === 'tower') {
                part(0, .18, 0, .57, .49, .57, 0, 0, 0, .76);
                part(0, .67, 0, .80, .19, .70, 1);
                part(0, .73, .31, .21, .14, .66, 2);
                part(0, .745, .645, .12, .10, .015, 3);
                panel(0, .88, 0, .94, .94, true, 0, 0, true);
                if (variant.endsWith(':twin')) for (let side of [-1,1]) part(side*.22,.73,.34,.10,.12,.66,2);
                if (variant.endsWith(':sniper')) part(0,.74,.56,.12,.10,.65,1);
                if (variant.endsWith(':energy')) for (let side of [-1,1]) part(side*.27,.49,.10,.12,.21,.16,3);
            } else if (kind === 'mine') {
                part(0,.19,0,.91,.30,.91,0);
                panel(0,.50,0,.98,.98,true);
            } else if (kind === 'item') {
                if (weapon === 'house') {
                    // Walls and eaves stay below the roof panel, or they hide it.
                    part(0,.195,0,.78,.40,.72,0,0,0,.92); // walls
                    part(0,.52,0,.92,.10,.84,2); // eaves
                    part(0,.195,.375,.25,.30,.035,1); // front door
                    panel(0,.63,0,.86,.78,true,0,0,true);
                } else {
                    part(0, .20, 0, .69, .47, .69, 0, 0, 0, .8);
                    panel(0, .85, 0, .96, .96, true, 0, 0, true);
                    for (let side of [-1, 1]) part(side * .40, .22, 0, .09, .62, .72, 2);
                }
            } else {
                part(0, .19, 0, .76, .52, .76, 0);
                for (let x of [-.4, .4]) for (let z of [-.4, .4]) part(x, .17, z, .14, .64, .14, 1);
                part(0, .72, 0, .91, .16, .90, 1, 0, 0, .67);
                panel(0, .89, 0, .94, .94, true, 0, 0, true);
                part(0, .20, .391, .28, .40, .02, 1);
                part(0, .61, .405, .40, .045, .02, 3);
                if (variant.endsWith(':healer')) {
                    part(0,.30,-.405,.09,.29,.025,3);
                    part(0,.40,-.42,.29,.09,.025,3);
                }
                // Keep the roof HUD completely unobstructed. The former pair of
                // player-colored corner blocks covered the first and last parts
                // of long level labels when the roof was viewed obliquely.
            }
        }

        // Large, low-poly equipment. Humanoid weapons share the dominant arm's
        // joint so the existing attack/work poses swing the complete silhouette.
        let handJoint = kind === 'bird' || kind === 'mole' ? 0 : -1;
        let handPivot = kind === 'bird' || kind === 'mole' ? 0 : .65;
        let equipmentYaw = (kind === 'figure' || kind === 'heavy' || kind === 'worker') ? Math.PI * .5 : 0;
        let wp = (x, y, z, sx, sy, sz, surface = 1, joint = handJoint, pivot = handPivot, taper = 1) =>
            part(x, y, z, sx, sy, sz, surface, joint, pivot, taper, equipmentYaw);
        if (weapon === 'sword' || weapon === 'fire_blade') {
            wp(.40,.25,.15,.07,.32,.07,1); wp(.40,.61,.15,.15,.58,.045,weapon === 'fire_blade' ? 0 : 1,handJoint,handPivot,.25);
            wp(.40,.35,.15,.36,.07,.07,2); if (weapon === 'fire_blade') wp(.40,.66,.178,.035,.36,.018,3);
        } else if (weapon === 'king_sword') {
            wp(.47,.32,.16,.10,.48,.08,2); wp(.47,.71,.16,.21,.66,.055,1,handJoint,handPivot,.18);
            wp(.47,.46,.16,.57,.09,.075,2); wp(.47,1.05,.16,.12,.12,.07,3,handJoint,handPivot,.05);
        } else if (weapon === 'dual_blades') {
            for (let side of [-1,1]) {
                let joint = -side;
                wp(side*.38,.29,.14,.055,.25,.055,2,joint,.65); wp(side*.38,.59,.14,.105,.46,.035,1,joint,.65,.18);
            }
        } else if (weapon === 'great_axe') {
            wp(.45,.37,.14,.09,.86,.075,1); wp(.45,.83,.14,.60,.25,.09,2); wp(.68,.83,.14,.20,.38,.055,1,handJoint,handPivot,.15);
        } else if (weapon === 'warhammer') {
            wp(.43,.34,.15,.11,.78,.08,1); wp(.43,.78,.15,.62,.25,.13,2); wp(.43,.78,.245,.30,.16,.055,1);
        } else if (weapon === 'water_trident') {
            wp(.40,.40,.15,.07,.92,.08,0); wp(.40,.91,.15,.38,.09,.10,2);
            for (let x of [.24,.40,.56]) wp(x,.99,.15,.065,.31,.075,0,handJoint,handPivot,.12);
        } else if (weapon === 'ice_spear') {
            wp(.40,.39,.15,.06,.94,.07,1); wp(.40,.98,.15,.20,.34,.16,0,handJoint,handPivot,.04); wp(.40,.70,.15,.25,.06,.12,2);
        } else if (weapon === 'poison_scythe') {
            wp(.42,.39,.15,.07,.95,.08,0); wp(.57,.91,.15,.43,.10,.12,2); wp(.76,.82,.15,.13,.38,.08,0,handJoint,handPivot,.10);
        } else if (weapon === 'laser_staff') {
            wp(.40,.39,.15,.08,.91,.09,2); wp(.40,.91,.15,.31,.20,.22,0); wp(.40,.91,.27,.15,.15,.08,3);
        } else if (weapon === 'hammer') {
            wp(.40,.35,.13,.09,.70,.07,1); wp(.40,.73,.13,.55,.23,.11,2); wp(.40,.73,.21,.28,.13,.05,1);
        } else if (weapon === 'pickaxe') {
            wp(.40,.35,.13,.08,.75,.065,1); wp(.40,.76,.13,.62,.10,.07,2); wp(.67,.70,.13,.18,.26,.045,1,handJoint,handPivot,.12);
        } else if (weapon === 'cutter') {
            wp(.40,.35,.14,.12,.47,.075,2); wp(.40,.65,.14,.44,.35,.075,1); wp(.40,.65,.19,.24,.23,.035,3);
        } else if (weapon === 'healer_staff') {
            // Paired medical booms are mounted to the wing roots and point forward.
            for (let side of [-1,1]) {
                let joint = side * 3;
                wp(side*.34,.51,.16,.13,.10,.72,1,joint,0); wp(side*.34,.52,.48,.36,.065,.10,2,joint,0);
                wp(side*.34,.52,.48,.08,.30,.10,2,joint,0); wp(side*.34,.52,.56,.11,.11,.08,3,joint,0);
            }
        } else if (weapon === 'research_orb') {
            // Sensor lances sit on top of both wings instead of floating beside the bird.
            for (let side of [-1,1]) {
                let joint = side * 3;
                wp(side*.38,.53,.12,.11,.10,.68,2,joint,0); wp(side*.38,.54,.46,.21,.21,.19,3,joint,0);
                wp(side*.38,.54,.46,.32,.04,.31,0,joint,0);
            }
        } else if (weapon === 'talons') {
            // Flying fighters carry slim forward blades on top of their wings.
            for (let side of [-1,1]) {
                let joint = side * 3;
                wp(side*.38,.51,.13,.12,.09,.66,2,joint,0); wp(side*.38,.51,.50,.08,.12,.28,1,joint,0,.08);
            }
        } else if (weapon === 'claws') {
            for (let side of [-1,1]) for (let claw of [-1,0,1]) wp(side*.38 + claw*.045,.05,.38,.035,.06,.38,1,0,0,.05);
        }
        // Separate face vertices keep the intentionally faceted silhouette.
        normals = computeNormals(positions, indices);
        return { positions, normals, indices: new Uint32Array(indices), uvs, details: new Float32Array(details) };
    }

    // proceduralKind depends only on these four inputs; memoize it because it
    // runs (with several regex tests) for every object in every frame.
    const proceduralKindCache = new Map();
    const lodMeshKeys = new Map();
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
            if (object.isFlying || /flying|scout|healer_unit|researcher_unit/.test(key)) return `bird:${weapon || 'talons'}`;
            if (key === 'unit_mole') return `mole:${weapon || 'claws'}`;
            if (key === 'unit_king') return `heavy:${weapon || 'king_sword'}`;
            if (/tank|heavy|giant|boss/.test(key)) return `heavy:${weapon || 'great_axe'}`;
            if (object.isWorker || /builder|collect|salvag|heal|astar|research/.test(key)) return `worker:${weapon || 'hammer'}`;
            return `figure:${weapon || (/resistant/.test(key) ? 'fire_blade' : 'sword')}`;
        }
        if (key.startsWith('tower_')) return /smg/.test(key) ? 'tower:twin' : /sniper/.test(key) ? 'tower:sniper' : /laser|elements|ice|poison|fire|water/.test(key) ? 'tower:energy' : 'tower';
        if (key.startsWith('barrack_')) return 'barrack';
        if (key.startsWith('spawner_')) return /research/.test(key) ? 'spawner:research' : /healer/.test(key) ? 'spawner:healer' : 'spawner';
        if (key === 'item_house') return 'item:house';
        if (key.startsWith('item_')) return /relay|cloud|energy/.test(key) ? 'item:relay' : 'item';
        if (key.includes('_mine_')) return 'mine';
        return null;
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
                out vec3 vNormal;
                out vec3 vColor;
                out float vAlpha;
                out vec3 vLocalPosition;
                out float vShape;
                out float vLightLevel;
                void main() {
                    mat4 model = mat4(iModelRow0, iModelRow1, iModelRow2, iModelRow3);
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
                viewProjection: gl.getUniformLocation(this.instancedMeshProgram, 'uViewProjection')
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
            this.orbitYaw = 0;
            this.orbitPitch = 0.92;
            this.sceneFramebuffer = gl.createFramebuffer();
            // Use a shared sample count supported by both color and depth formats.
            let colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
            let depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
            this.sceneSamples = Array.from(colorSamples).filter(n => n > 1 && n <= 4 && depthSamples.includes(n)).sort((a,b) => a-b)[0] || 0;
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
                gl.bindVertexArray(mesh.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
                let instanceStrideBytes = 26 * 4;
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
                gl.bindVertexArray(null);
            };
            bindInstanceAttributes(this.cubeMesh);
            bindInstanceAttributes(this.cylinderMesh);
            this.figureMeshes = new Map();
            for (let kind of [
                'figure:sword', 'figure:dual_blades', 'figure:fire_blade', 'figure:water_trident', 'figure:ice_spear', 'figure:poison_scythe', 'figure:laser_staff',
                'heavy:king_sword', 'heavy:great_axe', 'heavy:warhammer',
                'worker:hammer', 'worker:pickaxe', 'worker:cutter',
                'bird:talons', 'bird:healer_staff', 'bird:research_orb', 'mole:claws', 'serpent:engine',
                'tower', 'tower:twin', 'tower:sniper', 'tower:energy', 'barrack', 'spawner', 'spawner:research', 'spawner:healer', 'item', 'item:relay', 'item:house', 'mine'
            ]) {
                for (let simplified of [false, true]) {
                    let data = createFigureData(kind, simplified);
                    let mesh = createMesh(gl, data.positions, data.normals, data.indices, data.uvs);
                    mesh.details = data.details;
                    bindInstanceAttributes(mesh);
                    gl.bindVertexArray(mesh.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
                    gl.bufferData(gl.ARRAY_BUFFER, data.details, gl.STATIC_DRAW);
                    gl.enableVertexAttribArray(13);
                    gl.vertexAttribPointer(13, 4, gl.FLOAT, false, 16, 0);
                    this.figureMeshes.set(simplified ? `${kind}:lod` : kind, mesh);
                }
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
                layout(location=10) in float phase;
                layout(location=11) in vec3 trim;
                layout(location=12) in float light;
                layout(location=13) in vec4 detail;
                uniform mat4 uViewProjection;
                uniform float uAnimationMode;
                out vec3 vNormal;
                out vec3 vColor;
                out vec3 vTrim;
                out vec2 vUv;
                out float vAlpha;
                out float vLight;
                flat out int vSurface;
                void main() {
                    vec3 p = aPosition, n = aNormal;
                    float animationMode = floor(uAnimationMode + .5);
                    float angle = sin(phase) * moveAmount * detail.y * .65;
                    if (animationMode == 1.0) {
                        // One-shot attack: both arms drive forward while the cape follows through.
                        angle = abs(detail.y) == 1.0 ? sin(phase) * 1.15 : (detail.y == 2.0 ? -sin(phase) * .16 : 0.0);
                    } else if (animationMode == 2.0) {
                        // Builder: dominant tool arm makes a broad hammering arc.
                        angle = detail.y == -1.0 ? (-.45 + sin(phase) * 1.05) : (detail.y == 1.0 ? sin(phase + 1.4) * .18 : 0.0);
                    } else if (animationMode == 3.0) {
                        // Collectors scoop inward with alternating arms.
                        angle = abs(detail.y) == 1.0 ? sin(phase + sign(detail.y) * 1.2) * .72 : 0.0;
                    } else if (animationMode == 4.0) {
                        // Salvager: short, fast cutting strokes.
                        angle = abs(detail.y) == 1.0 ? sin(phase * 1.7) * (detail.y < 0.0 ? .72 : .22) : 0.0;
                    } else if (animationMode == 5.0) {
                        // Healer: wings and limbs open in a slow restorative pulse.
                        angle = abs(detail.y) == 1.0 ? (.28 + sin(phase * .55) * .22) * sign(detail.y) : 0.0;
                    } else if (animationMode == 6.0) {
                        // Researcher: asymmetric instrument-tuning motion.
                        angle = abs(detail.y) == 1.0 ? sin(phase * .8 + (detail.y > 0.0 ? 0.0 : 1.8)) * .48 : 0.0;
                    } else if (detail.y == 2.0) {
                        angle = sin(phase + aPosition.y * 3.0) * moveAmount * .10;
                    }
                    float c = cos(angle), s = sin(angle);
                    p.y -= detail.z;
                    p.yz = mat2(c, s, -s, c) * p.yz;
                    p.y += detail.z;
                    n.yz = mat2(c, s, -s, c) * n.yz;
                    if (abs(detail.y) == 3.0) {
                        // Birds flap even while hovering; each wing rotates at its root.
                        p = aPosition; n = aNormal;
                        float wingScale = animationMode == 5.0 ? .72 : (animationMode == 6.0 ? .34 : .48);
                        float wing = sin(phase) * sign(detail.y) * wingScale;
                        float wc = cos(wing), ws = sin(wing);
                        p.y -= .43;
                        p.xy = mat2(wc,ws,-ws,wc) * p.xy;
                        p.y += .43;
                        n.xy = mat2(wc,ws,-ws,wc) * n.xy;
                    }
                    if (animationMode == 1.0) p.z += sin(phase) * .16;
                    if (animationMode == 2.0) p.y -= max(0.0, sin(phase)) * .035;
                    if (animationMode == 5.0) p.y += (sin(phase * .55) + 1.0) * .035;
                    if (animationMode == 6.0) p.y += sin(phase * .8 + aPosition.x * 2.0) * .018;
                    p.y += abs(sin(phase)) * moveAmount * .018;
                    mat4 model = mat4(m0, m1, m2, m3);
                    if (detail.w > .5) {
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
                    if (detail.x > 3.5 && aNormal.y > .5) world.y += .02 * (1.0 - clamp(sqrt(scale2.y), 0.0, 1.0));
                    gl_Position = uViewProjection * world;
                    vColor = color; vTrim = trim; vUv = aUv;
                    vAlpha = alpha; vLight = light; vSurface = int(detail.x + .5);
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
                uniform float uIsUnit;
                uniform float uIsFlying;
                uniform float uSpriteLodBias;
                ${CEL_LIGHTING_GLSL}
                uniform sampler2D uTopTexture;
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
                    if (vSurface == 2) base = vColor;
                    if (vSurface == 3) base = vec3(.48,.94,1.0);
                    if (vSurface >= 4) {
                        // Preserve thin sprite strokes without disabling distant mipmaps.
                        vec4 texel = texture(uTopTexture, vUv, uSpriteLodBias);
                        // Transparent sprite padding must not turn into a pale plaque.
                        if (texel.a < .1) discard;
                        base = mix(vec3(.055,.065,.08), texel.rgb, texel.a);
                    }
                    float diffuse = max(dot(normalize(vNormal), normalize(vec3(-.42,.86,.31))),0.0);
                    float shade = vSurface >= 3 ? 1.0 : mix(.72, 1.0, celShade(diffuse));
                    vec3 shaded = base * shade;
                    if (vSurface < 3) {
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
                isFlying: gl.getUniformLocation(this.figureProgram, 'uIsFlying'),
                isUnit: gl.getUniformLocation(this.figureProgram, 'uIsUnit'),
                viewProjection: gl.getUniformLocation(this.figureProgram, 'uViewProjection'),
                topTexture: gl.getUniformLocation(this.figureProgram, 'uTopTexture'),
                sideTexture: gl.getUniformLocation(this.figureProgram, 'uSideTexture'),
                hasSideTexture: gl.getUniformLocation(this.figureProgram, 'uHasSideTexture')
            };
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        getFigureMeshKey(object) {
            let kind = proceduralKind(object);
            if (!kind) return null;
            // Use scale at the orbit center so rotating cannot toggle detail levels.
            let pixels = this.lodPixelsPerWorld * Math.max(object.scaleX, object.scaleZ);
            if (!(pixels < 24)) return kind;
            let lod = lodMeshKeys.get(kind);
            if (!lod) lodMeshKeys.set(kind, lod = kind + ':lod');
            return lod;
        }

        getPrimitiveMesh(object) {
            return object && object.renderShape === 'cylinder' ? this.cylinderMesh : this.cubeMesh;
        }

        setEnabled(enabled) {
            this.enabled = !!enabled && this.supported;
            this.canvas.style.display = this.enabled ? 'block' : 'none';
        }

        resize(width, height) {
            if (!this.supported) return;
            let safeWidth = Math.max(1, Math.floor(width || 1));
            let safeHeight = Math.max(1, Math.floor(height || 1));
            // Match 2D's native display pixels instead of asking the browser to
            // rescale a 1.5x canvas on a 2x display. Bound large-screen GPU cost.
            const pixelBudget = 6000000;
            this.pixelRatio = Math.min(window.devicePixelRatio || 1, Math.max(1, Math.sqrt(pixelBudget / (safeWidth * safeHeight))));
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
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFramebuffer);
                for (let i = 0; i < 3; i++) {
                    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaBuffers[i]);
                    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.sceneSamples, i === 2 ? gl.DEPTH_COMPONENT24 : gl.RGBA8, width, height);
                    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, i === 2 ? gl.DEPTH_ATTACHMENT : gl.COLOR_ATTACHMENT0 + i, gl.RENDERBUFFER, this.msaaBuffers[i]);
                }
                gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) this.sceneSamples = 0;
                gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
        }

        resolveScene() {
            if (!this.sceneSamples) return;
            let gl = this.gl, { width, height } = this.sceneTargetSize;
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFramebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFramebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
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

        presentSceneToCanvas() {
            let gl = this.gl;
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
            if (snapshot.flat2d) {
                // World X/Z map exactly to the existing 2D mouse/camera math.
                const camera = snapshot.camera;
                const m = this.tmpViewProjection;
                m.fill(0);
                m[0] = 2 / camera.visibleWidth;
                m[9] = -2 / camera.visibleHeight;
                m[6] = -0.001;
                m[12] = -camera.centerX * m[0];
                m[13] = -camera.centerZ * m[9];
                m[15] = 1;
                invertMatrix4(this.tmpInverseViewProjection, m);
                return;
            }
            let aspect = Math.max(1e-4, (snapshot.viewportWidth || 1) / (snapshot.viewportHeight || 1));
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
            perspective(this.tmpProjection, 0.74, aspect, 0.1, 220);
            this.lodPixelsPerWorld = this.cssHeight * this.tmpProjection[5] / (2 * distance);
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

        getGroundFrustumPolygon(snapshot) {
            if (!snapshot) return null;
            this.resize(snapshot.viewportWidth, snapshot.viewportHeight);
            this.buildViewProjection(snapshot);

            let corners = [];
            for (let z of [-1, 1]) {
                for (let y of [-1, 1]) {
                    for (let x of [-1, 1]) {
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

        projectWorldToScreen(x, y, z) {
            let projected = this.projectWorldToScreenDetailed(x, y, z);
            if (!projected) return null;
            return {
                x: projected.x,
                y: projected.y,
            };
        }

        projectWorldToScreenDetailed(x, y, z) {
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
            if (!this.pickInverseViewProjection || !this.pickObjects) return null;
            const nx = screenX / this.cssWidth * 2 - 1, ny = 1 - screenY / this.cssHeight * 2;
            const near = transformClipToWorld(this.pickInverseViewProjection, nx, ny, -1);
            const far = transformClipToWorld(this.pickInverseViewProjection, nx, ny, 1);
            if (!near || !far) return null;
            let bestT = 1, best = null;
            const texturePixels = new Map();
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
                        const joint = mesh.details[i * 4 + 1], pivot = mesh.details[i * 4 + 2];
                        const phase = o.walkPhase || 0, move = o.moveAmount || 0, mode = o.animationMode || 0;
                        let angle = Math.sin(phase) * move * joint * .65;
                        if (mode === 1) angle = Math.abs(joint) === 1 ? Math.sin(phase) * 1.15 : (joint === 2 ? -Math.sin(phase) * .16 : 0);
                        else if (mode === 2) angle = joint === -1 ? -.45 + Math.sin(phase) * 1.05 : (joint === 1 ? Math.sin(phase + 1.4) * .18 : 0);
                        else if (mode === 3) angle = Math.abs(joint) === 1 ? Math.sin(phase + Math.sign(joint) * 1.2) * .72 : 0;
                        else if (mode === 4) angle = Math.abs(joint) === 1 ? Math.sin(phase * 1.7) * (joint < 0 ? .72 : .22) : 0;
                        else if (mode === 5) angle = Math.abs(joint) === 1 ? (.28 + Math.sin(phase * .55) * .22) * Math.sign(joint) : 0;
                        else if (mode === 6) angle = Math.abs(joint) === 1 ? Math.sin(phase * .8 + (joint > 0 ? 0 : 1.8)) * .48 : 0;
                        else if (joint === 2) angle = Math.sin(phase + y * 3) * move * .10;
                        if (Math.abs(joint) === 3) {
                            const wing = Math.sin(phase) * Math.sign(joint) * (mode === 5 ? .72 : mode === 6 ? .34 : .48);
                            const px = x;
                            x = Math.cos(wing) * x - Math.sin(wing) * (y - .43);
                            y = Math.sin(wing) * px + Math.cos(wing) * (y - .43) + .43;
                        } else {
                            const py = y - pivot;
                            y = Math.cos(angle) * py - Math.sin(angle) * z + pivot;
                            z = Math.sin(angle) * py + Math.cos(angle) * z;
                        }
                        if (mode === 1) z += Math.sin(phase) * .16;
                        if (mode === 2) y -= Math.max(0, Math.sin(phase)) * .035;
                        if (mode === 5) y += (Math.sin(phase * .55) + 1) * .035;
                        if (mode === 6) y += Math.sin(phase * .8 + mesh.positions[i * 3] * 2) * .018;
                        y += Math.abs(Math.sin(phase)) * move * .018;
                        if (mesh.details[i * 4 + 3] > .5) {
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
                    if (mesh.details && mesh.details[indices[i] * 4] >= 4 && o.topTextureCanvas && mesh.uvs) {
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
                let firstProjected = overlays.selectionDashed && this.projectWorldToScreen(path[0][0]/tile, .05, path[0][1]/tile);
                let pa = firstProjected;
                for (let i = 0; i < path.length; i++) {
                    let a = path[i], b = path[(i + 1) % path.length];
                    add(a[0]/tile, a[1]/tile, b[0]/tile, b[1]/tile, group.color, overlays.selectionDashed, phase);
                    if (overlays.selectionDashed) {
                        let pb = i + 1 === path.length ? firstProjected : this.projectWorldToScreen(b[0]/tile, .05, b[1]/tile);
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
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            overlays.groundLinesRendered = true;
        }

        drawOverlay(overlays, ctx) {
            if (!ctx || !overlays) return;
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            let projectGround = (x, z) => this.projectWorldToScreen(x, 0.05, z);
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
                let p = this.projectWorldToScreenDetailed(bar.x, Number(bar.lift) || 0.6, bar.z);
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
                let p = this.projectWorldToScreenDetailed(text.x, Number(text.lift) || 0.8, text.z);
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
            let projectGround = (x, z) => this.projectWorldToScreen(x, 0.06, z);
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

            let image = preview.image;
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
            let width = Math.max(1, rect.width || 1);
            let height = Math.max(1, rect.height || 1);
            let ndcX = ((clientX - rect.left) / width) * 2 - 1;
            let ndcY = 1 - ((clientY - rect.top) / height) * 2;
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

        getShadowInfo(object) {
            if (!object) return null;
            let alpha = Math.max(0, Math.min(1, Number(object.alpha) || 1));
            if (alpha < 0.14) return null;

            let modelKey = sanitizeModelKey(object.modelKey);
            if (modelKey === 'particle' || modelKey.indexOf('projectile_') === 0 || modelKey.indexOf('dropped_') === 0) return null;

            let scaleX = Math.max(0.01, Number(object.scaleX) || 0);
            let scaleY = Math.max(0.01, Number(object.scaleY) || 0);
            let scaleZ = Math.max(0.01, Number(object.scaleZ) || 0);
            if (Math.max(scaleX, scaleY, scaleZ) < 0.05) return null;

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
            let alphaScale = Math.max(0.04, Math.min(0.28, (0.05 + 0.24 * lightLevel - casterHeight * 0.03) * alpha));
            return {
                x: (Number(object.x) || 0) - dirX * shadowOffset,
                y: SHADOW_GROUND_Y,
                z: (Number(object.z) || 0) - dirZ * shadowOffset,
                rotationY: Number(object.rotationY) || 0,
                scaleX: scaleX * shadowStretch,
                scaleY: SHADOW_FLAT_HEIGHT * (0.5 + lightLevel),
                scaleZ: scaleZ * shadowStretch,
                alpha: alphaScale,
                renderShape: object && object.renderShape === 'cylinder' ? 'cylinder' : 'box'
            };
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

        drawShadowInstances(objects) {
            if (!objects || objects.length <= 0) return;
            let gl = this.gl;
            let mesh = this.getPrimitiveMesh(objects[0]);
            this.ensureCubeInstanceCapacity(objects.length);

            let written = 0;
            for (let index = 0; index < objects.length; index++) {
                let shadow = objects[index];
                let base = written * 26;
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
                this.cubeInstanceArray.set(this.tmpModel, base);
                this.cubeInstanceArray[base + 16] = 0;
                this.cubeInstanceArray[base + 17] = 0;
                this.cubeInstanceArray[base + 18] = 0;
                this.cubeInstanceArray[base + 19] = shadow.alpha;
                this.cubeInstanceArray[base + 20] = shadow.renderShape === 'cylinder' ? 1 : 0;
                this.cubeInstanceArray[base + 21] = 0;
                this.cubeInstanceArray[base + 22] = 0;
                this.cubeInstanceArray[base + 23] = 0;
                this.cubeInstanceArray[base + 24] = 0;
                this.cubeInstanceArray[base + 25] = 1;
                written++;
            }
            if (written <= 0) return;

            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cubeInstanceArray.subarray(0, written * 26));
            gl.useProgram(this.instancedMeshProgram);
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(this.instancedMeshUniforms.viewProjection, false, this.tmpViewProjection);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, written);
        }

        drawShadows(meshObjects, primitiveGroups) {
            let hasMeshes = !!(meshObjects && meshObjects.length > 0);
            let hasPrimitives = !!(primitiveGroups && primitiveGroups.size > 0);
            if (!hasMeshes && !hasPrimitives) return;

            let gl = this.gl;
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            for (let entry of meshObjects || []) this.drawShadowObject(entry.object, entry.shadow);
            if (primitiveGroups) {
                for (let group of primitiveGroups.values()) this.drawShadowInstances(group);
            }
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
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

        ensureCubeInstanceCapacity(requiredCount) {
            if (this.cubeInstanceCapacity >= requiredCount) return;
            let gl = this.gl;
            let nextCapacity = Math.max(32, this.cubeInstanceCapacity || 0);
            while (nextCapacity < requiredCount) nextCapacity *= 2;
            this.cubeInstanceCapacity = nextCapacity;
            this.cubeInstanceArray = new Float32Array(nextCapacity * 26);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.cubeInstanceArray.byteLength, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        drawCubeInstances(objects) {
            if (!objects || objects.length <= 0) return;
            let gl = this.gl;
            let mesh = this.getPrimitiveMesh(objects[0]);
            this.ensureCubeInstanceCapacity(objects.length);
            for (let index = 0; index < objects.length; index++) {
                let object = objects[index];
                let base = index * 26;
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
                this.cubeInstanceArray.set(this.tmpModel, base);
                let color = hexToRgb(object.tint);
                this.cubeInstanceArray[base + 16] = color[0];
                this.cubeInstanceArray[base + 17] = color[1];
                this.cubeInstanceArray[base + 18] = color[2];
                this.cubeInstanceArray[base + 19] = Math.max(0.05, Math.min(1, Number(object.alpha) || 1));
                this.cubeInstanceArray[base + 20] = object.renderShape === 'cylinder' ? 1 : 0;
                this.cubeInstanceArray[base + 21] = 0;
                this.cubeInstanceArray[base + 22] = color[0];
                this.cubeInstanceArray[base + 23] = color[1];
                this.cubeInstanceArray[base + 24] = color[2];
                this.cubeInstanceArray[base + 25] = this.getPackedObjectLight(object);
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cubeInstanceArray.subarray(0, objects.length * 26));
            gl.useProgram(this.instancedMeshProgram);
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(this.instancedMeshUniforms.viewProjection, false, this.tmpViewProjection);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, objects.length);
        }

        drawTexturedCubeInstances(objects, topTexture, sideTexture = null) {
            if (!objects || objects.length <= 0 || !topTexture) return;
            let gl = this.gl;
            let kind = this.getFigureMeshKey(objects[0]);
            let mesh = kind ? this.figureMeshes.get(kind) : this.getPrimitiveMesh(objects[0]);
            let uniforms = kind ? this.figureUniforms : this.texturedCubeUniforms;
            this.ensureCubeInstanceCapacity(objects.length);
            for (let index = 0; index < objects.length; index++) {
                let object = objects[index];
                let base = index * 26;
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
                this.cubeInstanceArray.set(this.tmpModel, base);
                let color = hexToRgb(object.tint);
                this.cubeInstanceArray[base + 16] = color[0];
                this.cubeInstanceArray[base + 17] = color[1];
                this.cubeInstanceArray[base + 18] = color[2];
                this.cubeInstanceArray[base + 19] = Math.max(0.05, Math.min(1, Number(object.alpha) || 1));
                this.cubeInstanceArray[base + 20] = object.renderShape === 'cylinder' ? 1 : 0;
                this.cubeInstanceArray[base + 21] = (Number(object.sideTextureAngle) || 0) - (object.renderShape === 'cylinder' ? (Number(object.rotationY) || 0) : 0);
                let sideColor = hexToRgb(object.sideTint || object.tint);
                this.cubeInstanceArray[base + 22] = sideColor[0];
                this.cubeInstanceArray[base + 23] = sideColor[1];
                this.cubeInstanceArray[base + 24] = sideColor[2];
                this.cubeInstanceArray[base + 25] = this.getPackedObjectLight(object);
                if (kind) {
                    this.cubeInstanceArray[base + 20] = object.moveAmount || 0;
                    this.cubeInstanceArray[base + 21] = object.walkPhase || 0;
                }
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cubeInstanceArray.subarray(0, objects.length * 26));
            gl.useProgram(kind ? this.figureProgram : this.texturedCubeProgram);
            if (kind) {
                gl.uniform1f(uniforms.isFlying, kind.startsWith('bird') ? 1 : 0);
                gl.uniform1f(uniforms.animationMode, Number(objects[0].animationMode) || 0);
                gl.uniform1f(uniforms.spriteLodBias, String(objects[0].topTextureKey).startsWith('2d:') ? -.5 : 0);
                let key = objects[0].modelKey || '';
                gl.uniform1f(uniforms.isUnit, key.startsWith('unit_') ? 1 : 0);
            }
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(uniforms.viewProjection, false, this.tmpViewProjection);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, topTexture);
            gl.uniform1i(uniforms.topTexture, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, sideTexture);
            gl.uniform1i(uniforms.sideTexture, 1);
            gl.uniform1f(uniforms.hasSideTexture, sideTexture ? 1 : 0);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, objects.length);
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
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
        }

        render(snapshot) {
            if (!this.enabled || !this.supported || !snapshot) return;
            this.resize(snapshot.viewportWidth, snapshot.viewportHeight);
            this.buildViewProjection(snapshot);
            this.textureFrame = (this.textureFrame || 0) + 1;

            let gl = this.gl;
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneSamples ? this.msaaFramebuffer : this.sceneFramebuffer);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.drawBackground(snapshot);
            let objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
            if (snapshot.flat2d) {
                if (snapshot.flatBatch) this.drawFlatBatch(snapshot.flatBatch);
                else this.drawFlatSprites(objects);
                this.drawGroundOverlays(snapshot.overlays);
                this.resolveScene();
                this.presentSceneToCanvas();
                this.trimTopTextures();
                return;
            }
            // Retain the transforms/LOD actually drawn, without rebuilding the scene on clicks.
            this.pickObjects = [];
            this.pickInverseViewProjection = new Float32Array(this.tmpInverseViewProjection);
            let opaqueCubeGroups = new Map();
            let transparentCubeGroups = new Map();
            let opaqueTexturedCubeGroups = new Map();
            let transparentTexturedCubeGroups = new Map();
            let opaqueMeshObjects = [];
            let transparentMeshObjects = [];
            let shadowPrimitiveGroups = new Map();
            let shadowMeshObjects = [];
            for (let object of objects) {
                let isTransparent = (Number(object.alpha) || 1) < 0.999;
                let figureMeshKey = this.getFigureMeshKey(object);
                let mesh = figureMeshKey ? null : this.requestModel(object);
                if (object.pickSource) {
                    let textured = (object.topTextureKey && object.topTextureCanvas) || (object.sideTextureKey && object.sideTextureCanvas);
                    let pickMesh = mesh || (textured && this.figureMeshes.get(figureMeshKey)) || this.getPrimitiveMesh(object);
                    this.pickObjects.push({ object, mesh: pickMesh });
                }
                let shadow = this.getShadowInfo(object);
                if (shadow) {
                    if (mesh) {
                        shadowMeshObjects.push({ object, shadow });
                    } else {
                        let shadowGroupKey = object.renderShape || 'box';
                        let shadowGroup = shadowPrimitiveGroups.get(shadowGroupKey);
                        if (!shadowGroup) {
                            shadowGroup = [];
                            shadowPrimitiveGroups.set(shadowGroupKey, shadowGroup);
                        }
                        shadowGroup.push(shadow);
                    }
                }
                if (mesh) {
                    (isTransparent ? transparentMeshObjects : opaqueMeshObjects).push(object);
                } else if ((object.topTextureKey && object.topTextureCanvas) || (object.sideTextureKey && object.sideTextureCanvas)) {
                    let targetGroups = isTransparent ? transparentTexturedCubeGroups : opaqueTexturedCubeGroups;
                    // Scene objects are reused between frames with the same
                    // textures and shape; only the LOD mesh key can change.
                    let groupKey = object._r3dGroupFigure === figureMeshKey ? object._r3dGroupKey : undefined;
                    if (groupKey === undefined) {
                        groupKey = `${object.topTextureKey || ''}|${object.sideTextureKey || ''}|${figureMeshKey || object.renderShape || 'box'}|anim:${Number(object.animationMode) || 0}`;
                        object._r3dGroupKey = groupKey;
                        object._r3dGroupFigure = figureMeshKey;
                    }
                    let group = targetGroups.get(groupKey);
                    if (!group) {
                        group = {
                            topTexture: this.getTopTexture(object.topTextureKey, object.topTextureCanvas),
                            // Procedural panels use the full 2D status canvas; avoid
                            // uploading the obsolete audio texture for these models.
                            sideTexture: !figureMeshKey && object.sideTextureKey && object.sideTextureCanvas ? this.getTopTexture(object.sideTextureKey, object.sideTextureCanvas) : null,
                            objects: []
                        };
                        targetGroups.set(groupKey, group);
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
            this.drawShadows(shadowMeshObjects, shadowPrimitiveGroups);
            for (let object of opaqueMeshObjects) this.drawObject(object);
            for (let group of opaqueTexturedCubeGroups.values()) {
                this.drawTexturedCubeInstances(group.objects, group.topTexture, group.sideTexture);
            }
            for (let group of opaqueCubeGroups.values()) {
                this.drawCubeInstances(group);
            }
            if (transparentMeshObjects.length > 0 || transparentCubeGroups.size > 0 || transparentTexturedCubeGroups.size > 0) {
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
                for (let group of transparentTexturedCubeGroups.values()) {
                    this.drawTexturedCubeInstances(group.objects, group.topTexture, group.sideTexture);
                }
                for (let group of transparentCubeGroups.values()) {
                    this.drawCubeInstances(group);
                }
                gl.depthMask(true);
                gl.disable(gl.BLEND);
            }
            let overlays = snapshot.overlays || null;
            this.drawGroundOverlays(overlays);
            let needsOverlayDepth = !!(overlays && ((overlays.bars && overlays.bars.length > 0) || (overlays.texts && overlays.texts.length > 0)));
            this.resolveScene();
            if (needsOverlayDepth) this.captureOverlayDepthFrame();
            this.presentSceneToCanvas();
            // Delete GPU resources as well as JS entries. Never evict a texture
            // used in this frame; amortize cleanup after camera sweeps/battles.
            this.trimTopTextures();
            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
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
    window.Defence3Renderer3D = Defence3Renderer3D;
})();
