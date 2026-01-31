import * as THREE from 'three';

/**
 * ARScanner - Voxel-based Point Cloud Fusion with Probabilistic Clearing
 * 
 * grid: Map<string, Voxel>
 * Voxel Key: "x,y,z" (integers, quantized world coords)
 * Voxel: { 
 *   x, y, z: float (running average center),
 *   r, g, b: int (running average color),
 *   weight: float (confidence accumulator),
 *   confidence: float (0.0 to 1.0, probability of existence),
 *   lastSeen: number (timestamp)
 * }
 */
export class ARScanner {
    constructor(scene, renderer) {
        this.scene = scene;
        this.renderer = renderer;

        this.voxels = new Map();
        this.cellSize = 0.05; // 5cm voxels (balanced)

        // Config
        this.minCount = 2; // Need at least 2 confirmations
        this.nextCellSize = 0.05;
        this.minDepth = 0.2; // 20cm min
        this.maxDepth = 5.0; // 5m max

        this.confidenceThreshold = 0.5; // Stricter visibility
        this.clearingEnabled = true;

        this.totalPointsFused = 0;
        this.framesProcessed = 0;
        this.lastFrame = null; // For temporal consistency

        // Visuals
        this.material = new THREE.PointsMaterial({
            vertexColors: true,
            size: 0.015,
            sizeAttenuation: true,
            map: null,
            transparent: false,
            depthTest: true,
            depthWrite: true
        });

        this.pointCloud = null;
        this.geometry = null;
        this.tempVector = new THREE.Vector3();
        this.tempMatrix = new THREE.Matrix4();
    }

    start() {
        this.clear();
        this.isScanning = true;
    }

    stop() {
        this.isScanning = false;
        this.rebuildPointCloud();
    }

