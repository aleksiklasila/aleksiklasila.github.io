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
        this.minCount = 3;
        this.cellSize = 0.03;
        this.nextCellSize = 0.03;

        // Dynamic Filters
        this.minDepth = 0.1;
        this.maxDepth = 5.0;

        // ... existing ...
        this.totalPointsFused = 0;

        // Visualization - Gaussian Splat Shader
        const vertexShader = `
            attribute float size;
            attribute float intensity;
            varying float vIntensity;
            varying vec3 vColor;
            
            void main() {
                vIntensity = intensity;
                vColor = color;
                
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                
                // Scale point size by distance to look like a surface
                // size attribute is world space radius (approx)
                // gl_PointSize = (size / -mvPosition.z) * 500.0; // Basic attenuation
                
                // Better fit: Size * Projection Scale
                gl_PointSize = (size * 3000.0) / length(mvPosition.xyz); 
                
                // Clamp max size to avoid giant blobs near camera
                gl_PointSize = clamp(gl_PointSize, 2.0, 100.0);
                
                gl_Position = projectionMatrix * mvPosition;
            }
        `;

        const fragmentShader = `
            varying float vIntensity;
            varying vec3 vColor;
            
            void main() {
                // Circular gaussian falloff
                vec2 center = gl_PointCoord - 0.5;
                float distSq = dot(center, center);
                float alpha = exp(-distSq * 9.0); // 9.0 makes it fall off near edges (3 sigma)
                
                if (alpha < 0.05) discard;
                
                // Color + Intensity modulation
                gl_FragColor = vec4(vColor, alpha * 0.8 * vIntensity); 
                // 0.8 base opacity
            }
        `;

        this.material = new THREE.ShaderMaterial({
            uniforms: {},
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            transparent: true,
            vertexColors: true,
            // Additive blending looks cool but might be too ghost-like for surfaces. 
            // Normal blending is better for solidity.
            blending: THREE.NormalBlending,
            depthWrite: false, // Turn off depth write for smooth transparent sorting? 
            // Actually, for "Surface" scanning, we want depth test. 
            // Turning off depth write kills occlusion.
            // But sorting thousands of points is slow.
            // Let's try DepthWrite=True (unsorted) -> might have artifacts but faster.
            // Or DepthWrite=False (unsorted) -> looks like a cloud.
            depthTest: true,
            depthWrite: false
        });

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
        // Adaptive skip based on load? Fixed for now.
        const skip = 4;

        const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
        const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

        const vPoint = new THREE.Vector3();
        const vDir = new THREE.Vector3();

        let pointsFused = 0;

        for (let y = 0; y < height; y += skip) {
            for (let x = 0; x < width; x += skip) {
                if (x >= width || y >= height) continue;

                let d;
                try {
                    d = depthInfo.getDepthInMeters(x, y);
                } catch (e) { continue; }

                // Dynamic Filter Range
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
                if (vDir.z >= 0) continue;

                const scale = -d / vDir.z;
                vPoint.copy(vDir).multiplyScalar(scale);
                vPoint.applyMatrix4(camera.matrixWorld);

                // Sample Color if available
                let r = 255, g = 255, b = 255;
                if (colorData) {
                    // Map xNorm/yNorm (Screen Space) to Color Image Space
                    // Depth and Camera Image usually align in Viewport space for AR
                    const cx = Math.floor(xNorm * colorData.width);
                    const cy = Math.floor((1.0 - yNorm) * colorData.height); // Flip Y? Usually WebGL textures are flipped relative to depth buffer logic sometimes.
                    // Let's assume 1-yNorm for standard UV. 

                    const idx = (cy * colorData.width + cx) * 4;
                    if (idx >= 0 && idx < colorData.data.length) {
                        r = colorData.data[idx];
                        g = colorData.data[idx + 1];
                        b = colorData.data[idx + 2];
                    }
                }

                this.fusePoint(vPoint, camPos, r, g, b);
                pointsFused++;
            }
        }

        // Throttle updates
        this.framesSinceRebuild++;
        if (this.framesSinceRebuild > this.rebuildInterval) {
            this.rebuildPointCloud();
            this.framesSinceRebuild = 0;
        }
    }

    fusePoint(worldPt, camPos, r, g, b) {
        // Use CURRENT cellSize (allows dynamic change if cleared)
        const cell = this.cellSize;
        const ix = Math.floor(worldPt.x / cell);
        const iy = Math.floor(worldPt.y / cell);
        const iz = Math.floor(worldPt.z / cell);
        const key = `${ix},${iy},${iz}`;

        let voxel = this.voxels.get(key);
        if (!voxel) {
            voxel = {
                x: worldPt.x,
                y: worldPt.y,
                z: worldPt.z,
                count: 1,
                r: r, g: g, b: b,
                ix: ix, iy: iy, iz: iz
            };
            this.voxels.set(key, voxel);
        } else {
            const c = voxel.count;
            const nc = c + 1;
            // Simple running average
            voxel.x = (voxel.x * c + worldPt.x) / nc;
            voxel.y = (voxel.y * c + worldPt.y) / nc;
            voxel.z = (voxel.z * c + worldPt.z) / nc;

            // Average Color
            voxel.r = (voxel.r * c + r) / nc;
            voxel.g = (voxel.g * c + g) / nc;
            voxel.b = (voxel.b * c + b) / nc;

            voxel.count = nc;
        }
    }

    rebuildPointCloud() {
        const vertices = [];
        const colors = [];
        const sizes = [];
        const intensities = [];

        let accepted = 0;

        const minC = this.minCount; // Dynamic param

        for (const v of this.voxels.values()) {
            if (v.count < minC) continue;

            // Optional ROR check removed for speed/simplicity with splats
            // Splats handle sparse noise better visually (faint blobs)

            vertices.push(v.x, v.y, v.z);

            // Use accumulated color
            colors.push(v.r / 255.0, v.g / 255.0, v.b / 255.0);

            // Size: 2 * cellSize (overlap)
            sizes.push(this.cellSize * 1.5);

            // Intensity: Based on confidence
            const conf = Math.min(1.0, v.count / 20.0); // 20 frames = full opacity
            intensities.push(0.5 + 0.5 * conf);

            accepted++;
        }

        if (accepted === 0) return;

        if (!this.pointCloud) {
            this.geometry = new THREE.BufferGeometry();
            this.pointCloud = new THREE.Points(this.geometry, this.material);
            this.pointCloud.isARMesh = true;
            this.scene.add(this.pointCloud);
        }

        const posAttr = new THREE.Float32BufferAttribute(vertices, 3);
        const colAttr = new THREE.Float32BufferAttribute(colors, 3);
        const sizeAttr = new THREE.Float32BufferAttribute(sizes, 1);
        const intAttr = new THREE.Float32BufferAttribute(intensities, 1);

        this.geometry.setAttribute('position', posAttr);
        this.geometry.setAttribute('color', colAttr);
        this.geometry.setAttribute('size', sizeAttr);
        this.geometry.setAttribute('intensity', intAttr);

        this.geometry.computeBoundingSphere();
        // Since we are writing directly, we might need to toggle needsUpdate if re-using buffers
        // But here we recreate attributes which sets needsUpdate automatically.
    }
}
