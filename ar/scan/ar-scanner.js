import * as THREE from 'three';

/**
 * ARScanner - Voxel-based Point Cloud Fusion
 * 
 * grid: Map<string, Voxel>
 * Voxel Key: "x,y,z" (integers, quantized world coords)
 * Voxel: { 
 *   x, y, z: float (running average center),
 *   count: int (observations),
 *   viewDir: Vector3 (average view direction - simplified for minimal memory),
 *   minView: Vector3, maxView: Vector3 (bounding box of camera positions seeing this voxel)
 * }
 */
export class ARScanner {
    constructor(scene, renderer) {
        this.scene = scene;
        this.renderer = renderer;

        this.voxels = new Map();
        this.cellSize = 0.03; // 3cm voxels

        // Confidence Config
        // Confidence Config
        this.minCount = 3;
        // this.cellSize set above
        this.nextCellSize = 0.03;

        // Dynamic Filters
        this.minDepth = 0.1;
        this.maxDepth = 5.0;

        // ... existing ...
        this.totalPointsFused = 0;

        // Visualization - Gaussian Splat Shader
        // Visualization - Standard Point Cloud
        // User requested "Point Clouds" instead of Splats
        this.material = new THREE.PointsMaterial({
            vertexColors: true,
            size: 0.015, // 1.5cm points
            sizeAttenuation: true, // Scale with distance
            map: null, // Hard squares (fastest) or use a disc texture if needed
            transparent: false, // Opaque points for solid feel
            depthTest: true,
            depthWrite: true
        });

        // Use a simple circle texture for nicer points if desired, but user said "Point Clouds"
        // Standard squares are the most "Point Cloud" look.
        // If we want circles:
        /*
        const loader = new THREE.TextureLoader();
        const disk = loader.load('https://threejs.org/examples/textures/sprites/disc.png');
        this.material.map = disk;
        this.material.alphaTest = 0.5;
        this.material.transparent = true;
        */

        this.pointCloud = null;
        this.geometry = null;
    }

    start() {
        this.clear();
        this.isScanning = true;
    }

    stop() {
        this.isScanning = false;
        this.rebuildPointCloud(); // Final high-quality build
    }