    clear() {
        this.voxels.clear();
        this.lastFrame = null;
        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud = null;
        }
        this.framesProcessed = 0;
    }

    processFrame(depthInfo, view, camera, colorData) {
        if (!this.isScanning) return;

        const width = depthInfo.width;
        const height = depthInfo.height;
        const skip = 3; // Increase skip for performance (3x3 grid)

        // 1. Matrices
        // view.transform.matrix = View -> World (Camera Pose)
        // view.projectionMatrix = View -> Clip
        const camMatrix = new THREE.Matrix4().fromArray(view.transform.matrix);
        const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();

        // 2. Depth Data Parsing
        const isFloat = depthInfo.dataFormat === 'float32';
        const rawData = isFloat ? new Float32Array(depthInfo.data) : new Uint16Array(depthInfo.data);
        const toMeters = depthInfo.rawValueToMeters || 1.0;

        // 3. Temporal Consistency Setup
        // We only fuse points that are consistent with the PREVIOUS frame.
        // This eliminates transient noise (points that flicker in and out).
        const hasHistory = !!this.lastFrame;

        // Variables Reused
        const vNDC = new THREE.Vector3();
        const vView = new THREE.Vector3();
        const vWorld = new THREE.Vector3();

        // Loop
        for (let y = 0; y < height; y += skip) {
            for (let x = 0; x < width; x += skip) {
                const idx = y * width + x;

                let dRaw = rawData[idx];
                if (dRaw === 0) continue; // Invalid

                const dMeters = isFloat ? dRaw : dRaw * toMeters;

                // Range Check
                if (dMeters < this.minDepth || dMeters > this.maxDepth) continue;

                // --- Unproject ---
                // Screen (0..1) -> NDC (-1..1)
                const u = (x + 0.5) / width;
                const v = (y + 0.5) / height;

                // NDC: X=-1..1, Y=-1..1 (Y is usually flipped in WebXR depth vs GL?? 
                // WebXR Depth API: "The top-left corner is at (0, 0)"
                // GL NDC: (-1, -1) is Bottom-Left. 
                // So Y needs flip: yNDC = (1 - v) * 2 - 1
                vNDC.set(u * 2 - 1, (1 - v) * 2 - 1, 0.5); // z=0.5 for unprojection direction
                vNDC.applyMatrix4(invProj);

                // vNDC is now a point in View Space (on the far/near plane kind of).
                // We want direction from origin (0,0,0) to this point.
                // WebXR View Space: -Z is Forward.
                vView.copy(vNDC).normalize();

                // Planar Depth Compensation
                // dMeters is distance along -Z axis (Planar).
                // We need Euclidean distance along the ray 'vView'.
                // Ray intersects plane at Z = -dMeters.
                // Ray = t * vView.
                // t * vView.z = -dMeters  =>  t = -dMeters / vView.z
                if (vView.z >= 0) continue; // Pointing backwards?

                const distEuclidean = -dMeters / vView.z;
                vView.multiplyScalar(distEuclidean);

                // Transform to World
                vWorld.copy(vView).applyMatrix4(camMatrix);

                // --- Temporal Consistency Check ---
                // Before adding, check if this point existed in the last frame's depth map logic.
                let isConsistent = true;
                if (hasHistory) {
                    isConsistent = this.checkConsistency(vWorld, this.lastFrame);
                }

                if (isConsistent) {
                    // Extract Color
                    let r = 255, g = 255, b = 255;
                    if (colorData) {
                        // Simple NN sampling
                        const cx = Math.floor(u * colorData.width);
                        const cy = Math.floor((1 - v) * colorData.height); // Flip Y match?
                        const cIdx = (cy * colorData.width + cx) * 4;
                        if (cIdx >= 0 && cIdx < colorData.data.length - 2) {
                            r = colorData.data[cIdx];
                            g = colorData.data[cIdx + 1];
                            b = colorData.data[cIdx + 2];
                        }
                    }

                    this.fuseSurfel(vWorld, r, g, b, hasHistory ? 1.0 : 0.5); // Higher confidence if confirmed
                }
            }
        }

        // Save Frame for next time
        // We need to clone matrices and data to persist them
        // For performance, we might just store specific points, but Grid is better.
        // Actually storing a full depth map copy is expensive.
        // Optimization: Just store the 'view' and 'projection' and key 'data' ref?
        // WebXR 'data' buffer is valid only for the frame? Usually yes. Need copy.
        // Only Copy if we need it. 
        if (this.framesProcessed % 2 === 0) { // Update history at 30fps/2 = 15fps or every frame?
            // Copying 16-bit array 300x500 is fast enough.
            this.saveLastFrame(depthInfo, rawData, isFloat, toMeters, view);
        }

        this.framesProcessed++;

        // Periodic rebuild
        if (this.framesProcessed % 30 === 0) {
            this.rebuildPointCloud();
        }
    }

    saveLastFrame(depthInfo, rawData, isFloat, toMeters, view) {
        // Clone Data
        const dataCopy = isFloat ? new Float32Array(rawData) : new Uint16Array(rawData);

        this.lastFrame = {
            width: depthInfo.width,
            height: depthInfo.height,
            rawData: dataCopy,
            isFloat: isFloat,
            toMeters: toMeters,
            // Matrices
            viewMatrixInv: new THREE.Matrix4().fromArray(view.transform.inverse.matrix), // World -> View
            projMatrix: new THREE.Matrix4().fromArray(view.projectionMatrix)
        };
    }

    // Projects world point into last frame and verifies depth
    checkConsistency(worldPt, frame) {
        // 1. World -> Last View
        this.tempVector.copy(worldPt);
        this.tempVector.applyMatrix4(frame.viewMatrixInv); // Point in Last View Space

        // Z check (in view space, needs to be in front of camera)
        // WebXR View: -Z is forward. So Z should be negative.
        if (this.tempVector.z >= -0.1) return false; // Behind or too close

        // 2. View -> Clip
        const zView = this.tempVector.z; // Store actual Z (negative)
        this.tempVector.applyMatrix4(frame.projMatrix);

        // 3. NDC
        const w = this.tempVector.w;
        const ndcX = this.tempVector.x / w;
        const ndcY = this.tempVector.y / w;

        if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) return false; // Out of FOV

        // 4. Sample Depth Map
        // NDC -> UV -> Pixel
        const u = (ndcX + 1) / 2;
        // Map Y Top(1) -> 0, Bottom(-1) -> 1 (Similar to unproject reversal)
        const sampleV = (1 - ndcY) / 2;

        const px = Math.floor(u * frame.width);
        const py = Math.floor(sampleV * frame.height);

        if (px < 0 || px >= frame.width || py < 0 || py >= frame.height) return false;

        const idx = py * frame.width + px;
        const dRaw = frame.rawData[idx];
        if (dRaw === 0) return false;

        const dMeters = frame.isFloat ? dRaw : dRaw * frame.toMeters;

        // 5. Compare
        // 'dMeters' is Planar Depth (-Z) at that pixel.
        // 'zView' is the Z coord of our point in that view (negative).
        // So we compare -zView (dist) vs dMeters.
        const distFromPt = -zView;

        // Tolerance: 15cm
        const diff = Math.abs(distFromPt - dMeters);

        if (diff < 0.15) {
            return true;
        }

        return false;
    }

    fuseSurfel(worldPt, r, g, b, confidenceMod = 1.0) {
        const cell = this.cellSize;
        const ix = Math.floor(worldPt.x / cell);
        const iy = Math.floor(worldPt.y / cell);
        const iz = Math.floor(worldPt.z / cell);
        const key = `${ix},${iy},${iz}`;

        let surfel = this.voxels.get(key);
        const weight = 1.0;

        if (!surfel) {
            surfel = {
                x: worldPt.x, y: worldPt.y, z: worldPt.z,
                r: r, g: g, b: b,
                weight: weight,
                confidence: 0.1 * confidenceMod,
                lastSeen: Date.now()
            };
            this.voxels.set(key, surfel);
        } else {
            // Moving Average
            const w = surfel.weight;
            const nw = w + weight;
            const alpha = weight / nw;

            surfel.x += (worldPt.x - surfel.x) * alpha;
            surfel.y += (worldPt.y - surfel.y) * alpha;
            surfel.z += (worldPt.z - surfel.z) * alpha;

            surfel.r += (r - surfel.r) * alpha;
            surfel.g += (g - surfel.g) * alpha;
            surfel.b += (b - surfel.b) * alpha;

            surfel.weight = Math.min(nw, 50);

            // Confidence boost
            surfel.confidence += 0.1 * confidenceMod;
            if (surfel.confidence > 1.0) surfel.confidence = 1.0;

            surfel.lastSeen = Date.now();
        }
    }

    // Simplified pruning: Remove old/low conf points
    rebuildPointCloud() {
        if (this.voxels.size === 0) return;

        const vertices = [];
        const colors = [];
        const now = Date.now();

        // Prune Loop
        for (const [key, s] of this.voxels) {
            if (s.confidence < this.confidenceThreshold) {
                if (s.confidence < 0.01) this.voxels.delete(key);
                continue;
            }

            vertices.push(s.x, s.y, s.z);
            colors.push(s.r / 255, s.g / 255, s.b / 255);
        }

        if (vertices.length === 0) return;

        if (!this.pointCloud) {
            this.geometry = new THREE.BufferGeometry();
            this.pointCloud = new THREE.Points(this.geometry, this.material);
            this.pointCloud.isARMesh = true;
            this.pointCloud.frustumCulled = false;
            this.scene.add(this.pointCloud);
        }

        this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    }
}
