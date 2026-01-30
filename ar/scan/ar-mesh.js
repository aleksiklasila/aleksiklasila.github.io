import * as THREE from 'three';

/**
 * Generates a Three.js Mesh from XRDepthInformation.
 * @param {XRCPUDepthInformation} depthInfo - The CPU depth information from WebXR.
 * @param {XRView} view - The XRView associated with the depth info (needed for projection matrix).
 * @returns {THREE.Mesh} - The generated mesh (points or triangles).
 */
export function buildMeshFromDepth(depthInfo, view) {
    const width = depthInfo.width;
    const height = depthInfo.height;
    const rawData = new Uint16Array(depthInfo.data); // Assuming "luminance-alpha" / ushort format usually

    // Support float32 if that's what we get
    const isFloat = depthInfo.dataFormat === 'float32';

    // Check if data is accessible
    try {
        if (depthInfo.data.byteLength === 0) throw new Error("Empty depth buffer");
    } catch (e) {
        console.error("Depth data access error: " + e.message);
        return null;
    }

    const data = isFloat ? new Float32Array(depthInfo.data) : rawData;

    // Downsample factor to keep performance high (1 = full res, 2 = half res, etc.)
    const skip = 4; // 160x90 for a 640x360 buffer is plenty for mobile AR mesh

    const vertices = [];
    const indices = [];

    // Calculate inverse projection matrix to unproject
    const projectionMatrix = new THREE.Matrix4().fromArray(view.projectionMatrix);
    const invProjection = projectionMatrix.clone().invert();

    const resultWidth = Math.floor(width / skip);
    const resultHeight = Math.floor(height / skip);

    // Helper to get depth in meters
    const toMeters = depthInfo.rawValueToMeters || 1.0;

    const getDepth = (x, y) => {
        const index = y * width + x;
        if (isFloat) {
            return data[index];
        } else {
            return data[index] * toMeters;
        }
    };

    // Pre-allocate vector for unprojection to avoid garbage
    const vPoint = new THREE.Vector3();

    // Generate Vertices
    for (let y = 0; y < resultHeight; y++) {
        for (let x = 0; x < resultWidth; x++) {
            // Map result (x,y) back to source coords
            const srcX = x * skip;
            const srcY = y * skip;

            // Wrap invalid data instead of skipping to keep indexing consistent
            const d = getDepth(srcX, srcY);

            // Ignore invalid depth (0 or too far)
            if (d === 0 || d > 5.0 || !isFinite(d)) {
                vertices.push(NaN, NaN, NaN); // Use NaN to signal invalid vertex
                continue;
            }

            // NDC coordinates 
            const xNDC = (srcX / width) * 2 - 1;
            const yNDC = 1 - (srcY / height) * 2; // Flip Y for GL coords

            // Robust Unprojection:
            // 1. Unproject a point from NDC (z=0.5 for safety) into View properties
            vPoint.set(xNDC, yNDC, 0.5);
            vPoint.applyMatrix4(invProjection);

            // 2. Unproject point logic
            // The ray originates at (0,0,0) and passes through vPoint.
            // We want to scale vPoint so that its Z equals -d.

            if (vPoint.z === 0) {
                vertices.push(NaN, NaN, NaN);
                continue;
            }

            const scale = -d / vPoint.z;

            const xView = vPoint.x * scale;
            const yView = vPoint.y * scale;
            const zView = -d; // Enforce exact depth

            if (!isFinite(xView) || !isFinite(yView) || !isFinite(zView)) {
                // Skip invalid points
                vertices.push(NaN, NaN, NaN);
                continue;
            }

            vertices.push(xView, yView, zView);
        }
    }

    // Debug bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertices.length; i += 3) {
        const vx = vertices[i];
        const vy = vertices[i + 1];
        const vz = vertices[i + 2];
        if (isNaN(vx)) continue;
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
    }
    console.log(`Bounds: X[${minX.toFixed(2)},${maxX.toFixed(2)}] Y[${minY.toFixed(2)},${maxY.toFixed(2)}] Z[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`);

    // Generate Indices
    for (let y = 0; y < resultHeight - 1; y++) {
        for (let x = 0; x < resultWidth - 1; x++) {
            // Indices in the vertex array
            const a = y * resultWidth + x;
            const b = y * resultWidth + (x + 1);
            const c = (y + 1) * resultWidth + x;
            const dStr = (y + 1) * resultWidth + (x + 1);

            // Check for validity using the NaN sentinel
            if (isNaN(vertices[a * 3]) || isNaN(vertices[b * 3]) || isNaN(vertices[c * 3])) continue;

            const vA = new THREE.Vector3(vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2]);
            const vB = new THREE.Vector3(vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]);
            const vC = new THREE.Vector3(vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]);

            // Edge length check to remove skyboxes/background noise connections
            const maxEdgeLen = 0.1; // 10cm max jump between pixels
            if (vA.distanceTo(vB) > maxEdgeLen || vA.distanceTo(vC) > maxEdgeLen) continue;

            // Push first triangle
            indices.push(a, c, b);

            // Second triangle (b, c, d)
            if (!isNaN(vertices[dStr * 3])) {
                const vD = new THREE.Vector3(vertices[dStr * 3], vertices[dStr * 3 + 1], vertices[dStr * 3 + 2]);
                if (vB.distanceTo(vD) < maxEdgeLen && vC.distanceTo(vD) < maxEdgeLen) {
                    indices.push(b, c, dStr);
                }
            }
        }
    }

    // Filter out NaN vertices for the final buffer
    for (let i = 0; i < vertices.length; i++) {
        if (isNaN(vertices[i])) vertices[i] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Material - Vertex colors based on Z for visual style
    const material = new THREE.MeshNormalMaterial({ wireframe: false, side: THREE.DoubleSide });

    console.log(`Generated mesh: ${vertices.length / 3} verts, ${indices.length / 3} triangles`);
    return new THREE.Mesh(geometry, material);
}