    clear() {
        this.voxels.clear();
        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud = null;
        }
    }

    processFrame(depthInfo, view, camera, colorData) {
        if (!this.isScanning) return;

        const width = depthInfo.width;
        const height = depthInfo.height;
        // High density scan
        const skip = 2;

        // Camera Data
        const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
        const camMatrix = camera.matrixWorld;
        const camPos = new THREE.Vector3().setFromMatrixPosition(camMatrix);

        // Reusable vectors
        const vPoint = new THREE.Vector3();
        const vDir = new THREE.Vector3();
        const vWorld = new THREE.Vector3();

        let pointsFused = 0;

        for (let y = 0; y < height; y += skip) {
            for (let x = 0; x < width; x += skip) {
                // Bounds check
                if (x >= width || y >= height) continue;

                // 1. Get Depth
                let d;
                try {
                    d = depthInfo.getDepthInMeters(x, y);
                } catch (e) { continue; }

                // 2. Filter Validity
                if (d < this.minDepth || d > this.maxDepth || !isFinite(d)) continue;

                // 3. Unproject
                const xNorm = (x + 0.5) / width;
                const yNorm = (y + 0.5) / height;

                // Screen to NDC
                const xNDC = xNorm * 2 - 1;
                const yNDC = (1 - yNorm) * 2 - 1;

                vPoint.set(xNDC, yNDC, 0.5);
                vPoint.applyMatrix4(invProj);
                if (vPoint.w === 0) continue; // Invalid projection

                vDir.set(vPoint.x, vPoint.y, vPoint.z).normalize();
                if (vDir.z >= 0) continue; // Must be looking forward

                // Scale to Depth
                const scale = -d / vDir.z;
                vPoint.copy(vDir).multiplyScalar(scale);

                // Camera Space -> World Space
                vWorld.copy(vPoint).applyMatrix4(camMatrix);

                // 4. Color Sample
                let r = 200, g = 200, b = 200;
                if (colorData) {
                    const cx = Math.floor(xNorm * colorData.width);
                    const cy = Math.floor((1.0 - yNorm) * colorData.height);
                    const idx = (cy * colorData.width + cx) * 4;
                    if (idx >= 0 && idx < colorData.data.length) {
                        r = colorData.data[idx];
                        g = colorData.data[idx + 1];
                        b = colorData.data[idx + 2];
                    }
                }

                // 5. Fuse
                this.fuseSurfel(vWorld, camPos, r, g, b, d);
                pointsFused++;
            }
        }

        this.framesSinceRebuild++;
        if (this.framesSinceRebuild > this.rebuildInterval) {
            this.rebuildPointCloud();
            this.framesSinceRebuild = 0;
        }
    }

    fuseSurfel(worldPt, camPos, r, g, b, depth) {
        // Quantize position for spatial hashing
        // This is still a voxel map, but we store specific surfel data inside
        const cell = this.cellSize;
        const ix = Math.floor(worldPt.x / cell);
        const iy = Math.floor(worldPt.y / cell);
        const iz = Math.floor(worldPt.z / cell);
        const key = `${ix},${iy},${iz}`;

        let surfel = this.voxels.get(key);

        // Confidence Weighting:
        // Points closer to camera are usually more accurate in simple estimation? 
        // Actually, for ToF/Lidar, accuracy is decent.
        // Let's use a simple weight of 1 for now.
        const weight = 1.0;

        if (!surfel) {
            // New Surfel
            surfel = {
                x: worldPt.x, y: worldPt.y, z: worldPt.z,      // Position
                nx: 0, ny: 1, nz: 0,                           // Normal (Default up)
                r: r, g: g, b: b,                              // Color
                radius: this.cellSize * 0.8,                   // Radius
                weight: weight,                                // Accumulated Weight
                confidence: 0,                                // 0-1 Confidence score
                lastSeen: Date.now()
            };
            this.voxels.set(key, surfel);
        } else {
            // Merge into existing Surfel (Moving Average)
            const w = surfel.weight;
            const nw = w + weight;
            const alpha = weight / nw; // Blend factor

            // 1. Positional Average
            surfel.x += (worldPt.x - surfel.x) * alpha;
            surfel.y += (worldPt.y - surfel.y) * alpha;
            surfel.z += (worldPt.z - surfel.z) * alpha;

            // 2. Color Average
            surfel.r += (r - surfel.r) * alpha;
            surfel.g += (g - surfel.g) * alpha;
            surfel.b += (b - surfel.b) * alpha;

            // 3. Update Weight & Confidence
            surfel.weight = nw;
            // Cap weight to prevent infinite accumulation dragging
            if (surfel.weight > 50) surfel.weight = 50;

            // Confidence grows with observations
            surfel.confidence += 0.1;
            if (surfel.confidence > 1.0) surfel.confidence = 1.0;

            surfel.lastSeen = Date.now();
        }
    }

    rebuildPointCloud() {
        const vertices = [];
        const colors = [];
        const sizes = [];
        const intensities = [];

        let accepted = 0;
        const minConf = 0.2; // Require at least 2-3 frames of confirmation

        for (const s of this.voxels.values()) {
            // Filter noise
            if (s.confidence < minConf) continue;

            vertices.push(s.x, s.y, s.z);
            colors.push(s.r / 255.0, s.g / 255.0, s.b / 255.0);

            // Size based on grid size but could be adaptive
            sizes.push(this.cellSize * 4.0);

            // Opacity reflects confidence
            // 0.4 base + 0.6 * confidence
            intensities.push(0.4 + 0.6 * s.confidence);

            accepted++;
        }

        if (accepted === 0) return;

        if (!this.pointCloud) {
            this.geometry = new THREE.BufferGeometry();
            this.pointCloud = new THREE.Points(this.geometry, this.material);
            this.pointCloud.isARMesh = true;
            this.scene.add(this.pointCloud);
        }

        this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        // Standard PointsMaterial doesn't use 'size' or 'intensity' attributes by default

        this.geometry.computeBoundingSphere();

        this.geometry.computeBoundingSphere();
    }
}
