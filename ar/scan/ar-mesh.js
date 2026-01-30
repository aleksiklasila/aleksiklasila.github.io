import * as THREE from 'three';

/**
 * Generates a Three.js Point Cloud from XRDepthInformation.
 * @param {XRCPUDepthInformation} depthInfo - The CPU depth information from WebXR.
 * @param {XRView | THREE.Camera} viewOrCamera - The XRView or Camera used for projection.
 * @returns {THREE.Points} - The generated point cloud.
 */
export function buildMeshFromDepth(depthInfo, viewOrCamera) {
    const width = depthInfo.width;
    const height = depthInfo.height;

    // Safety check for empty buffer
    if (depthInfo.data.byteLength === 0) {
        console.warn("Empty depth data, returning empty points.");
        return null;
    }

    // Point cloud can use higher resolution safely
    const skip = 2;

    const vertices = [];
    const colors = [];

    // Resolve Projection Matrix (Array)
    let projElements;
    if (viewOrCamera.projectionMatrix instanceof THREE.Matrix4) {
        // It's a Three.js Camera
        projElements = viewOrCamera.projectionMatrix.elements;
    } else if (viewOrCamera.projectionMatrix) {
        // It's an XRView (Float32Array)
        projElements = viewOrCamera.projectionMatrix;
    } else {
        console.error("No projection matrix found on view object");
        return null;
    }

    const projectionMatrix = new THREE.Matrix4().fromArray(projElements);
    const invProjection = projectionMatrix.clone().invert();

    const resultWidth = Math.floor(width / skip);
    const resultHeight = Math.floor(height / skip);

    // DEBUG: Read raw buffer to see what's happening
    // getDepthInMeters might be failing or returning constant if normalization is wrong.
    const rawData = new Uint16Array(depthInfo.data);
    const isFloat = depthInfo.dataFormat === 'float32';
    const data = isFloat ? new Float32Array(depthInfo.data) : rawData;
    const toMeters = depthInfo.rawValueToMeters || 1.0;

    // Log first few values
    let logStr = "Raw Sample: ";
    for (let i = 0; i < 5; i++) logStr += data[i] + ", ";

    // Calc stats
    let dMin = Infinity, dMax = -Infinity;
    for (let i = 0; i < data.length; i += 100) { // sparse sample
        const v = data[i];
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
    }
    console.log(`${logStr} | Range: [${dMin}, ${dMax}] | Len: ${data.length}`);
    console.log(`Format: ${depthInfo.dataFormat}, toMeters: ${toMeters}`);
    // Check Projection
    const det = projectionMatrix.determinant();
    console.log(`Proj Det: ${det}. Elements[0]=${projElements[0]}`);

    const getDepth = (x, y) => {
        // Fallback to manual read if getDepthInMeters is suspect
        // return depthInfo.getDepthInMeters(x, y);
        const index = y * width + x;
        if (isFloat) return data[index];
        return data[index] * toMeters;
    };

    // Debug bounds / Sample center
    const dCenter = getDepth(Math.floor(width / 2), Math.floor(height / 2));
    console.log(`Center depth: ${dCenter}m.  Res: ${width}x${height}`);

    const vPoint = new THREE.Vector3();

    for (let y = 0; y < resultHeight; y++) {
        for (let x = 0; x < resultWidth; x++) {
            const srcX = x * skip;
            const srcY = y * skip;

            const d = getDepth(srcX, srcY);

            // Filter invalid depth (0 is invalid, > 5m is usually far clip)
            // Confidence check: WebXR Depth doesn't always expose per-pixel confidence in the basic array,
            // but we can filter out "flying pixels" or 0 values more aggressively.

            // getDepthInMeters uses the normalized coordinates to look up the depth.
            // We should iterate over the *Depth Buffer* dimensions, but map center of those pixels 
            // to normalized view coordinates.

            // Current approach: iterating result grid (subsampled) -> srcX, srcY -> depth

            if (d <= 0.1 || d > 8.0 || !isFinite(d)) continue;

            // Strict Unprojection
            // X, Y in NDC space (-1 to 1)
            // We must use the center of the pixel in the depth map for accuracy
            const xNorm = (x + 0.5) / resultWidth; // 0..1
            const yNorm = (y + 0.5) / resultHeight; // 0..1

            const xNDC = xNorm * 2 - 1;
            const yNDC = (1 - yNorm) * 2 - 1; // Flip Y for NDC? WebXR usually Y up? 
            // Actually, in Three.js/WebGL:
            // xNDC: -1 (left) to 1 (right)
            // yNDC: -1 (bottom) to 1 (top)
            // Screen Y usually top-down (0 at top).
            // Let's assume standard GL NDC.

            vPoint.set(xNDC, yNDC, 0.5);
            vPoint.applyMatrix4(invProjection);

            // Perspective divide?
            // "applyMatrix4" with Matrix4 (Project->View inverse) usually puts us in View Space directly 
            // IF w is handled. Three.js Vector3.applyMatrix4 does divide by w.
            // But for unprojecting a depth value 'd', we often do a ray cast.

            // Ray Unprojection Method (More robust for VR/AR):
            // 1. Unproject a point at Z=-1 (arbitrary) to get direction.
            // 2. Normalize direction.
            // 3. Multiply by depth 'd'.

            // Let's try RayCast method:
            vPoint.set(xNDC, yNDC, 0.5); // Z doesn't matter much for direction, just get a point
            // Wait, viewOrCamera might be XRView which doesn't have 'unproject' helper.
            // We have invProjection.

            // Manual Unproject to View Space
            const xClip = xNDC;
            const yClip = yNDC;
            const zClip = 0.5; // arbitrary inside frustum

            // Homogeneous Clip Space
            const vClip = new THREE.Vector4(xClip, yClip, zClip, 1.0);
            vClip.applyMatrix4(invProjection);

            // View Space (Homogeneous) -> Cartesian
            // vView is a point on the ray passing through (x,y).
            // But we know the *metric depth* 'd' is -Z in View Space (usually).

            // Direction from origin (0,0,0) to vClip
            // In View Space, camera is at 0,0,0.
            if (vClip.w === 0) continue;
            const vDir = new THREE.Vector3(vClip.x / vClip.w, vClip.y / vClip.w, vClip.z / vClip.w);
            vDir.normalize();

            // If vDir.z is positive (behind camera), skip
            if (vDir.z >= 0) continue;

            // Determine scale factor to reach depth 'd'
            // We defined 'd' as distance along -Z axis (planar depth) OR Euclidean distance?
            // WebXR getDepthInMeters usually returns "distance from the view's origin plane" (-Z).
            // So Z_view = -d.

            const scale = -d / vDir.z;

            const xView = vDir.x * scale;
            const yView = vDir.y * scale;
            const zView = vDir.z * scale; // Should be -d exactly


            if (!isFinite(xView) || !isFinite(yView) || !isFinite(zView)) continue;

            vertices.push(xView, yView, zView);

            // Color Mapping: Near (0.2m) = Red, Far (2.0m) = Blue
            // Simple gradient
            let norm = (d - 0.2) / 2.0;
            if (norm < 0) norm = 0; if (norm > 1) norm = 1;

            // Red to Blue
            colors.push(1.0 - norm, 0.5 * (1 - Math.abs(norm * 2 - 1)), norm);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    // Point Cloud Material
    const material = new THREE.PointsMaterial({
        vertexColors: true, // USE VERTEX COLORS
        size: 0.03,
        sizeAttenuation: true,
        transparent: false
    });

    console.log(`Generated PointCloud: ${vertices.length / 3} points.`);
    return new THREE.Points(geometry, material);
}
