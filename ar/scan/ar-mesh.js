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
            if (d <= 0 || d > 8.0 || !isFinite(d)) continue;

            // NDC: -1..1
            const xNDC = (srcX / width) * 2 - 1;
            const yNDC = 1 - (srcY / height) * 2;

            // Robust Unprojection
            vPoint.set(xNDC, yNDC, 0.5);
            vPoint.applyMatrix4(invProjection);

            if (vPoint.z === 0) continue;

            const scale = -d / vPoint.z;
            const xView = vPoint.x * scale;
            const yView = vPoint.y * scale;
            const zView = -d;

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
