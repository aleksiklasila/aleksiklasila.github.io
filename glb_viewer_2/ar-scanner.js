import * as THREE from 'three';

/**
 * ARScanner - A custom geometry scanner that builds a visual representation
 * of the environment by accumulating WebXR hit-test results over time.
 */
export class ARScanner {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.group.visible = false;

        this.splatSize = 0.15; // 15cm grid tiles
        this.minDistanceSq = 0.08 * 0.08; // Only place new splat if 8cm away from others
        this.splats = [];

        // Geometry for the splat (a wireframe square)
        const planeGeo = new THREE.PlaneGeometry(this.splatSize, this.splatSize);
        planeGeo.rotateX(-Math.PI / 2); // Rotate so its normal is +Y (up) natively
        this.geometry = new THREE.EdgesGeometry(planeGeo);

        this.material = new THREE.LineBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.8,
            depthTest: true
        });
    }

    /**
     * Call this when a hit test result is available.
     * @param {Float32Array} hitPoseMatrix - The transform matrix from the WebXR hit pose.
     */
    addHit(hitPoseMatrix) {
        const matrix = new THREE.Matrix4().fromArray(hitPoseMatrix);
        const pos = new THREE.Vector3().setFromMatrixPosition(matrix);

        // Check distance to existing splats to avoid overlapping excessively
        for (const splat of this.splats) {
            if (splat.position.distanceToSquared(pos) < this.minDistanceSq) {
                return; // Already covered
            }
        }

        // Add splat
        const mesh = new THREE.LineSegments(this.geometry, this.material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(matrix);

        this.group.add(mesh);
        this.splats.push({ position: pos });
    }

    setVisible(visible) {
        this.group.visible = visible;
    }

    reset() {
        while (this.group.children.length > 0) {
            this.group.remove(this.group.children[0]);
        }
        this.splats = [];
    }
}
