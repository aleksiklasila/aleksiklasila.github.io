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

    function sanitizeModelKey(key) {
        return String(key || 'cube').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cube';
    }

    function hexToRgb(color) {
        let normalized = String(color || '#c8ced8').trim();
        let match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return [0.78, 0.81, 0.85];
        let hex = match[1];
        if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
        return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255
        ];
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
        return { vao, indexCount: indices.length, hasUv: !!uvs };
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
            this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
            this.canvas = document.createElement('canvas');
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.display = 'none';
            this.canvas.setAttribute('aria-hidden', 'true');
            if (this.mount) this.mount.appendChild(this.canvas);

            this.gl = this.canvas.getContext('webgl2', {
                alpha: false,
                antialias: true,
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
                    float shade = 0.38 + diffuse * 0.62;
                    float fogAlpha = pow(1.0 - clamp(vLightLevel, 0.0, 1.0), 1.3) * 0.42;
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
                    float shade = 0.38 + diffuse * 0.62;
                    float fogAlpha = pow(1.0 - clamp(vLightLevel, 0.0, 1.0), 1.3) * 0.42;
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
                    float shade = 0.38 + diffuse * 0.62;
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
                        vec3 seamTintedOverlay = mix(sideSample.rgb, playerHuedOverlay, seamFactor);
                        finalColor = mix(functionalSideColor, seamTintedOverlay, overlayAlpha);
                    }
                    float fogAlpha = pow(1.0 - clamp(vLightLevel, 0.0, 1.0), 1.3) * 0.42;
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
                out vec4 outColor;
                void main() {
                    outColor = texture(uTexture, vUv);
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
                texture: gl.getUniformLocation(this.planeProgram, 'uTexture')
            };
            this.presentUniforms = {
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
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
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
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
        }

        captureOverlayDepthFrame() {
            let gl = this.gl;
            let width = this.sceneTargetSize.width;
            let height = this.sceneTargetSize.height;
            if (width <= 0 || height <= 0) {
                this.overlayDepthFrame = null;
                return;
            }
            let requiredLength = width * height * 4;
            if (!this.overlayDepthFrame || this.overlayDepthFrame.width !== width || this.overlayDepthFrame.height !== height || !this.overlayDepthFrame.bytes || this.overlayDepthFrame.bytes.length !== requiredLength) {
                this.overlayDepthFrame = {
                    width,
                    height,
                    bytes: new Uint8Array(requiredLength)
                };
            }
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
            let needsUpload = this.backgroundTextureVersion !== version || this.backgroundTextureSize.width !== sourceCanvas.width || this.backgroundTextureSize.height !== sourceCanvas.height;
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
        }

        buildViewProjection(snapshot) {
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
            lookAt(this.tmpView, eye, target, [0, 1, 0]);
            multiplyMatrices(this.tmpViewProjection, this.tmpProjection, this.tmpView);
            invertMatrix4(this.tmpInverseViewProjection, this.tmpViewProjection);
        }

        getGroundViewportBounds(snapshot, paddingTiles = 0) {
            if (!snapshot) return null;
            this.resize(snapshot.viewportWidth, snapshot.viewportHeight);
            this.buildViewProjection(snapshot);

            let width = Math.max(1, snapshot.viewportWidth || this.cssWidth || 1);
            let height = Math.max(1, snapshot.viewportHeight || this.cssHeight || 1);
            let rect = { left: 0, top: 0, width, height };
            let xFracs = [0, 0.08, 0.18, 0.32, 0.5, 0.68, 0.82, 0.92, 1];
            let yFracs = [0, 0.04, 0.1, 0.2, 0.34, 0.5, 0.68, 0.84, 1];
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let hits = 0;

            for (let yFrac of yFracs) {
                for (let xFrac of xFracs) {
                    let point = this.screenToGround(rect.left + width * xFrac, rect.top + height * yFrac, rect);
                    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                    hits++;
                }
            }

            if (hits <= 0) return null;
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
                cached.version = version;
                cached.width = sourceCanvas.width;
                cached.height = sourceCanvas.height;
                return cached.texture;
            }
            let texture = createTexture(this.gl);
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
            this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, sourceCanvas);
            this.topTextureCache.set(key, { texture, version, width: sourceCanvas.width, height: sourceCanvas.height });
            return texture;
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
                let corners = [
                    projectGround(tile.x, tile.y),
                    projectGround(tile.x + 1, tile.y),
                    projectGround(tile.x + 1, tile.y + 1),
                    projectGround(tile.x, tile.y + 1)
                ];
                if (corners.some(p => !p)) continue;
                let key = `${tile.strokeColor}|${tile.fillColor || ''}|${tile.dashed ? 1 : 0}`;
                let group = getPathGroup(areaTileGroups, key, () => ({
                    strokeColor: tile.strokeColor,
                    fillColor: tile.fillColor || null,
                    dashed: !!tile.dashed,
                    path: new Path2D()
                }));
                group.path.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < corners.length; i++) group.path.lineTo(corners[i].x, corners[i].y);
                group.path.closePath();
            }
            for (let group of areaTileGroups.values()) {
                ctx.strokeStyle = group.strokeColor;
                ctx.fillStyle = group.fillColor || 'transparent';
                ctx.lineWidth = 1.1;
                ctx.setLineDash(group.dashed ? [5, 4] : []);
                if (group.fillColor) ctx.fill(group.path);
                ctx.stroke(group.path);
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
            for (let line of overlays.lines || []) {
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
            gl.useProgram(this.planeProgram);
            gl.bindVertexArray(this.planeMesh.vao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
            gl.uniform1i(this.planeUniforms.texture, 0);
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

        drawShadowObject(object) {
            let shadow = this.getShadowInfo(object);
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
            // gl.uniform1f(this.meshUniforms.lightLevel, 1);
            gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
        }

        drawShadowInstances(objects) {
            if (!objects || objects.length <= 0) return;
            let gl = this.gl;
            let mesh = this.getPrimitiveMesh(objects[0]);
            this.ensureCubeInstanceCapacity(objects.length);

            let written = 0;
            for (let index = 0; index < objects.length; index++) {
                let shadow = this.getShadowInfo(objects[index]);
                if (!shadow) continue;
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
            for (let object of meshObjects || []) this.drawShadowObject(object);
            if (primitiveGroups) {
                for (let group of primitiveGroups.values()) this.drawShadowInstances(group);
            }
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
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
            gl.uniform1f(this.meshUniforms.lightLevel, Math.max(0, Math.min(1, Number(object.lightLevel) || 0)));
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
                this.cubeInstanceArray[base + 25] = Math.max(0, Math.min(1, Number(object.lightLevel) || 0));
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
                this.cubeInstanceArray[base + 21] = (Number(object.sideTextureAngle) || 0) - (object.renderShape === 'cylinder' ? (Number(object.rotationY) || 0) : 0);
                let sideColor = hexToRgb(object.sideTint || object.tint);
                this.cubeInstanceArray[base + 22] = sideColor[0];
                this.cubeInstanceArray[base + 23] = sideColor[1];
                this.cubeInstanceArray[base + 24] = sideColor[2];
                this.cubeInstanceArray[base + 25] = Math.max(0, Math.min(1, Number(object.lightLevel) || 0));
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeInstanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cubeInstanceArray.subarray(0, objects.length * 26));
            gl.useProgram(this.texturedCubeProgram);
            gl.bindVertexArray(mesh.vao);
            gl.uniformMatrix4fv(this.texturedCubeUniforms.viewProjection, false, this.tmpViewProjection);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, topTexture);
            gl.uniform1i(this.texturedCubeUniforms.topTexture, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, sideTexture);
            gl.uniform1i(this.texturedCubeUniforms.sideTexture, 1);
            gl.uniform1f(this.texturedCubeUniforms.hasSideTexture, sideTexture ? 1 : 0);
            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, objects.length);
        }

        render(snapshot) {
            if (!this.enabled || !this.supported || !snapshot) return;
            this.resize(snapshot.viewportWidth, snapshot.viewportHeight);
            this.buildViewProjection(snapshot);

            let gl = this.gl;
            this.overlayDepthCache.clear();
            this.overlayDepthFrame = null;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.drawBackground(snapshot);
            let objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
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
                let mesh = this.requestModel(object);
                if (this.getShadowInfo(object)) {
                    if (mesh) {
                        shadowMeshObjects.push(object);
                    } else {
                        let shadowGroupKey = object.renderShape || 'box';
                        let shadowGroup = shadowPrimitiveGroups.get(shadowGroupKey);
                        if (!shadowGroup) {
                            shadowGroup = [];
                            shadowPrimitiveGroups.set(shadowGroupKey, shadowGroup);
                        }
                        shadowGroup.push(object);
                    }
                }
                if (mesh) {
                    (isTransparent ? transparentMeshObjects : opaqueMeshObjects).push(object);
                } else if ((object.topTextureKey && object.topTextureCanvas) || (object.sideTextureKey && object.sideTextureCanvas)) {
                    let targetGroups = isTransparent ? transparentTexturedCubeGroups : opaqueTexturedCubeGroups;
                    let groupKey = `${object.topTextureKey || ''}|${object.sideTextureKey || ''}|${object.renderShape || 'box'}`;
                    let group = targetGroups.get(groupKey);
                    if (!group) {
                        group = {
                            topTexture: this.getTopTexture(object.topTextureKey, object.topTextureCanvas),
                            sideTexture: object.sideTextureKey && object.sideTextureCanvas ? this.getTopTexture(object.sideTextureKey, object.sideTextureCanvas) : null,
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
            let needsOverlayDepth = !!(overlays && ((overlays.bars && overlays.bars.length > 0) || (overlays.texts && overlays.texts.length > 0)));
            if (needsOverlayDepth) this.captureOverlayDepthFrame();
            this.presentSceneToCanvas();
            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
    }

    window.Defence3Renderer3D = Defence3Renderer3D;
})();