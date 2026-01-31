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
        this.cellSize = 0.03; // 3cm voxels default

        // Config
        this.minCount = 3;
        this.nextCellSize = 0.03;
        this.minDepth = 0.1;
        this.maxDepth = 5.0;

        this.confidenceThreshold = 0.3; // Min confidence to render
        this.clearingEnabled = true;

        this.totalPointsFused = 0;
        this.framesProcessed = 0;

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
        const skip = 2; // Density control

        // Matrices
        const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
        const camMatrix = camera.matrixWorld;
        const camPos = new THREE.Vector3().setFromMatrixPosition(camMatrix);

        // Raw Depth Data
        const isFloat = depthInfo.dataFormat === 'float32';
        const rawData = isFloat ? new Float32Array(depthInfo.data) : new Uint16Array(depthInfo.data);
        const toMeters = depthInfo.rawValueToMeters || 1.0;

        // 1. CLEARING PASS (Probabilistic Pruning)
        // Check a subset of existing voxels to see if they are now "empty"
        if (this.clearingEnabled && this.voxels.size > 0 && this.framesProcessed % 3 === 0) {
            this.pruneVoxels(view, depthInfo, rawData, isFloat, toMeters, camMatrix, width, height);
        }

        // 2. FUSION PASS
        const vPoint = new THREE.Vector3();
        const vDir = new THREE.Vector3();
        const vWorld = new THREE.Vector3();
        const invCamMatrix = camMatrix.clone().invert(); // For temporal projection usually, but here we forward project? 
        // Actually for fusion we just unproject new points.

        for (let y = 0; y < height; y += skip) {
            for (let x = 0; x < width; x += skip) {
                // Bounds check
                if (x >= width || y >= height) continue;

                const idx = y * width + x;
                let d;
                if (isFloat) d = rawData[idx];
                else d = rawData[idx] * toMeters;

                // Validity
                if (d < this.minDepth || d > this.maxDepth || !isFinite(d)) continue;

                // Unproject
                const xNorm = (x + 0.5) / width;
                const yNorm = (y + 0.5) / height;
                const xNDC = xNorm * 2 - 1;
                const yNDC = (1 - yNorm) * 2 - 1;

                vPoint.set(xNDC, yNDC, 0.5);
                vPoint.applyMatrix4(invProj);
                if (vPoint.w === 0) continue;

                vDir.set(vPoint.x, vPoint.y, vPoint.z).normalize();
                if (vDir.z >= 0) continue; // Behind

                const scale = -d / vDir.z;
                vPoint.copy(vDir).multiplyScalar(scale);
                vWorld.copy(vPoint).applyMatrix4(camMatrix);

                // Color
                let r = 200, g = 200, b = 200;
                if (colorData) {
                    const cx = Math.floor(xNorm * colorData.width);
                    const cy = Math.floor((1.0 - yNorm) * colorData.height); // Flip Y needed? Usually yes for textures
                    const cIdx = (cy * colorData.width + cx) * 4;
                    if (cIdx >= 0 && cIdx < colorData.data.length) {
                        r = colorData.data[cIdx];
                        g = colorData.data[cIdx + 1];
                        b = colorData.data[cIdx + 2];
                    }
                }

                this.fuseSurfel(vWorld, r, g, b);
            }
        }

        this.framesProcessed++;

        // Periodic rebuild (every 30 frames or so, or adaptive)
        if (this.framesProcessed % 30 === 0) {
            this.rebuildPointCloud();
        }
    }

    fuseSurfel(worldPt, r, g, b) {
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
                confidence: 0.1, // Start low
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

            surfel.weight = Math.min(nw, 50); // Cap weight

            // Boost confidence on confirmation
            surfel.confidence += 0.2;
            if (surfel.confidence > 1.0) surfel.confidence = 1.0;

            surfel.lastSeen = Date.now();
        }
    }

    // New: Check if existing voxels are conflicting with current depth map
    pruneVoxels(view, depthInfo, rawData, isFloat, toMeters, camMatrix, width, height) {
        const projMatrix = new THREE.Matrix4().fromArray(view.projectionMatrix);
        // Inverse Camera (World -> View)
        const viewMatrix = camMatrix.clone().invert();

        // We iterate a subset to stay fast. 
        // e.g., 500 random voxels or sequential? 
        // Let's try iterating all but skipping if too many?
        // JS Map iteration is efficient enough for < 10k items usually.
        // If map grows large, we need a better structure or subsets.

        let checked = 0;
        const maxChecks = 2000; // Budget

        // Todo: Maintain a "check index" to cycle through voxels efficiently

        for (const [key, surfel] of this.voxels) {
            if (checked++ > maxChecks) break;

            // 1. Transform World -> View
            this.tempVector.set(surfel.x, surfel.y, surfel.z);
            this.tempVector.applyMatrix4(viewMatrix); // Now in View Space (Camera at 0,0,0)

            // Z is negative in view space relative to camera forward (-Z)
            const distVoxel = -this.tempVector.z;

            if (distVoxel < this.minDepth) continue; // Too close to check

            // 2. Project to Clip -> NDC -> Screen
            this.tempVector.applyMatrix4(projMatrix);
            const ndcX = this.tempVector.x / this.tempVector.w;
            const ndcY = this.tempVector.y / this.tempVector.w;

            if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) continue; // Out of frame

            // 3. Sample Depth Map
            // Map NDC to 0..1 then to pixels
            const sX = (ndcX + 1) / 2 * width;
            const sY = (1 - ndcY) / 2 * height; // Flip Y for image coords usually?
            // Note: In WebXR depth, check if texture is Y-flipped. usually yes relative to GL.

            const pX = Math.floor(sX);
            const pY = Math.floor(sY);

            if (pX < 0 || pX >= width || pY < 0 || pY >= height) continue;

            const idx = pY * width + pX;
            let dMap;
            if (isFloat) dMap = rawData[idx];
            else dMap = rawData[idx] * toMeters;

            // 4. Compare
            // If the Depth Map says the surface is at 3.0m, but our Voxel is at 1.0m...
            // Then the Voxel is floating in mid-air (Ghost).
            // Threshold: margin of error (e.g., 10cm)

            if (dMap > distVoxel + 0.15) {
                // Voxel is in empty space!
                // Penalty
                surfel.confidence -= 0.15;
                if (surfel.confidence <= 0) {
                    this.voxels.delete(key);
                }
            } else if (Math.abs(dMap - distVoxel) < 0.05) {
                // Confirmation (optional, maybe keep fusion to do this)
                // surfel.confidence += 0.05;
            }
        }
    }

    rebuildPointCloud() {
        if (this.voxels.size === 0) return;

        const vertices = [];
        const colors = [];

        let count = 0;
        for (const s of this.voxels.values()) {
            if (s.confidence < this.confidenceThreshold) continue;

            vertices.push(s.x, s.y, s.z);
            colors.push(s.r / 255, s.g / 255, s.b / 255);
            count++;
        }

        if (count === 0) return;

        if (!this.pointCloud) {
            this.geometry = new THREE.BufferGeometry();
            this.pointCloud = new THREE.Points(this.geometry, this.material);
            this.pointCloud.isARMesh = true;
            this.scene.add(this.pointCloud);
        }

        this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        this.geometry.computeBoundingSphere();

        // this.pointCloud.geometry.attributes.position.needsUpdate = true; // If reusing
    }
}
