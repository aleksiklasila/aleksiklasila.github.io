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
    const data = isFloat ? new Float32Array(depthInfo.data) : rawData;

    // Downsample factor to keep performance high (1 = full res, 2 = half res, etc.)
    const skip = 4; // 160x90 for a 640x360 buffer is plenty for mobile AR mesh

    const vertices = [];
    const indices = []; // If we want a solid mesh (triangles). For now, let's try Points first or separate Triangle function.
    // Actually, GLB export works best with Triangles. Let's do triangles.

    // Calculate inverse projection matrix to unproject
    const projectionMatrix = new THREE.Matrix4().fromArray(view.projectionMatrix);
    const invProjection = projectionMatrix.clone().invert();

    const resultWidth = Math.floor(width / skip);
    const resultHeight = Math.floor(height / skip);

    // Helper to get depth in meters
    const toMeters = depthInfo.rawValueToMeters || 1.0;

};

// Pre-allocate vector for unprojection to avoid garbage
const vPoint = new THREE.Vector3();


// Generate Vertices
for (let y = 0; y < height; y += skip) {
    for (let x = 0; x < width; x += skip) {
        const d = getDepth(x, y);

        // Ignore invalid depth (0 or too far)
        if (d === 0 || d > 5.0) { // 5 meters max range
            vertices.push(0, 0, 0); // Placeholder, will filter indices later
            continue;
        }

        // NDC coordinates (-1 to +1)
        // x: 0..width -> -1..1
        // y: 0..height -> 1..-1 (Y is up in 3D, down in image)
        const xNDC = (x / width) * 2 - 1;
        const yNDC = 1 - (y / height) * 2;

        // Unproject
        // We need a vector (x, y, z, 1) in clip space.
        // Z in NDC logic for WebXR: depends on depth range.
        // Simple approach: unproject vector set at z = -1 (near) isn't enough, we have the metric depth `d`.

        // Alternative Unprojection:
        // direction = (xNDC, yNDC, -1) * invProj
        // direction = normalize(direction)
        // position = direction * d? 
        // Only true for pinhole centered.

        // Correct way for generalized projection:
        // Point on Image Plane (z=-1 in View Space usually)
        // v_clip = (xNDC, yNDC, -1, 1) -> invProj -> v_view_unscaled
        // v_view = v_view_unscaled / v_view_unscaled.w
        // ray_dir = normalize(v_view)
        // But we have 'd' which is Z-distance (planar) or Euclidean distance? 
        // WebXR depth API usually returns *distance from camera plane* (negative Z in view space).

        // So:
        // X_view = xNDC / projection[0] * -d
        // Y_view = yNDC / projection[5] * (-d?) 
        // This assumes standard perspective matrix structure.

        // Robust method using Vector3.unproject:
        // Z_ndc? We don't know it map to linear depth easily without far/near planes.
        // But we know Z_view = -d.

        // From perspective matrix:
        // x_ndc = (2*n)/(r-l) * X/-Z + ...
        // Simplified for symmetric camera:
        // X = xNDC * (-Z) / P00
        // Y = yNDC * (-Z) / P11
        // This is accurate enough for standard AR cameras.

        const zView = -d;

        // Avoid division by zero from bad projection matrix
        const xView = (xNDC * zView) / P00;
        const yView = (yNDC * zView) / P11;

        if (isNaN(xView) || isNaN(yView) || isNaN(zView) ||
            !isFinite(xView) || !isFinite(yView) || !isFinite(zView)) {
            // Skip invalid points
            vertices.push(0, 0, 0);
            continue;
        }

        vertices.push(xView, yView, zView);
    }
}

// Generate Indices
const widthPts = Math.ceil(width / skip);
// const heightPts = Math.ceil(height / skip);

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
// Actually we can't easily filter them out because indices rely on their position.
// But Three.js and GLTF might handle unused vertices okay? 
// Wait, GLTF exporter might fail on NaN even if unused.
// So we should collapse NaNs to a single 'safe' vertex (e.g. 0,0,0) OR 
// better: replace them with 0,0,0 but ensure they are not indexed.
// Since we filtered `indices` above, these NaN vertices are NOT indexed.
// So we can safely replace all NaNs with 0 in the final attribute to please the exporter.

for (let i = 0; i < vertices.length; i++) {
    if (isNaN(vertices[i])) vertices[i] = 0;
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
geometry.setIndex(indices);
geometry.computeVertexNormals();

// Material - Vertex colors based on Z for visual style
const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.2,
    side: THREE.DoubleSide,
    wireframe: false
});
// Add vertex colors logic later if needed

return new THREE.Mesh(geometry, material);
}
