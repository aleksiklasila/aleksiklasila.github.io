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
        this.minCount = 5;
        this.minBaseline = 0.10; // 10cm distance between views

        // Visualization
        this.pointCloud = null;
        this.geometry = null;
        this.material = new THREE.PointsMaterial({
            vertexColors: true,
            size: 0.02,
            sizeAttenuation: true
        });

        this.isScanning = false;
        // Optimization: Rebuild throttler
        this.framesSinceRebuild = 0;
        this.rebuildInterval = 30; // Update mesh every 30 frames (0.5s at 60fps)
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

    /**
     * Process a depth frame and fuse into voxel grid
     */
    processFrame(depthInfo, view, camera) {
        if (!this.isScanning) return;

        // Use getDepthInMeters to ensure correct format/scaling
        const width = depthInfo.width;
        const height = depthInfo.height;
        const skip = 4;

        const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
        const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

        const vPoint = new THREE.Vector3();
        const vDir = new THREE.Vector3();

        for (let y = 0; y < height; y += skip) {
            for (let x = 0; x < width; x += skip) {
                // Safety Check for RangeError
                if (x >= width || y >= height) continue;

                // 1. Get Depth (Meters)
                let d;
                try {
                    d = depthInfo.getDepthInMeters(x, y);
                } catch (e) {
                    continue; // Skip invalid
                }

                // Valid Depth Filter
                if (d <= 0.1 || d > 5.0 || !isFinite(d)) continue;

                // 2. Unproject
                const xNorm = (x + 0.5) / width;
                const yNorm = (y + 0.5) / height;

                const xNDC = xNorm * 2 - 1;
                const yNDC = (1 - yNorm) * 2 - 1;

                vPoint.set(xNDC, yNDC, 0.5);
                vPoint.applyMatrix4(invProj);
                if (vPoint.w === 0) continue;

                vDir.set(vPoint.x, vPoint.y, vPoint.z).normalize();
                if (vDir.z >= 0) continue;

                const scale = -d / vDir.z;
                vPoint.copy(vDir).multiplyScalar(scale);
                vPoint.applyMatrix4(camera.matrixWorld);

                this.fusePoint(vPoint, camPos);
            }
        }

        this.framesSinceRebuild++;
        if (this.framesSinceRebuild > this.rebuildInterval) {
            this.rebuildPointCloud();
            this.framesSinceRebuild = 0;
        }
    }

    fusePoint(worldPt, camPos) {
        // Quantize
        const ix = Math.floor(worldPt.x / this.cellSize);
        const iy = Math.floor(worldPt.y / this.cellSize);
        const iz = Math.floor(worldPt.z / this.cellSize);
        const key = `${ix},${iy},${iz}`;

        let voxel = this.voxels.get(key);
        if (!voxel) {
            voxel = {
                x: worldPt.x,
                y: worldPt.y,
                z: worldPt.z,
                count: 1,
                minCx: camPos.x, maxCx: camPos.x,
                minCy: camPos.y, maxCy: camPos.y,
                minCz: camPos.z, maxCz: camPos.z,
                // Logic Coords for ROR
                ix: ix, iy: iy, iz: iz
            };
            this.voxels.set(key, voxel);
        } else {
            // Running Average
            const c = voxel.count;
            const nc = c + 1;
            voxel.x = (voxel.x * c + worldPt.x) / nc;
            voxel.y = (voxel.y * c + worldPt.y) / nc;
            voxel.z = (voxel.z * c + worldPt.z) / nc;
            voxel.count = nc;

            // Expand Baseline
            if (camPos.x < voxel.minCx) voxel.minCx = camPos.x;
            if (camPos.x > voxel.maxCx) voxel.maxCx = camPos.x;
            if (camPos.y < voxel.minCy) voxel.minCy = camPos.y;
            if (camPos.y > voxel.maxCy) voxel.maxCy = camPos.y;
            if (camPos.z < voxel.minCz) voxel.minCz = camPos.z;
            if (camPos.z > voxel.maxCz) voxel.maxCz = camPos.z;
        }
    }

    rebuildPointCloud() {
        const vertices = [];
        const colors = [];

        let accepted = 0;
        let rejected = 0;

        // Helper to check neighbor existence
        const checkNeighbor = (ix, iy, iz) => {
            const key = `${ix},${iy},${iz}`;
            const v = this.voxels.get(key);
            // Neighbor must also be relatively stable (>1 hit)
            return (v && v.count >= 2) ? 1 : 0;
        };

        for (const v of this.voxels.values()) {
            // 1. Persistence Filter
            if (v.count < this.minCount) {
                rejected++;
                continue;
            }

            // 2. Radius Outlier Removal (ROR)
            let neighborCount = 0;
            const ix = v.ix;
            const iy = v.iy;
            const iz = v.iz;

            // Check 26 neighbors
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        if (checkNeighbor(ix + dx, iy + dy, iz + dz)) {
                            neighborCount++;
                        }
                    }
                }
                if (neighborCount >= 3) break;
            }

            // Require neighbors
            if (neighborCount < 2) {
                rejected++;
                continue;
            }

            // Accepted
            vertices.push(v.x, v.y, v.z);

            // Heatmap
            const intensity = Math.min(1.0, 0.3 + (neighborCount / 26.0) * 0.7 + (v.count / 50) * 0.2);
            colors.push(0, intensity, intensity * 0.5 + 0.5);

            accepted++;
        }

        console.log(`Rebuild ROR: ${accepted} voxels (rej: ${rejected}). Total Map: ${this.voxels.size}`);

        if (accepted === 0) return;

        if (!this.pointCloud) {
            this.geometry = new THREE.BufferGeometry();
            this.pointCloud = new THREE.Points(this.geometry, this.material);
            this.pointCloud.isARMesh = true;
            this.scene.add(this.pointCloud);
        }

        const posAttr = new THREE.Float32BufferAttribute(vertices, 3);
        const colAttr = new THREE.Float32BufferAttribute(colors, 3);

        this.geometry.setAttribute('position', posAttr);
        this.geometry.setAttribute('color', colAttr);

        this.geometry.computeBoundingSphere();
    }
}
