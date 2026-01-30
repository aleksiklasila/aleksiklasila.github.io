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
    // processFrame(depthInfo, view, camera)
    if(!this.isScanning) return;

    // Use getDepthInMeters to ensure correct format/scaling
    // Iterating the Depth Buffer coordinates directly ensures we hit valid data points.

    const width = depthInfo.width;
    const height = depthInfo.height;

    // Stride: Process fewer points for performance
    const skip = 4;

    const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

    const vPoint = new THREE.Vector3();
    const vDir = new THREE.Vector3();

    for(let y = 0; y <height; y += skip) {
        for (let x = 0; x < width; x += skip) {
            // 1. Get Depth (Meters) - High Level API (Handles Float32/UInt16/Scale)
            // Note: x, y are column, row in the *Depth Buffer*
            const d = depthInfo.getDepthInMeters(x, y);

            // Valid Depth Filter
            if (d <= 0.1 || d > 5.0 || !isFinite(d)) continue;

            // 2. Unproject
            // Map Depth Buffer (x,y) -> Normalized View Coords (0..1)
            // NOTE: WebXR depth buffer might be subset of view, or scaled.
            // normTextureCoordinate is usually for GPU. For CPU 'getDepthInMeters', 
            // (x,y) corresponds to the grid. We assume the grid covers the view 1:1?
            // Standard WebXR: The depth buffer covers the `view` frustum.

            const xNorm = (x + 0.5) / width;
            const yNorm = (y + 0.5) / height; // 0=Top or Bottom? 
            // Usually GL convention: 0,0 is bottom-left? Or Image convention (top-left)?
            // depthInfo access is usually (col, row). Row 0 is usually top?
            // WebXR Normalized Coords: (0,0) is usually Bottom-Left for GL.
            // But getDepthInMeters(col, row) follows image data (Row 0 = Top).

            // Let's assume standard Image Space for x,y iteration -> Y is Down.
            // NDC Y is Up.
            const xNDC = xNorm * 2 - 1;       // 0..1 -> -1..1
            const yNDC = (1 - yNorm) * 2 - 1; // 0..1(Top->Bot) -> 1..-1?
            // Wait: if y=0 (Top) -> yNorm=0 -> yNDC = 1. (Top in GL is +1). Correct.

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
            // Bounding box of camera positions that saw this voxel
            // Bounding box of camera positions
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

    for (const v of this.voxels.values()) {
        // --- Confidence Filters ---

        // 1. Persistence
        if (v.count < this.minCount) {
            rejected++;
            continue;
        }

        // 2. Baseline Check (Parallax)
        const dx = v.maxCx - v.minCx;
        const dy = v.maxCy - v.minCy;
        const dz = v.maxCz - v.minCz;
        const baselineSq = dx * dx + dy * dy + dz * dz;

        if (baselineSq < this.minBaseline * this.minBaseline) {
            rejected++;
            continue;
        }

        // Accepted
        vertices.push(v.x, v.y, v.z);

        // Color by confidence? Or just fixed cyan?
        // Let's do cyan, slightly brighter for high count
        const intensity = Math.min(1.0, 0.5 + v.count * 0.05);
        colors.push(0, intensity, intensity);

        accepted++;
    }

    console.log(`Rebuild: ${accepted} voxels (rej: ${rejected}). Total Map: ${this.voxels.size}`);

    if (accepted === 0) return;

    if (!this.pointCloud) {
        this.geometry = new THREE.BufferGeometry();
        this.pointCloud = new THREE.Points(this.geometry, this.material);
        this.pointCloud.isARMesh = true; // Tag for export
        this.scene.add(this.pointCloud);
    }

    const posAttr = new THREE.Float32BufferAttribute(vertices, 3);
    const colAttr = new THREE.Float32BufferAttribute(colors, 3);

    this.geometry.setAttribute('position', posAttr);
    this.geometry.setAttribute('color', colAttr);

    // Bounds for frustum culling
    this.geometry.computeBoundingSphere();
}
}
